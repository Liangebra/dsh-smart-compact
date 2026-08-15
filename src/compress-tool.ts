/**
 * Model-facing tools: `compress` (range / message modes, model-written
 * summaries) and `dcp_status` (pressure, compressible ranges, DCP
 * suggestions, block ledger). The engine stays the single authority for
 * durable transactions; tools call back into it.
 * @module dsh-smart-compact/compress-tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SmartCompactConfig } from './config.ts'
import {
  buildCompressibleSeqRanges,
  rebuildBlockLedger,
  resolveSurfaceRange,
  shadowedSeqsOf,
  runCompactionTransaction,
} from './region.ts'
import { countTokens } from './tokens.ts'
import { extractEventText } from './messages.ts'
import { dedupSuggestions, purgeSuggestions } from './dcp.ts'

/** The minimal agent surface the tools read (session + route options). */
export interface SessionAgent {
  session: import('@deepseek-ai/dsh-session').Session
  options: { provider?: string; model?: string }
}

export interface CompressEnv {
  readonly config: SmartCompactConfig
  /** Engine-owned durable compression of one balanced span with a model-written summary. */
  readonly compressRange: (agent: SessionAgent, start: number, end: number, summary: string) => Promise<string>
  readonly windowFor: (agent: SessionAgent) => Promise<number>
  readonly measureRatio: (agent: SessionAgent) => Promise<number>
}

interface RangeEntry {
  startSeq: number
  endSeq: number
  summary: string
}

function requireAgent(exec: { agent?: SessionAgent }): SessionAgent {
  if (exec.agent === undefined) throw new Error('compress requires an owning agent session')
  return exec.agent
}

export function makeTools(env: CompressEnv): ToolDefinition[] {
  const compress = defineTool({
    name: 'compress',
    description:
      'Compress conversation content into a dense technical summary, reclaiming context. ' +
      'mode "range" compresses contiguous spans (seqs start..end); mode "message" compresses individual messages ' +
      '(seq). Write ONE complete technical summary per entry: preserve exact paths, commands, errors, identifiers, ' +
      'decisions and pending work; discard spent detail. Original content is never deleted and stays recoverable.',
    parameters: {
      mode: { type: 'string', enum: ['range', 'message'], required: true, description: 'range compresses spans; message compresses single messages' },
      ranges: {
        type: 'array',
        description: 'Required for mode "range": spans to compress, each with its own summary.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            startSeq: { type: 'number', required: true, description: 'First surface seq of the span' },
            endSeq: { type: 'number', required: true, description: 'Last surface seq of the span' },
            summary: { type: 'string', required: true, description: 'Dense technical summary replacing the span' },
          },
        },
      },
      messages: {
        type: 'array',
        description: 'Required for mode "message": individual messages to compress.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seq: { type: 'number', required: true, description: 'Surface seq of the message' },
            summary: { type: 'string', required: true, description: 'Dense technical summary replacing the message' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const entries: RangeEntry[] = []
      if (args.mode === 'range') {
        for (const range of args.ranges ?? []) entries.push(range)
      } else {
        for (const message of args.messages ?? []) {
          entries.push({ startSeq: message.seq, endSeq: message.seq, summary: message.summary })
        }
      }
      if (entries.length === 0) return 'compress: no entries provided'
      const lines: string[] = []
      for (const entry of entries) {
        const summary = entry.summary.trim()
        if (summary.length === 0) {
          lines.push(`  seqs ${entry.startSeq}..${entry.endSeq}: skipped — empty summary`)
          continue
        }
        try {
          const result = await env.compressRange(agent, entry.startSeq, entry.endSeq, summary)
          lines.push(result)
        } catch (error) {
          lines.push(`  seqs ${entry.startSeq}..${entry.endSeq}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return lines.join('\n')
    },
  })

  const status = defineTool({
    name: 'dcp_status',
    description:
      'Context usage, compressible ranges (surface seqs), DCP dedup/purge suggestions, and the compaction block ledger.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      const ratio = await env.measureRatio(agent)
      const ranges = buildCompressibleSeqRanges(session, {
        preserveRecent: env.config.preserveRecent,
        protectedToolNames: env.config.protectedTools,
        protectUserMessages: env.config.protectUserMessages,
      })
      const suggestions = [
        ...(env.config.dedupEnabled ? dedupSuggestions(session) : []),
        ...purgeSuggestions(session, env.config.purgeErroredTurns),
      ]
      const blocks = rebuildBlockLedger(session.events)
      const lines: string[] = [
        `context usage: ${Math.round(ratio * 100)}% (threshold ${Math.round(env.config.thresholdRatio * 100)}%, mandatory ${Math.round(env.config.mandatoryRatio * 100)}%)`,
        `surface nodes: ${session.surface.nodes.length}, blocks: ${blocks.length}`,
      ]
      lines.push('compressible ranges:')
      for (const range of ranges) lines.push(`  seqs ${range.start}..${range.end} (~${range.tokens} tokens)`)
      if (suggestions.length > 0) {
        lines.push('DCP suggestions:')
        for (const suggestion of suggestions) {
          lines.push(`  seqs ${suggestion.start}..${suggestion.end} — ${suggestion.kind}: ${suggestion.reason}`)
        }
      }
      if (blocks.length > 0) {
        lines.push('blocks:')
        for (const block of blocks) {
          lines.push(
            `  ${block.blockId.slice(0, 8)} seqs ${block.start}..${block.end} (~${block.shadowedTokenCount} tokens reclaimed)`,
          )
        }
      }
      return lines.join('\n')
    },
  })

  return [compress, status]
}
