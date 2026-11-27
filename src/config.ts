/**
 * Engine configuration: every behavioral knob is explicit and validated at
 * load time. Defaults prioritize safety: the mandatory line sits below 1.0 so
 * the engine acts before the provider rejects, and /compact always works.
 * @module dsh-smart-compact/config
 */

export interface SmartCompactConfig {
  /** Context window used for pressure decisions; auto-detect fallback 128000. */
  readonly modelContextLimit?: number
  /** Nudge line: usage >= this prompts the model to compress. Default 0.5. */
  readonly thresholdRatio: number
  /** Additional input headroom beyond reserved output tokens. */
  readonly headroomTokens: number
  /** Mandatory line: usage >= this demands compression and the engine auto-compacts if the model does not act. Default 0.9. */
  readonly mandatoryRatio: number
  /** Custom summary prompt template; `{content}` is replaced by the span's original text. */
  readonly summaryPrompt?: string
  /** Max output tokens for engine-written summaries. Default 8192. */
  readonly summarizationMaxTokens: number
  /** Number of most recent surface nodes never compressed. Default 5. */
  readonly preserveRecent: number
  /** DCP: deduplicate repeated tool calls (same tool + same arguments keep the latest output). Default true. */
  readonly dedupEnabled: boolean
  /** DCP: purge large inputs of errored tool calls after this many turns; 0 disables. Default 4. */
  readonly purgeErroredTurns: number
  /** Tool names whose call/result pairs are never compressed (surface range building honors them). */
  readonly protectedTools: readonly string[]
  /** Keep ALL user messages verbatim (never compress them). Default false. */
  readonly protectUserMessages: boolean
  /** Register the model tools (compress / dcp_status) on ctx.tools. Default true. */
  readonly autoTools: boolean
  /** Inject threshold/mandatory nudges at agent/pre-step. Default true. */
  readonly autoNudge: boolean
}

export const DEFAULT_CONFIG: SmartCompactConfig = {
  thresholdRatio: 0.5,
  headroomTokens: 4096,
  mandatoryRatio: 0.9,
  summarizationMaxTokens: 8192,
  preserveRecent: 5,
  dedupEnabled: true,
  purgeErroredTurns: 4,
  protectedTools: [],
  protectUserMessages: false,
  autoTools: true,
  autoNudge: true,
}

export function resolveConfig(config: Partial<SmartCompactConfig> = {}): SmartCompactConfig {
  const resolved: SmartCompactConfig = { ...DEFAULT_CONFIG, ...config }
  if (!(resolved.thresholdRatio > 0 && resolved.thresholdRatio < 1)) {
    throw new Error(`dsh-smart-compact: thresholdRatio must be in (0, 1), got ${resolved.thresholdRatio}`)
  }
  if (!(resolved.mandatoryRatio >= resolved.thresholdRatio && resolved.mandatoryRatio <= 1)) {
    throw new Error(
      `dsh-smart-compact: mandatoryRatio must be in [thresholdRatio, 1], got ${resolved.mandatoryRatio}`,
    )
  }
  if (!(resolved.summarizationMaxTokens > 0)) {
    throw new Error(`dsh-smart-compact: summarizationMaxTokens must be positive, got ${resolved.summarizationMaxTokens}`)
  }
  if (!(resolved.preserveRecent >= 0)) {
    throw new Error(`dsh-smart-compact: preserveRecent must be non-negative, got ${resolved.preserveRecent}`)
  }
  if (!(resolved.purgeErroredTurns >= 0)) {
    throw new Error(`dsh-smart-compact: purgeErroredTurns must be non-negative, got ${resolved.purgeErroredTurns}`)
  }
  if (!Number.isSafeInteger(resolved.headroomTokens) || resolved.headroomTokens < 0) throw new Error('dsh-smart-compact: headroomTokens must be a non-negative integer')
  if (resolved.modelContextLimit !== undefined && (!Number.isSafeInteger(resolved.modelContextLimit) || resolved.modelContextLimit <= 0)) throw new Error('dsh-smart-compact: modelContextLimit must be a positive integer')
  return resolved
}
