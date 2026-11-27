/**
 * DCP-inspired suggestions: deduplicate repeated tool calls (same tool +
 * same arguments keep only the latest output) and purge the large inputs of
 * errored tool calls after a configurable number of turns. These produce
 * extra compressible spans merged into the range table shown to the model —
 * the engine never compacts them silently, so nothing is lost without a
 * decision.
 * @module dsh-smart-compact/dcp
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { extractText } from './messages.ts'
import { resolveSurfaceRange } from './region.ts'

export interface DcpSuggestion {
  readonly kind: 'dedup' | 'purge'
  readonly start: number
  readonly end: number
  readonly reason: string
}

interface CallInfo {
  readonly seq: number
  readonly callId: string
  readonly name: string
  readonly args: string
}

/** Tool-call blocks of an assistant message event. */
function toolCallsOf(session: Session, seq: number): CallInfo[] {
  const event = session.events[seq]
  if (event?.type !== 'assistant/message') return []
  const content = (event.data as { message?: { content?: unknown[] } }).message?.content ?? []
  const out: CallInfo[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: string; id?: string; name?: string; arguments?: unknown }
    if (b.type !== 'tool-call' || typeof b.id !== 'string') continue
    out.push({
      seq,
      callId: b.id,
      name: b.name ?? '',
      args: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? ''),
    })
  }
  return out
}

/** The tool/result seq matching a callId (callId lives on message.source.callId). */
function resultSeqFor(session: Session, callId: string, afterSeq: number): number | undefined {
  const nodes = session.surface.nodes
  const index = nodes.indexOf(afterSeq)
  if (index < 0) return undefined
  for (const seq of nodes.slice(index + 1)) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    const message = (event.data as { message?: { callId?: string; source?: { callId?: string } } }).message
    const candidate = message?.callId ?? message?.source?.callId
    if (candidate === callId) return seq
  }
  return undefined
}

/** Whether a tool/result event carries an error marker. */
function isErrored(session: Session, seq: number): boolean {
  const event = session.events[seq]
  if (event?.type !== 'tool/result') return false
  const data = event.data as { isError?: boolean; message?: { content?: unknown } }
  if (data.isError === true) return true
  const text = extractText(data.message?.content).toLowerCase()
  return /error|failed|exception|traceback|exit code|stderr/i.test(text)
}

/** Turn number of a surface event (0 when unknown). */
function turnOf(session: Session, seq: number): number {
  return (session.events[seq]?.data as { turn?: number } | undefined)?.turn ?? 0
}

/** Most recent turn number across the whole log (turn/start events). */
export function latestTurn(session: Session): number {
  let max = 0
  for (const event of session.events) {
    if (event.type !== 'turn/start') continue
    const turn = (event.data as { turn?: number }).turn ?? 0
    if (turn > max) max = turn
  }
  return max
}

/**
 * Suggest compressing older duplicates of repeated tool calls. For each
 * (tool, args) group the newest call is kept; each older call's
 * [assistant, result] span becomes a dedup suggestion (when it can be
 * balanced).
 */
export function dedupSuggestions(session: Session): DcpSuggestion[] {
  const groups = new Map<string, CallInfo[]>()
  for (const seq of session.surface.nodes) {
    for (const call of toolCallsOf(session, seq)) {
      const key = `${call.name}\u0000${call.args}`
      const list = groups.get(key) ?? []
      list.push(call)
      groups.set(key, list)
    }
  }
  const out: DcpSuggestion[] = []
  for (const calls of groups.values()) {
    if (calls.length < 2) continue
    // Keep the newest; suggest each older one.
    const newest = calls[calls.length - 1]!
    const newestResult = resultSeqFor(session, newest.callId, newest.seq)
    if (newestResult === undefined || isErrored(session, newestResult)) continue
    const newestText = extractText((session.events[newestResult]?.data as { message?: { content?: unknown } })?.message?.content)
    if (!newestText) continue
    for (const call of calls) {
      if (call === newest) continue
      const resultSeq = resultSeqFor(session, call.callId, call.seq)
      if (resultSeq === undefined || isErrored(session, resultSeq)) continue
      const oldText = extractText((session.events[resultSeq]?.data as { message?: { content?: unknown } })?.message?.content)
      if (oldText !== newestText) continue
      try {
        const { start, end } = resolveSurfaceRange(session, call.seq, resultSeq)
        out.push({
          kind: 'dedup',
          start,
          end,
          reason: `duplicate tool call ${call.name} (same arguments and text output) — the latest output is kept verbatim`,
        })
      } catch {
        // Cannot be balanced — skip.
      }
    }
  }
  return out
}

/**
 * Suggest purging the large inputs of errored tool calls older than
 * `turns` turns. The error message stays; only the potentially large input
 * span is reclaimed (kept as a suggestion, never forced).
 */
export function purgeSuggestions(session: Session, turns: number): DcpSuggestion[] {
  if (turns <= 0) return []
  const current = latestTurn(session)
  const out: DcpSuggestion[] = []
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    if (current - turnOf(session, seq) < turns) continue
    if (!isErrored(session, seq)) continue
    const message = (event.data as { message?: { callId?: string; source?: { callId?: string } } }).message
    const callId = message?.callId ?? message?.source?.callId
    if (callId === undefined) continue
    // Find the assistant call before this result.
    let callSeq: number | undefined
    for (const node of session.surface.nodes) {
      if (node === seq) break
      for (const call of toolCallsOf(session, node)) {
        if (call.callId === callId) callSeq = node
      }
    }
    if (callSeq === undefined) continue
    try {
      const { start, end } = resolveSurfaceRange(session, callSeq, seq)
      out.push({
        kind: 'purge',
        start,
        end,
        reason: `errored tool call (${turns}+ turns old) — summarize the error and large input together`,
      })
    } catch {
      // Cannot be balanced — skip.
    }
  }
  return out
}
