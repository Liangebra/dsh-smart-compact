import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeTools } from '../src/compress-tool.ts'
import { resolveConfig } from '../src/config.ts'
import { rebuildBlockLedger } from '../src/region.ts'
import { buildTextSession } from './helpers.ts'

function envWith(compressRange: (start: number, end: number, summary: string) => Promise<string>) {
  return {
    config: resolveConfig({}),
    compressRange: (_agent: unknown, start: number, end: number, summary: string) => compressRange(start, end, summary),
    windowFor: async () => 100000,
    measureRatio: async () => 0.6,
  }
}

function execFor(session: import('@deepseek-ai/dsh-session').Session) {
  return { signal: new AbortController().signal, agent: { session, options: {} } }
}

test('tools: compress range mode lands each entry with its summary', async () => {
  const session = buildTextSession(10)
  const landed: string[] = []
  const tools = makeTools(envWith(async (_s, _e, summary) => {
    landed.push(summary)
    return `ok ${landed.length}`
  }))
  const compress = tools[0]!
  const nodes = session.surface.nodes
  const result = await compress.execute({
    mode: 'range',
    ranges: [
      { startSeq: nodes[0]!, endSeq: nodes[1]!, summary: 'SUM-A' },
      { startSeq: nodes[2]!, endSeq: nodes[3]!, summary: 'SUM-B' },
    ],
  }, execFor(session) as never) as string
  assert.ok(result.includes('ok 1'))
  assert.ok(result.includes('ok 2'))
  assert.deepEqual(landed, ['SUM-A', 'SUM-B'])
})

test('tools: compress message mode treats each seq as a single-entry span', async () => {
  const session = buildTextSession(10)
  const landed: string[] = []
  const tools = makeTools(envWith(async (_s, _e, summary) => {
    landed.push(summary)
    return `ok`
  }))
  const compress = tools[0]!
  const nodes = session.surface.nodes
  const result = await compress.execute({
    mode: 'message',
    messages: [{ seq: nodes[0]!, summary: 'M-ONE' }],
  }, execFor(session) as never) as string
  assert.ok(result.includes('ok'))
  assert.deepEqual(landed, ['M-ONE'])
})

test('tools: compress rejects an empty summary without landing', async () => {
  const session = buildTextSession(10)
  const landed: string[] = []
  const tools = makeTools(envWith(async (_s, _e, summary) => {
    landed.push(summary)
    return 'ok'
  }))
  const compress = tools[0]!
  const nodes = session.surface.nodes
  const result = await compress.execute({
    mode: 'range',
    ranges: [{ startSeq: nodes[0]!, endSeq: nodes[1]!, summary: '   ' }],
  }, execFor(session) as never) as string
  assert.ok(result.includes('empty summary'))
  assert.equal(landed.length, 0)
})

test('tools: dcp_status reports usage, ranges, and suggestions', async () => {
  const session = buildTextSession(10)
  const tools = makeTools(envWith(async () => 'ok'))
  const status = tools[1]!
  const result = await status.execute({}, execFor(session) as never) as string
  assert.ok(result.includes('context usage: 60%'))
  assert.ok(result.includes('compressible ranges:'))
  assert.ok(result.includes('threshold 50%, mandatory 90%'))
})
