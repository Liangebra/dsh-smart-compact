/**
 * Durable region transactions and the log-rebuilt block ledger — the engine's
 * only persistent mechanism. Every compression is a standard compaction
 * bracket (`compaction/start → summary → user/message(replace) → end`) in the
 * append-only session log; originals are never deleted. No kernel, no side
 * state, no files: everything a consumer needs is rebuilt from the log.
 * @module dsh-smart-compact/region
 */

import { randomUUID } from 'node:crypto'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/types'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { extractEventText, extractText } from './messages.ts'
import { countTokens } from './tokens.ts'

/** One durable block as rebuilt from `compaction/summary` events. */
export interface BlockLedgerEntry {
  /** The compaction transaction id (stable block identity). */
  readonly blockId: string
  readonly summary: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly start: number
  readonly end: number
  readonly createdAt: number
  readonly summaryTokens: number
  readonly estimatedNetTokens: number
}

/** One self-computed compressible span of the current surface. */
export interface SeqCompressibleRange {
  readonly start: number
  readonly end: number
  readonly count: number
  readonly tokens: number
}

export interface CompactionTransactionInput {
  readonly start: number
  readonly end: number
  readonly shadowedSeqs: readonly number[]
  readonly summary: ContentBlock[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  readonly sourceCommandId?: CommandId
  /** True when the summary came from one direct ctx.llm.stream call. */
  readonly llmStreamCall?: boolean
  /** The complete output content blocks produced by that call. */
  readonly rawOutput?: ContentBlock[]
}

/** The seqs of the surface nodes in the inclusive positional span. */
export function shadowedSeqsOf(session: Session, start: number, end: number): SessionSeq[] {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(SessionSeq(start))
  const endIdx = nodes.indexOf(SessionSeq(end))
  if (startIdx < 0 || endIdx < 0) return []
  return nodes.slice(startIdx, endIdx + 1)
}

/** An opened durable bracket: `compaction/start` is already in the log. */
export interface OpenBracket {
  readonly compactionId: CompactionId
  readonly startSeq: SessionSeq
  readonly turn: number | null
}

/** Append `compaction/start` — the durable lock — BEFORE any summarization work. */
export function beginCompaction(
  session: Session,
  sourceCommandId?: CommandId,
): OpenBracket {
  const turn = findOpenTurn(session.snapshotEvents())
  const compactionId = CompactionId(randomUUID())
  const event = session.append('compaction/start', {
    compactionId,
    turn,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  })
  return { compactionId, startSeq: event.seq, turn }
}

/** Complete an open bracket: summary + replace + end. Returns all 4 seqs. */
export function completeCompaction(
  session: Session,
  bracket: OpenBracket,
  input: CompactionTransactionInput,
): { compactionId: CompactionId; seqs: SessionSeq[] } {
  const seqs: SessionSeq[] = [bracket.startSeq]
  const summaryBase = {
    compactionId: bracket.compactionId,
    summary: input.summary,
    shadowedRange: { start: SessionSeq(input.start), end: SessionSeq(input.end) },
    shadowedSeqs: input.shadowedSeqs.map(SessionSeq),
    shadowedTokenCount: input.shadowedTokenCount,
    provider: input.provider,
    model: input.model,
    ...(input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId }),
  }
  seqs.push(session.append('compaction/summary', input.llmStreamCall === true
    ? { ...summaryBase, llmStreamCall: true as const, rawOutput: input.rawOutput ?? input.summary }
    : summaryBase).seq)

  const message = createUserMessage({
    content: input.summary,
    source: compactCheckpointSource(bracket.compactionId, input.sourceCommandId),
  })
  seqs.push(session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(input.start), endSeq: SessionSeq(input.end) },
    sourceEventSeqs: [bracket.startSeq, seqs[1]!, ...input.shadowedSeqs.map(SessionSeq)],
  }).seq)

  seqs.push(session.append('compaction/end', {
    compactionId: bracket.compactionId,
    turn: bracket.turn,
    ...(input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId }),
  }).seq)
  return { compactionId: bracket.compactionId, seqs }
}

/** Release an open bracket on failure so the durable lock never dangles. */
export function abortCompaction(session: Session, bracket: OpenBracket, error?: string): void {
  session.append('compaction/end', {
    compactionId: bracket.compactionId,
    turn: bracket.turn,
    error,
  })
}

