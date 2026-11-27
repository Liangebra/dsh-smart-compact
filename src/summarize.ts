/**
 * Engine-written summarization: a direct `ctx.llm.stream` call that condenses
 * one surface span using the configurable prompt. Used by `/compact`
 * (compactNow), the mandatory fallback, and the overflow safety net. The
 * original events stay in the log; only the summary text is produced here.
 * @module dsh-smart-compact/summarize
 */

import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { extractEventText } from './messages.ts'
import { buildSummaryPrompt } from './prompt.ts'
import { shadowedSeqsOf } from './region.ts'

export interface SummarizeRangeOptions {
  readonly prompt: string
  readonly maxTokens: number
  readonly provider: string
  readonly model: string
  readonly signal?: AbortSignal
}

/** Minimal structural type for the LLM runtime the engine consumes. */
export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Condense the inclusive span [start, end] into summary text. */
export async function summarizeRange(
  llm: LlmLike,
  session: Session,
  start: number,
  end: number,
  options: SummarizeRangeOptions,
): Promise<string> {
  const seqs = shadowedSeqsOf(session, start, end)
  const parts: string[] = []
  for (const seq of seqs) {
    const event = session.snapshotEvents()[seq]
    if (event === undefined) continue
    parts.push(`[${event.type} seq ${seq}]\n${extractEventText(event)}`)
  }
  const messages = [createUserMessage({
    content: [{ type: 'text', text: buildSummaryPrompt(options.prompt, parts.join('\n\n')) }],
    source: { kind: 'user' },
  })]
  let text = ''
  let current = ''
  for await (const chunk of llm.stream({
    provider: options.provider,
    model: options.model,
    messages,
    maxTokens: options.maxTokens,
    signal: options.signal,
  })) {
    if (chunk.type === 'text-delta') current += chunk.text
    else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      text += chunk.block.text
      current = ''
    }
  }
  const trimmed = (text + current).trim()
  if (trimmed.length === 0) throw new Error('dsh-smart-compact: summarization produced no text')
  return trimmed
}
