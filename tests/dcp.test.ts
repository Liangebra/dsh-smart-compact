import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupSuggestions, purgeSuggestions } from '../src/dcp.ts'
import { buildTextSession, buildToolSession, appendToolCall, appendToolResult, appendTurn, appendUser, appendAssistant } from './helpers.ts'

test('dcp: dedup suggests the older duplicate of a repeated tool call', () => {
  const session = buildToolSession()
  const suggestions = dedupSuggestions(session)
  const dedup = suggestions.filter((suggestion) => suggestion.kind === 'dedup')
  assert.ok(dedup.length >= 1, 'older duplicate suggested')
  assert.ok(dedup[0]!.reason.includes('duplicate tool call bash'))
})

test('dcp: no dedup when a tool call is not repeated', () => {
  const session = buildTextSession(6)
  assert.equal(dedupSuggestions(session).length, 0)
})

test('dcp: purge suggests errored calls older than the turn threshold', () => {
  const session = buildTextSession(2)
  appendTurn(session, 2)
  appendUser(session, 'check')
  appendToolCall(session, 'calling', 'err-1', 2, 1)
  appendToolResult(session, 'ERROR: boom '.repeat(50), 'err-1', 2, 2, true)
  appendTurn(session, 3)
  appendUser(session, 'later')
  const suggestions = purgeSuggestions(session, 1)
  const purges = suggestions.filter((suggestion) => suggestion.kind === 'purge')
  assert.ok(purges.length >= 1, 'old errored call suggested for purge')
  assert.ok(purges[0]!.reason.includes('errored tool call'))
})

test('dcp: purge is disabled with turns=0 and skips recent/clean results', () => {
  const session = buildToolSession() // all in turn 1
  assert.equal(purgeSuggestions(session, 0).length, 0)
  // Recent (same-turn) errored calls are not purged with a threshold > 0.
  const session2 = buildTextSession(2)
  appendToolCall(session2, 'calling', 'r1', 1, 1)
  appendToolResult(session2, 'ERROR: x', 'r1', 1, 2, true)
  assert.equal(purgeSuggestions(session2, 4).length, 0, 'same-turn error is recent')
  // Clean (non-errored) old results are never purged.
  const session3 = buildTextSession(2)
  appendTurn(session3, 2)
  appendToolCall(session3, 'calling', 'c1', 2, 1)
  appendToolResult(session3, 'ok output', 'c1', 2, 2, false)
  appendTurn(session3, 5)
  appendUser(session3, 'far later')
  assert.equal(purgeSuggestions(session3, 4).length, 0)
})
