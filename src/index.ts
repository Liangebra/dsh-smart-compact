/**
 * dsh-smart-compact — a custom CompactionEngine backend with configurable
 * threshold prompting, a mandatory auto-compaction fallback, DCP-inspired
 * dedup/purge suggestions, a fully configurable summary prompt, and
 * `/compact` that keeps the original engine-driven behavior.
 *
 * Zero external state: no kernel, no ledger files, no in-memory state machine
 * that must stay in sync. Every compression is a standard durable bracket in
 * the append-only session log; block info is rebuilt from the log on demand,
 * and originals are never deleted.
 *
 * Mount it wherever a compaction backend is expected (one per realm):
 *
 * ```yaml
 * - id: compaction-smart
 *   name: 'dsh-smart-compact'
 *   config:
 *     thresholdRatio: 0.5
 *     mandatoryRatio: 0.9
 * ```
 * @module dsh-smart-compact
 */

import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  type ManualCompactionErrorCode,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveConfig, type SmartCompactConfig } from './config.ts'
import { DEFAULT_SUMMARY_PROMPT, buildSummaryPrompt } from './prompt.ts'
import { summarizeRange, type LlmLike } from './summarize.ts'
import {
  abortCompaction,
  beginCompaction,
  buildCompressibleSeqRanges,
  completeCompaction,
  protectedSurfaceSeqs,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from './region.ts'
import { countTokens } from './tokens.ts'
import { extractEventText } from './messages.ts'
import { dedupSuggestions, latestTurn, purgeSuggestions } from './dcp.ts'
import { buildNudgeText } from './nudge.ts'
import { makeTools } from './compress-tool.ts'

const DEFAULT_WINDOW = 128000

/** The minimal agent surface the engine reads: session + route options. */
interface SessionAgent {
  session: import('@deepseek-ai/dsh-session').Session
  options: { provider?: string; model?: string }
}

const SYSTEM_PROMPT_SECTION = `## Context management (dsh-smart-compact)
- When context usage reaches the threshold, a short advisory nudge appears. You decide whether to compress with the \`compress\` tool: mode "range" for contiguous spans (surface seqs start..end), mode "message" for single messages. Write ONE dense technical summary per entry — preserve exact paths, commands, error strings, identifiers, decisions, and pending work; discard spent detail.
- At the mandatory level you MUST compress. If you do not, the engine auto-compacts the oldest range for you.
- Compressed content is never deleted: \`dcp_status\` shows usage, compressible ranges, DCP suggestions, and blocks; originals stay recoverable in the session log.`

export class SmartCompactEngine extends CompactionEngine {
  readonly config: SmartCompactConfig
  private readonly engineCtx: Context
  private readonly windowCache = new Map<string, number>()
  /** Runtime-only cadence guard so the mandatory fallback acts once per turn. */
  private readonly lastAutoCompactTurn = new Map<string, number>()
  /** Runtime-only cadence guard so the threshold nudge appears once per turn. */
  private readonly lastNudgeTurn = new Map<string, number>()

  private rangeOpts(): { preserveRecent: number; protectedToolNames: readonly string[]; protectUserMessages: boolean } {
    return {
      preserveRecent: this.config.preserveRecent,
      protectedToolNames: this.config.protectedTools,
      protectUserMessages: this.config.protectUserMessages,
    }
  }

  constructor(ctx: Context, config: Partial<SmartCompactConfig> = {}) {
    super(ctx)
    this.engineCtx = ctx
    this.config = resolveConfig(config)

    const env = {
      config: this.config,
      compressRange: (agent: SessionAgent, start: number, end: number, summary: string) =>
        this.modelCompressRange(agent, start, end, summary),
      windowFor: (agent: SessionAgent) => this.windowFor(agent),
      measureRatio: (agent: SessionAgent) => this.measureRatio(agent),
    }

    if (this.config.autoTools) {
      const registerTools = (): void => {
        const tools = ctx.get('tools')
        if (tools === undefined) return
        for (const tool of makeTools(env)) tools.register(tool)
      }
      registerTools()
      if (ctx.get('tools') === undefined) {
        let done = false
        ctx.on('internal/service', (name: unknown) => {
          if (name === 'tools' && !done) {
            done = true
            registerTools()
          }
        })
      }
    }

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      systemPrompt.section({ name: 'dsh-smart-compact', order: 200, text: SYSTEM_PROMPT_SECTION })
    }

    if (this.config.autoNudge) {
      ctx.on('agent/pre-step', async (payload: { agent: Agent; turn: number }, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        let ratio = 0
        try {
          ratio = await this.measureRatio(payload.agent)
        } catch {
          ratio = 0
        }
        if (ratio <= 0 || ratio < this.config.thresholdRatio) return decision
        const session = payload.agent.session
        // Nudge once per turn: repeated pre-steps of a multi-step turn must
        // not re-inject the advisory message.
        const turn = latestTurn(session)
        if (this.lastNudgeTurn.get(session.id) === turn) return decision
        this.lastNudgeTurn.set(session.id, turn)
        const ranges = buildCompressibleSeqRanges(session, this.rangeOpts())
        const suggestions = [
          ...(this.config.dedupEnabled ? dedupSuggestions(session) : []),
          ...purgeSuggestions(session, this.config.purgeErroredTurns),
        ]
        const message = createUserMessage({
          content: [{
            type: 'text',
            text: buildNudgeText({
              ratio,
              thresholdRatio: this.config.thresholdRatio,
              mandatoryRatio: this.config.mandatoryRatio,
              ranges,
              suggestions,
            }),
          }],
          source: { kind: 'plugin', plugin: 'dsh-smart-compact' },
        })
        return { kind: 'enter', messages: [...decision.messages, message] }
      })
    }
  }

  /** Effective context window for an agent (config wins; probe fallback 128000). */
  async windowFor(agent: SessionAgent): Promise<number> {
    if (this.config.modelContextLimit !== undefined) return this.config.modelContextLimit
    const provider = agent.options.provider ?? ''
    const model = agent.options.model ?? ''
    const key = `${provider}\u0000${model}`
    const cached = this.windowCache.get(key)
    if (cached !== undefined) return cached
    let window = DEFAULT_WINDOW
    try {
      const llm = this.engineCtx.get('llm')
      const info = await llm?.resolveModelInfo?.(provider, model) as { context?: { contextWindow?: number } } | undefined
      const context = info?.context?.contextWindow
      if (typeof context === 'number' && context > 0) window = context
    } catch {
      window = DEFAULT_WINDOW
    }
    this.windowCache.set(key, window)
    return window
  }

  /** Price the committed route when available; older hosts fall back to agent options. */
  async measureRatio(agent: SessionAgent): Promise<number> {
    const meter = this.engineCtx.get('tokenMeter')
    if (meter === undefined) return 0
    const session = agent.session as SessionAgent['session'] & {
      requestHeader?: () => { config: { provider?: string; model?: string; maxTokens?: number } } | undefined
    }
    const header = session.requestHeader?.()
    const route = header?.config ?? agent.options
    const provider = route.provider ?? ''
    const model = route.model ?? ''
    const info = await this.engineCtx.get('llm')?.resolveModelInfo?.(provider, model) as {
      context?: { contextWindow?: number }; defaultMaxTokens?: number
    } | undefined
    const window = this.config.modelContextLimit ?? info?.context?.contextWindow ?? DEFAULT_WINDOW
    const reserved = header?.config.maxTokens ?? info?.defaultMaxTokens ?? 0
    const measurement = meter.measure(agent.session) as { surfaceTokens: number; totalTokens?: number }
    const input = measurement.totalTokens ?? measurement.surfaceTokens
    const budget = Math.max(1, window - reserved - this.config.headroomTokens)
    return input / budget
  }

  private llmOf(): LlmLike {
    const llm = this.engineCtx.get('llm')
    if (llm === undefined) throw new Error('dsh-smart-compact: llm service unavailable')
    return llm as unknown as LlmLike
  }

  /** Engine-written summary of one span using the configurable prompt. */
  private async engineSummarizeRange(agent: SessionAgent, start: number, end: number, signal?: AbortSignal): Promise<string> {
    return summarizeRange(this.llmOf(), agent.session, start, end, {
      prompt: this.config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
      maxTokens: this.config.summarizationMaxTokens,
      provider: agent.options.provider ?? '',
      model: agent.options.model ?? '',
      signal,
    })
  }

  /**
   * A1: direct paths must never shadow a compaction checkpoint, the latest
   * real user message, or (when `protectUserMessages` is set) ANY user
   * message. Position checks use surface indices so post-replace
   * non-monotonic seqs stay correct.
   */
  private enforceProtection(session: import('@deepseek-ai/dsh-session').Session, start: number, end: number): void {
    const protectedSeqs = protectedSurfaceSeqs(session, this.rangeOpts())
    for (const seq of shadowedSeqsOf(session, start, end)) {
      if (protectedSeqs.has(seq)) throw new Error(`dsh-smart-compact: span includes protected seq ${seq}; consult dcp_status`)
    }
  }

  private manualError(code: ManualCompactionErrorCode, message: string, cause?: unknown): ManualCompactionError {
    return cause === undefined ? new ManualCompactionError(code, message) : new ManualCompactionError(code, message, { cause })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Durable LLM-backed compression of one balanced span inside one bracket
   * transaction: `compaction/start` is appended BEFORE any model work (the
   * durable lock), every failure aborts the bracket with the error recorded
   * and originals intact, and success completes it with the raw LLM output
   * preserved. Used by `/compact` (compactNow), compactRegion and the
   * automatic path.
   */
  private async summarizeAndLand(
    agent: SessionAgent,
    start: number,
    end: number,
    signal?: AbortSignal,
    opts: { sourceCommandId?: CommandId; manual?: boolean } = {},
  ): Promise<CompactionResult> {
    const session = agent.session
    const effectiveSignal = signal ?? new AbortController().signal
    let s: number
    let e: number
    try {
      ({ start: s, end: e } = resolveSurfaceRange(session, start, end))
    } catch (error) {
      if (opts.manual) throw this.manualError('changed', this.errorMessage(error), error)
      throw error
    }
    this.enforceProtection(session, s, e)
    const shadowed = shadowedSeqsOf(session, s, e)
    let tokens = 0
    for (const seq of shadowed) {
      const event = session.events[seq]
      if (event !== undefined) tokens += countTokens(extractEventText(event))
    }
    const provider = agent.options.provider ?? ''
    const model = agent.options.model ?? ''
    const sourceCommandId = opts.sourceCommandId
    const bracket = beginCompaction(session, sourceCommandId)
    let summaryText: string
    try {
      summaryText = await this.engineSummarizeRange(agent, s, e, effectiveSignal)
    } catch (error) {
      const message = this.errorMessage(error)
      abortCompaction(session, bracket, message)
      if (!opts.manual) throw error
      if (effectiveSignal.aborted) throw this.manualError('cancelled', 'compaction cancelled', error)
      throw this.manualError('summary', `summarization failed: ${message}`, error)
    }
    // Changed-span guard: the selected span must still be on the surface.
    if (effectiveSignal.aborted || shadowedSeqsOf(session, s, e).join(',') !== shadowed.join(',')) {
      abortCompaction(session, bracket, 'span changed during summarization')
      if (!opts.manual) throw new Error('dsh-smart-compact: span changed during summarization')
      throw this.manualError('changed', 'span changed during summarization')
    }
    if (countTokens(summaryText) >= tokens) {
      abortCompaction(session, bracket, 'summary does not reduce estimated tokens')
      if (opts.manual) throw this.manualError('summary', 'summary does not reduce estimated tokens')
      throw new Error('dsh-smart-compact: summary does not reduce estimated tokens')
    }
    const summary: ContentBlock[] = [{ type: 'text', text: summaryText }]
    let landed: { compactionId: CompactionId; seqs: number[] }
    try {
      landed = completeCompaction(session, bracket, {
        start: s,
        end: e,
        shadowedSeqs: shadowed,
        summary,
        shadowedTokenCount: tokens,
        provider,
        model,
        sourceCommandId,
        llmStreamCall: true,
        rawOutput: summary,
      })
    } catch (error) {
      // completeCompaction is fully synchronous and its compaction/end is
      // always its last append: ANY throw here means no end exists yet, so
      // appending one abort-end is always safe (never a double-end) and
      // closes the durable lock on the commit-failure path.
      const message = `commit failed: ${this.errorMessage(error)}`
      abortCompaction(session, bracket, message)
      if (!opts.manual) throw error
      throw this.manualError('commit', message, error)
    }
    const { compactionId, seqs } = landed
    return {
      compactionId: CompactionId(compactionId),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: seqs[0]!,
      summarySeq: seqs[1]!,
      endSeq: seqs[3]!,
      summary,
      shadowedRange: { start: s, end: e },
      shadowedSeqs: [...shadowed],
      shadowedTokenCount: tokens,
    }
  }

  /** Durable replace of one balanced span with an ALREADY-written summary (the compress-tool path). */
  private landWrittenRange(agent: SessionAgent, start: number, end: number, summaryText: string, sourceCommandId?: CommandId): CompactionResult {
    const session = agent.session
    const { start: s, end: e } = resolveSurfaceRange(session, start, end)
    this.enforceProtection(session, s, e)
    const shadowed = shadowedSeqsOf(session, s, e)
    let tokens = 0
    for (const seq of shadowed) {
      const event = session.events[seq]
      if (event !== undefined) tokens += countTokens(extractEventText(event))
    }
    if (!summaryText.trim() || countTokens(summaryText) >= tokens) throw new Error('dsh-smart-compact: summary must reduce estimated tokens')
    const summary: ContentBlock[] = [{ type: 'text', text: summaryText }]
    const { compactionId, seqs } = runCompactionTransaction(session, {
      start: s,
      end: e,
      shadowedSeqs: shadowed,
      summary,
      shadowedTokenCount: tokens,
      provider: agent.options.provider ?? '',
      model: agent.options.model ?? '',
      sourceCommandId,
    })
    return {
      compactionId: CompactionId(compactionId),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: seqs[0]!,
      summarySeq: seqs[1]!,
      endSeq: seqs[3]!,
      summary,
      shadowedRange: { start: s, end: e },
      shadowedSeqs: [...shadowed],
      shadowedTokenCount: tokens,
    }
  }

  /** The `compress` tool path: model-written summary lands a durable replace. */
  async modelCompressRange(agent: SessionAgent, start: number, end: number, summary: string): Promise<string> {
    const result = this.landWrittenRange(agent, start, end, summary.trim())
    return `  compressed seqs ${result.shadowedRange.start}..${result.shadowedRange.end} (~${result.shadowedTokenCount - countTokens(summary.trim())} net tokens saved)`
  }

  /** Auto-compact the largest compressible span with an engine-written summary. */
  private async autoCompactOldest(agent: SessionAgent, signal: AbortSignal): Promise<CompactionResult | null> {
    const ranges = buildCompressibleSeqRanges(agent.session, this.rangeOpts())
    if (ranges.length === 0) return null
    const range = ranges[0]!
    try {
      return await this.summarizeAndLand(agent, range.start, range.end, signal)
    } catch {
      // Automatic path is best-effort: the bracket was aborted with the
      // failure recorded and originals intact — do not fail the turn.
      return null
    }
  }

  /**
   * Automatic path: `context-overflow` always auto-compacts (the hard safety
   * net); `pressure` auto-compacts only at/above the mandatory line, once per
   * turn, after the model had a chance to act.
   */
  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (trigger === 'context-overflow') return this.autoCompactOldest(agent, signal)
    let ratio = 0
    try {
      ratio = await this.measureRatio(agent)
    } catch {
      ratio = 0
    }
    if (ratio < this.config.mandatoryRatio) return null
    const turn = latestTurn(agent.session)
    if (this.lastAutoCompactTurn.get(agent.session.id) === turn) return null
    this.lastAutoCompactTurn.set(agent.session.id, turn)
    return this.autoCompactOldest(agent, signal)
  }

  /** `/compact`: engine-driven LLM summary of the largest compressible span (original behavior). */
  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    let maintenanceSignal: AbortSignal | undefined
    try {
      return await agent.runMaintenance(async (maintSignal) => {
        maintenanceSignal = maintSignal
        signal.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const ranges = buildCompressibleSeqRanges(agent.session, this.rangeOpts())
        if (ranges.length === 0) return null
        const range = ranges[0]!
        // L1: summarization and the durable bracket follow the agent-owned
        // maintenance signal, not the outer request signal.
        return this.summarizeAndLand(agent, range.start, range.end, maintenanceSignal, {
          sourceCommandId,
          manual: true,
        })
      })
    } catch (error) {
      if (error instanceof ManualCompactionError) throw error
      if (signal.aborted || maintenanceSignal?.aborted === true) {
        throw this.manualError('cancelled', 'compaction cancelled', error)
      }
      // runMaintenance throws synchronously when the agent is already active.
      throw this.manualError('busy', this.errorMessage(error), error)
    }
  }

  /** Force-compact an explicit surface span with an engine-written summary. */
  override async compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    return this.summarizeAndLand(agent, start, end, signal)
  }
}

export {
  resolveConfig,
  type SmartCompactConfig,
  DEFAULT_SUMMARY_PROMPT,
  buildSummaryPrompt,
  buildCompressibleSeqRanges,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
  dedupSuggestions,
  purgeSuggestions,
  buildNudgeText,
  makeTools,
}
export default SmartCompactEngine
