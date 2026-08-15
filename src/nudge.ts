/**
 * Threshold / mandatory nudges: the engine's only "voice". At the threshold
 * line it advises; at the mandatory line it demands and warns that the engine
 * will auto-compact the oldest range if the model does not act. The full
 * guidance lives in the system-prompt section once; nudges stay short and
 * carry the live compressible range table.
 * @module dsh-smart-compact/nudge
 */

import type { SeqCompressibleRange } from './region.ts'
import type { DcpSuggestion } from './dcp.ts'

export interface NudgeInput {
  readonly ratio: number
  readonly thresholdRatio: number
  readonly mandatoryRatio: number
  readonly ranges: readonly SeqCompressibleRange[]
  readonly suggestions: readonly DcpSuggestion[]
}

export function buildNudgeText(input: NudgeInput): string {
  const percent = Math.round(input.ratio * 100)
  const mandatory = input.ratio >= input.mandatoryRatio
  const lines: string[] = []
  if (mandatory) {
    lines.push(
      `[context usage ${percent}% — MANDATORY: compress now with the compress tool. ` +
      'Pick the ranges below (or your own) and write one dense technical summary per range. ' +
      'If you do not compress, the engine will auto-compact the oldest range for you. ' +
      'Original content is never deleted — decompress/status can always recover it.]',
    )
  } else {
    lines.push(
      `[context usage ${percent}% — consider compressing with the compress tool. ` +
      'You decide whether and what to compress; nothing is forced at this level.]',
    )
  }
  lines.push('Compressible ranges (surface seqs):')
  if (input.ranges.length === 0) {
    lines.push('  (none — nothing outside the protected recent tail is compressible)')
  } else {
    for (const range of input.ranges) {
      lines.push(`  seqs ${range.start}..${range.end} (~${range.tokens} tokens, ${range.count} node(s))`)
    }
  }
  if (input.suggestions.length > 0) {
    lines.push('Additional DCP suggestions (dedup / errored-call cleanup):')
    for (const suggestion of input.suggestions) {
      lines.push(`  seqs ${suggestion.start}..${suggestion.end} — ${suggestion.kind}: ${suggestion.reason}`)
    }
  }
  return lines.join('\n')
}