/** Convenience wrapper: begin + complete in one call (synchronous model path). */
export function runCompactionTransaction(
  session: Session,
  input: CompactionTransactionInput,
): { compactionId: CompactionId; seqs: SessionSeq[] } {
  const bracket = beginCompaction(session, input.sourceCommandId)
  return completeCompaction(session, bracket, input)
}

/** Whether a surface user message is a compaction checkpoint node. */
export function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { plugin?: string } }).source
  return source?.plugin === 'compact' || (source as { kind?: string } | undefined)?.kind === 'compact-checkpoint'
}

/** Rebuild the block ledger from the log (authoritative, kernel-free). */
export function rebuildBlockLedger(events: readonly SessionEvent[]): BlockLedgerEntry[] {
  const ledger: BlockLedgerEntry[] = []
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    const data = event.data as {
      compactionId?: string
      summary?: ContentBlock[]
      shadowedRange?: { start?: number; end?: number }
      shadowedSeqs?: number[]
      shadowedTokenCount?: number
    }
    if (typeof data.compactionId !== 'string') continue
    let shadowedTokenCount = data.shadowedTokenCount ?? 0
    const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
    // Backfill 0/legacy counts from the shadowed originals still in the log.
    if (shadowedTokenCount === 0) {
      for (const seq of shadowedSeqs) {
        const original = events[seq]
        if (original !== undefined) shadowedTokenCount += countTokens(extractEventText(original))
      }
    }
    const summary = extractText(Array.isArray(data.summary) ? data.summary : [])
    const summaryTokens = countTokens(summary)
    ledger.push({
      blockId: data.compactionId,
      summary,
      summaryTokens,
      estimatedNetTokens: shadowedTokenCount - summaryTokens,
      shadowedSeqs,
      shadowedTokenCount,
      start: data.shadowedRange?.start ?? 0,
      end: data.shadowedRange?.end ?? 0,
      createdAt: event.time,
    })
  }
  return ledger
}

function findOpenTurn(events: readonly SessionEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return (event.data as { turn?: number }).turn ?? null
  }
  return null
}

/** Nearest live surface node to a requested seq (for stale-edge snapping). */
function nearestNode(session: Session, seq: number): number | undefined {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return undefined
  let best = nodes[0]!
  let bestDist = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    const dist = Math.abs(node - seq)
    if (dist < bestDist) {
      bestDist = dist
      best = node
    }
  }
  return best
}

/**
 * Resolve a requested surface span to a tool-pairing-balanced range: snap
 * stale edges to the nearest live node, shrink inward to clean cuts, and if
 * that collapses, expand outward to the smallest balanced enclosing pair.
 */
