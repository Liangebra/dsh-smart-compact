import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompressibleSeqRanges,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  shadowedSeqsOf,
} from '../src/region.ts'
import { buildTextSession, buildToolSession, appendUser } from './helpers.ts'

test('region: compressible ranges skip the protected tail and last user message', () => {
  const session = buildTextSession(10)
  const ranges = buildCompressibleSeqRanges(session, { preserveRecent: 5 })
  assert.ok(ranges.length > 0)
  // The last user message is never compressible.
  const lastUser = [...session.surface.nodes].reverse().find((seq) => session.events[seq]?.type === 'user/message')!
  for (const range of ranges) assert.ok(!(range.start <= lastUser && lastUser <= range.end), 'last user message protected')
  // Ranges are sorted by reclaimed tokens, largest first.
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index - 1]!.tokens >= ranges[index]!.tokens)
  }
})

test('region: transaction replaces the span and rebuilds a ledger block', () => {
  const session = buildTextSession(10)
  const ranges = buildCompressibleSeqRanges(session)
  assert.ok(ranges.length > 0)
  const range = ranges[0]!
  const shadowed = shadowedSeqsOf(session, range.start, range.end)
  assert.ok(shadowed.length > 0)
  const { compactionId, seqs } = runCompactionTransaction(session, {
    start: range.start,
    end: range.end,
    shadowedSeqs: shadowed,
    summary: [{ type: 'text', text: 'CHECKPOINT' }],
    shadowedTokenCount: range.tokens,
    provider: 'p',
    model: 'm',
  })
  assert.ok(compactionId.length > 0)
  assert.equal(seqs.length, 4)
  const ledger = rebuildBlockLedger(session.events)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0]!.summary, 'CHECKPOINT')
  assert.deepEqual(ledger[0]!.shadowedSeqs, shadowed)
  // Originals stay in the log; the surface no longer shows them.
  const onSurface = new Set(session.surface.nodes)
  for (const seq of shadowed) assert.ok(!onSurface.has(seq), `seq ${seq} shadowed`)
  for (const seq of shadowed) assert.ok(session.events[seq] !== undefined, `seq ${seq} original still logged`)
})

test('region: checkpoints are never re-compressed; fresh content after them is', () => {
  const session = buildTextSession(10)
  const first = buildCompressibleSeqRanges(session)[0]!
  runCompactionTransaction(session, {
    start: first.start,
    end: first.end,
    shadowedSeqs: shadowedSeqsOf(session, first.start, first.end),
    summary: [{ type: 'text', text: 'C1' }],
    shadowedTokenCount: first.tokens,
    provider: 'p',
    model: 'm',
  })
  // Nothing left to compress immediately (checkpoint + protected tail).
  assert.equal(buildCompressibleSeqRanges(session).length, 0)
  // Fresh unprotected content becomes compressible while the checkpoint stays.
  appendUser(session, 'new content '.repeat(200))
  appendUser(session, 'more new content '.repeat(200))
  appendUser(session, 'even more '.repeat(200))
  const ranges = buildCompressibleSeqRanges(session)
  assert.ok(ranges.length > 0)
  assert.equal(rebuildBlockLedger(session.events).length, 1, 'checkpoint not folded')
})

test('region: protectUserMessages keeps every user message uncompressed', () => {
  const session = buildTextSession(10)
  const userSeqs = session.surface.nodes.filter((seq) => session.events[seq]?.type === 'user/message')
  const ranges = buildCompressibleSeqRanges(session, { protectUserMessages: true })
  for (const range of ranges) {
    for (const seq of userSeqs) {
      assert.ok(!(range.start <= seq && seq <= range.end), `user seq ${seq} protected`)
    }
  }
})

test('region: protectedTools keeps the named tool call/result pair uncompressed', () => {
  const session = buildToolSession()
  const toolCallSeq = session.surface.nodes.find((seq) => {
    const event = session.events[seq]
    if (event?.type !== 'assistant/message') return false
    return (event.data as { message?: { content?: Array<{ type?: string; name?: string }> } })
      .message?.content?.some((block) => block.type === 'tool-call' && block.name === 'bash') === true
  })!
  assert.ok(toolCallSeq !== undefined)
  // The paired result (same callId) must be protected together with the call.
  const toolResultSeq = session.surface.nodes.find((seq) => session.events[seq]?.type === 'tool/result')!
  assert.ok(toolResultSeq !== undefined)
  const ranges = buildCompressibleSeqRanges(session, { protectedToolNames: ['bash'] })
  for (const range of ranges) {
    assert.ok(!(range.start <= toolCallSeq && toolCallSeq <= range.end), `tool call seq ${toolCallSeq} protected`)
    assert.ok(!(range.start <= toolResultSeq && toolResultSeq <= range.end), `tool result seq ${toolResultSeq} protected`)
  }
})

test('region: resolveSurfaceRange balances tool-call/result pairs', () => {
  const session = buildToolSession()
  const ranges = buildCompressibleSeqRanges(session)
  assert.ok(ranges.length > 0)
  const { start, end } = resolveSurfaceRange(session, ranges[0]!.start, ranges[0]!.end)
  assert.ok(start <= end)
  assert.ok(start >= ranges[0]!.start, 'shrunk or kept inward')
})

test('region: resolveSurfaceRange snaps stale edges to live nodes', () => {
  const session = buildTextSession(6)
  const nodes = session.surface.nodes
  const { start } = resolveSurfaceRange(session, nodes[0]!, nodes[nodes.length - 1]!)
  assert.ok(nodes.includes(start))
})

 test('region: zero retained nodes does not protect the entire surface', () => {
  const session = buildTextSession(10)
  assert.ok(buildCompressibleSeqRanges(session, { preserveRecent: 0 }).length > 0)
})
