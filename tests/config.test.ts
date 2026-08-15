import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.ts'
import { DEFAULT_SUMMARY_PROMPT, buildSummaryPrompt } from '../src/prompt.ts'
import { countTokens } from '../src/tokens.ts'

test('config: defaults are safe (50% nudge, 90% mandatory, /compact always works)', () => {
  const config = resolveConfig({})
  assert.equal(config.thresholdRatio, 0.5)
  assert.equal(config.mandatoryRatio, 0.9)
  assert.equal(config.summarizationMaxTokens, 8192)
  assert.equal(config.preserveRecent, 5)
  assert.equal(config.dedupEnabled, true)
  assert.equal(config.purgeErroredTurns, 4)
  assert.equal(config.protectUserMessages, false)
  assert.equal(config.autoTools, true)
  assert.equal(config.autoNudge, true)
})

test('config: explicit values win and mandatory must be >= threshold', () => {
  const config = resolveConfig({ thresholdRatio: 0.3, mandatoryRatio: 0.8, summaryPrompt: 'custom {content}' })
  assert.equal(config.thresholdRatio, 0.3)
  assert.equal(config.mandatoryRatio, 0.8)
  assert.equal(config.summaryPrompt, 'custom {content}')
})

test('config: invalid ratios throw at load time', () => {
  assert.throws(() => resolveConfig({ thresholdRatio: 0 }), /thresholdRatio/)
  assert.throws(() => resolveConfig({ thresholdRatio: 1 }), /thresholdRatio/)
  assert.throws(() => resolveConfig({ mandatoryRatio: 0.4, thresholdRatio: 0.5 }), /mandatoryRatio/)
  assert.throws(() => resolveConfig({ summarizationMaxTokens: 0 }), /summarizationMaxTokens/)
})

test('prompt: default template substitutes {content}; fallback appends', () => {
  assert.ok(DEFAULT_SUMMARY_PROMPT.includes('{content}'))
  assert.ok(buildSummaryPrompt(DEFAULT_SUMMARY_PROMPT, 'RAW').includes('RAW'))
  assert.ok(buildSummaryPrompt('no placeholder', 'RAW').includes('RAW'))
})

test('tokens: CJK-aware estimation (1 char/token CJK, 4 chars/token otherwise)', () => {
  assert.equal(countTokens('中'.repeat(100)), 100)
  assert.equal(countTokens('a'.repeat(100)), 25)
  assert.equal(countTokens('中'.repeat(50) + 'a'.repeat(40)), 60)
})