export function resolveSurfaceRange(session: Session, start: number, end: number): { start: number; end: number } {
  const nodes = session.surface.nodes
  let s = start
  let e = end
  if (nodes.indexOf(SessionSeq(s)) < 0) s = nearestNode(session, s) ?? s
  if (nodes.indexOf(SessionSeq(e)) < 0) e = nearestNode(session, e) ?? e
  let startIdx = nodes.indexOf(SessionSeq(s))
  let endIdx = nodes.indexOf(SessionSeq(e))
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(`dsh-smart-compact: seq ${start}..${end} not in the current surface — consult dcp_status`)
  }
  if (startIdx > endIdx) throw new Error(`dsh-smart-compact: reversed range ${start}..${end}`)

  const cleanBefore = (index: number): boolean => toolPairingBalancedBefore(session, nodes[index]!)
  const cleanAfter = (index: number): boolean => toolPairingBalancedAfter(session, nodes[index]!)

  // Pass 1: shrink inward to the nearest clean cuts.
  while (startIdx <= endIdx && !cleanBefore(startIdx)) startIdx += 1
  while (endIdx >= startIdx && !cleanAfter(endIdx)) endIdx -= 1
  if (startIdx <= endIdx) {
    return { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }

  // Pass 2: expand outward from the requested span to the smallest clean pair.
  startIdx = nodes.indexOf(SessionSeq(s))
  endIdx = nodes.indexOf(SessionSeq(e))
  while (startIdx > 0 && !cleanBefore(startIdx)) startIdx -= 1
  while (endIdx < nodes.length - 1 && !cleanAfter(endIdx)) endIdx += 1
  if (cleanBefore(startIdx) && cleanAfter(endIdx)) {
    return { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }
  throw new Error(`dsh-smart-compact: no tool-pairing-balanced range around ${start}..${end} — narrow the range`)
}

/**
 * Compressible spans computed directly from the surface: skips the protected
 * recent tail, the last user message, compaction checkpoints, protected tool
 * pairs, and (optionally) every user message; edges are balanced through
 * resolveSurfaceRange. Sorted by reclaimed tokens (largest first).
 */
export function buildCompressibleSeqRanges(
  session: Session,
  opts: {
    preserveRecent?: number
    /** Tool names whose call/result pairs are never compressible. */
    protectedToolNames?: readonly string[]
    /** Keep every user message verbatim. */
    protectUserMessages?: boolean
  } = {},
): SeqCompressibleRange[] {
  const nodes = session.surface.nodes
  const protectedSeqs = protectedSurfaceSeqs(session, opts)
  const protectUserMessages = opts.protectUserMessages === true
  const raw: SeqCompressibleRange[] = []
  let cur: SeqCompressibleRange | null = null
  const flush = (): void => {
    if (cur !== null) raw.push(cur)
    cur = null
  }
  for (const seq of nodes) {
    const event = session.snapshotEvents()[seq]
    const isUser = event?.type === 'user/message' && !isCheckpointNode(event)
    if (event === undefined || protectedSeqs.has(seq) || isCheckpointNode(event) || (protectUserMessages && isUser)) {
      flush()
      continue
    }
    const tokens = countTokens(extractEventText(event))
    if (cur === null) {
      cur = { start: seq, end: seq, count: 1, tokens }
    } else {
      cur = { start: cur.start, end: seq, count: cur.count + 1, tokens: cur.tokens + tokens }
    }
  }
  flush()
  const out: SeqCompressibleRange[] = []
  for (const range of raw) {
    try {
      const { start, end } = resolveSurfaceRange(session, range.start, range.end)
      const selected = shadowedSeqsOf(session, start, end)
      const original = new Set(shadowedSeqsOf(session, range.start, range.end))
      if (selected.some(seq => !original.has(seq))) continue
      const tokens = selected.reduce((sum, seq) => sum + countTokens(extractEventText(session.snapshotEvents()[seq]!)), 0)
      out.push({ start, end, count: selected.length, tokens })
    } catch {
      // Cannot be balanced into a compressible span — skip.
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

/** Shared retention rules for automatic and model-directed compression. */
export function protectedSurfaceSeqs(session: Session, opts: { preserveRecent?: number; protectedToolNames?: readonly string[]; protectUserMessages?: boolean } = {}): Set<number> {
  const nodes = session.surface.nodes
  const preserve = opts.preserveRecent ?? 5
  const protectedToolNames = new Set(opts.protectedToolNames ?? [])
  const protectUserMessages = opts.protectUserMessages === true
  const protectedSeqs = new Set<number>()
  for (const seq of preserve > 0 ? nodes.slice(-preserve) : []) protectedSeqs.add(seq)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.snapshotEvents()[nodes[index]!]
    if (event?.type === 'user/message' && !isCheckpointNode(event)) {
      protectedSeqs.add(nodes[index]!)
      break
    }
  }
  // Protect named tool pairs: the call node and every paired result node.
  if (protectedToolNames.size > 0) {
    const callIds = new Set<string>()
    for (const seq of nodes) {
      const event = session.snapshotEvents()[seq]
      if (event?.type !== 'assistant/message') continue
      const content = (event.data as { message?: { content?: ReadonlyArray<{ type?: string; name?: string; id?: string }> } })
        .message?.content
      for (const block of content ?? []) {
        if (block.type === 'tool-call' && block.name !== undefined && protectedToolNames.has(block.name)) {
          protectedSeqs.add(seq)
          if (block.id !== undefined) callIds.add(block.id)
        }
      }
    }
    if (callIds.size > 0) {
      for (const seq of nodes) {
        const event = session.snapshotEvents()[seq]
        if (event?.type !== 'tool/result') continue
        const message = (event.data as { message?: { callId?: string; source?: { callId?: string } } }).message
        const callId = message?.callId ?? message?.source?.callId
        if (callId !== undefined && callIds.has(callId)) protectedSeqs.add(seq)
      }
    }
  }
  for (const seq of nodes) {
    const event = session.snapshotEvents()[seq]
    if (event === undefined || isCheckpointNode(event) || (protectUserMessages && event.type === 'user/message')) protectedSeqs.add(seq)
  }
  return protectedSeqs
}
