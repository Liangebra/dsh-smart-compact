import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { SmartCompactEngine } from '../src/index.ts'
import { buildCompressibleSeqRanges, rebuildBlockLedger } from '../src/region.ts'
import { buildTextSession, appendToolCall, appendToolResult } from './helpers.ts'

function fakeLlm(text: string): { stream: () => AsyncIterable<unknown> } {
  return {
    async *stream() {
      yield { type: 'text-delta', index: 0, text }
    },
  }
}

function fakeMeter(surfaceTokens: number): { measure: () => unknown } {
  return {
    measure: () => ({
      logRevision: 0,
      baseline: 'heuristic',
      surfaceDeltaTokens: 0,
      totalTokens: surfaceTokens,
      surfaceTokens,
      nodes: [],
    }),
  }
}

function agentOf(session: import('@deepseek-ai/dsh-session').Session, runMaintenance = true) {
  const base = { id: session.id, session, options: { provider: 'test-provider', model: 'test-model' } }
  if (!runMaintenance) return base
  return {
    ...base,
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
  }
}

function engineWith(ctx: Context, extra: Record<string, unknown> = {}): SmartCompactEngine {
  return new SmartCompactEngine(ctx, {
    modelContextLimit: 100000,
    autoTools: false,
    autoNudge: false,
    ...extra,
  })
}

/** Narrow the first summary block to text and return it. */
function summaryText(result: { summary: readonly import('@deepseek-ai/dsh-llm').ContentBlock[] }): string {
  const block = result.summary[0]!
  assert.equal(block.type, 'text')
  return block.text
}

test('engine: /compact (compactNow) summarizes the largest span with the custom prompt', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('SUMMARY-FROM-LLM'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx, { summaryPrompt: 'custom prompt {content}' })
  const session = buildTextSession(10)
  const result = await engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal, 'cmd-1' as never)
  assert.ok(result !== null)
  assert.equal(result.sourceCommandId, 'cmd-1')
  assert.equal(result.summary[0]!.type, 'text')
  assert.equal(summaryText(result), 'SUMMARY-FROM-LLM')
  assert.ok(result.shadowedSeqs.length > 0)
  assert.ok(result.shadowedTokenCount > 0)
  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 1)
})

test('engine: /compact on a tiny session returns null (nothing compressible)', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('X'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(4) // all protected
  const result = await engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal)
  assert.equal(result, null)
})

test('engine: context-overflow always auto-compacts (hard safety net)', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('OVERFLOW-SUMMARY'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const result = await engine.compactIfNeeded({ session, options: {} }, 'context-overflow', new AbortController().signal)
  assert.ok(result !== null)
  assert.equal(summaryText(result), 'OVERFLOW-SUMMARY')
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1)
})

test('engine: pressure trigger auto-compacts only at/above the mandatory line, once per turn', async () => {
  // Below mandatory: no-op.
  const ctxLow = new Context()
  ctxLow.provide('llm', fakeLlm('X'))
  ctxLow.provide('tokenMeter', fakeMeter(40000)) // 40% of 100000 window
  const engineLow = engineWith(ctxLow)
  const sessionLow = buildTextSession(10)
  assert.equal(
    await engineLow.compactIfNeeded({ session: sessionLow, options: {} }, 'pressure', new AbortController().signal),
    null,
  )

  // At/above mandatory: auto-compacts once per turn.
  const ctxHigh = new Context()
  ctxHigh.provide('llm', fakeLlm('MANDATORY-SUMMARY'))
  ctxHigh.provide('tokenMeter', fakeMeter(95000)) // 95% of 100000
  const engineHigh = engineWith(ctxHigh)
  const sessionHigh = buildTextSession(10)
  const first = await engineHigh.compactIfNeeded({ session: sessionHigh, options: {} }, 'pressure', new AbortController().signal)
  assert.ok(first !== null)
  assert.equal(summaryText(first!), 'MANDATORY-SUMMARY')
  const second = await engineHigh.compactIfNeeded({ session: sessionHigh, options: {} }, 'pressure', new AbortController().signal)
  assert.equal(second, null, 'once per turn cadence')
})

test('engine: compactRegion force-compacts an explicit span', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('REGION-SUMMARY'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const nodes = session.surface.nodes
  const result = await engine.compactRegion(nodes[0]!, nodes[3]!, { session, options: {} }, new AbortController().signal)
  assert.ok(result !== null)
  assert.equal(summaryText(result), 'REGION-SUMMARY')
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1)
})

test('engine: modelCompressRange lands the model-written summary durably', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('unused'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const ranges = buildCompressibleSeqRanges(session)
  const range = ranges[0]!
  const text = await engine.modelCompressRange(agentOf(session, false), range.start, range.end, 'MODEL-WROTE-THIS')
  assert.ok(text.includes('compressed seqs'))
  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0]!.summary, 'MODEL-WROTE-THIS')
})

test('engine: result seqs point at the durable bracket events', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('S'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const result = await engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal)
  assert.ok(result !== null)
  assert.equal(session.snapshotEvents()[result.startSeq]!.type, 'compaction/start')
  assert.equal(session.snapshotEvents()[result.summarySeq]!.type, 'compaction/summary')
  assert.equal(session.snapshotEvents()[result.endSeq]!.type, 'compaction/end')
  assert.ok(result.startSeq < result.summarySeq && result.summarySeq < result.endSeq)
})

test('engine: /compact classifies summarization failure as ManualCompactionError("summary") and releases the bracket', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    stream: () => {
      throw new Error('llm down')
    },
  })
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  await assert.rejects(
    engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal),
    (error) => error instanceof ManualCompactionError && error.code === 'summary',
  )
  // The durable lock must not dangle: a compaction/end with the error follows.
  const endEvents = session.snapshotEvents().filter((event) => event.type === 'compaction/end')
  assert.equal(endEvents.length, 1)
  assert.ok((endEvents[0]!.data as { error?: string }).error !== undefined)
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 0, 'no block on failure')
})

test('engine: /compact classifies an active agent as ManualCompactionError("busy")', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('X'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const busyAgent = {
    ...agentOf(session),
    runMaintenance: () => {
      throw new Error('agent is active')
    },
  }
  await assert.rejects(
    engine.compactNow(busyAgent as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal),
    (error) => error instanceof ManualCompactionError && error.code === 'busy',
  )
})

test('engine: commit-stage failure closes the bracket and classifies ManualCompactionError("commit")', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('S'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  // Fail only the FIRST compaction/end append (completeCompaction's last step).
  let endAttempts = 0
  const originalAppend = session.append.bind(session) as (...args: unknown[]) => unknown
  session.append = ((type: string, data: unknown, opts?: unknown) => {
    if (type === 'compaction/end') {
      endAttempts += 1
      if (endAttempts === 1) throw new Error('disk full')
    }
    return originalAppend(type, data, opts)
  }) as unknown as typeof session.append

  // Manual path: classified 'commit', and the abort-end closes the lock.
  await assert.rejects(
    engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal),
    (error) => error instanceof ManualCompactionError && error.code === 'commit',
  )
  const starts = session.snapshotEvents().filter((event) => event.type === 'compaction/start').length
  const ends = session.snapshotEvents().filter((event) => event.type === 'compaction/end').length
  assert.equal(starts, 1)
  assert.equal(ends, 1, 'abort-end appended: no dangling lock')
  // The summary + replace landed before the end-append failed: one block exists.
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1)
})

test('engine: auto path survives a commit-stage failure with a closed bracket', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('S'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  let endAttempts = 0
  const originalAppend = session.append.bind(session) as (...args: unknown[]) => unknown
  session.append = ((type: string, data: unknown, opts?: unknown) => {
    if (type === 'compaction/end') {
      endAttempts += 1
      if (endAttempts === 1) throw new Error('disk full')
    }
    return originalAppend(type, data, opts)
  }) as unknown as typeof session.append
  const result = await engine.compactIfNeeded({ session, options: {} }, 'context-overflow', new AbortController().signal)
  assert.equal(result, null, 'best-effort: no result on failure')
  const starts = session.snapshotEvents().filter((event) => event.type === 'compaction/start').length
  const ends = session.snapshotEvents().filter((event) => event.type === 'compaction/end').length
  assert.equal(starts, 1)
  assert.equal(ends, 1, 'bracket closed on the auto path too')
})

test('engine: protectUserMessages is enforced on direct paths too', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('X'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx, { protectUserMessages: true })
  const session = buildTextSession(10)
  const nodes = session.surface.nodes
  // An OLD user message inside the span must be refused by the compress path.
  const userSeqs = nodes.filter((seq) => session.snapshotEvents()[seq]?.type === 'user/message')
  assert.ok(userSeqs.length >= 2)
  const oldUser = userSeqs[0]!
  await assert.rejects(
    engine.modelCompressRange(agentOf(session, false), oldUser, oldUser, 'NOPE'),
    /user message/,
  )
  await assert.rejects(
    engine.compactRegion(oldUser, oldUser, { session, options: {} }),
    /user message/,
  )
  // Assistant-only single-node spans still work.
  const assistantOnly = nodes.filter((seq) => session.snapshotEvents()[seq]?.type === 'assistant/message')
  assert.ok(assistantOnly.length >= 2)
  const result = await engine.compactRegion(assistantOnly[0]!, assistantOnly[0]!, { session, options: {} })
  assert.ok(result !== null)
})

test('engine: direct paths never shadow a checkpoint or the latest user message', async () => {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm('X'))
  ctx.provide('tokenMeter', fakeMeter(1000))
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  // Land one checkpoint first.
  const first = buildCompressibleSeqRanges(session)[0]!
  await engine.modelCompressRange(agentOf(session, false), first.start, first.end, 'CHECKPOINT-1')
  const nodes = session.surface.nodes
  const sourceOf = (seq: number): { plugin?: string } | undefined =>
    (session.snapshotEvents()[seq]?.data as { source?: { plugin?: string } })?.source
  const checkpoint = nodes.find((seq) => session.snapshotEvents()[seq]?.type === 'user/message' && (sourceOf(seq) as { kind?: string })?.kind === 'compact-checkpoint')!
  assert.ok(checkpoint !== undefined, 'checkpoint present')
  const lastUser = [...nodes].reverse().find((seq) => session.snapshotEvents()[seq]?.type === 'user/message' && (sourceOf(seq) as { kind?: string })?.kind !== 'compact-checkpoint')!
  assert.ok(lastUser !== undefined, 'last user message present')
  await assert.rejects(
    engine.compactRegion(checkpoint, checkpoint, { session, options: {} }),
    /checkpoint/,
  )
  await assert.rejects(
    engine.compactRegion(lastUser, lastUser, { session, options: {} }),
    /latest user message/,
  )
  await assert.rejects(
    engine.modelCompressRange(agentOf(session, false), checkpoint, checkpoint, 'NOPE'),
    /checkpoint/,
  )
  assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 1, 'no new block from refused spans')
})

test('engine: pressure includes request overhead and reserves model output', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    ...fakeLlm('unused'),
    resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 20000 }),
  })
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 60000, surfaceTokens: 10000 }) })
  const engine = engineWith(ctx, { headroomTokens: 5000 })
  const session = buildTextSession(10)
  assert.equal(await engine.measureRatio(agentOf(session)), 60000 / 75000)
})

test('engine: direct compression cannot replace protected tool pairs', async () => {
  const ctx = new Context()
  const engine = engineWith(ctx, { protectedTools: ['bash'], preserveRecent: 0 })
  const session = buildTextSession(2)
  appendToolCall(session, 'call', 'protected')
  appendToolResult(session, 'large output '.repeat(100), 'protected')
  const nodes = session.surface.nodes
  await assert.rejects(engine.modelCompressRange(agentOf(session), nodes[2]!, nodes[3]!, 'summary'), /protected seq/)
})
test('engine: streamed block completion does not duplicate the summary', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: 'SUMMARY' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SUMMARY' } }
    },
  })
  const engine = engineWith(ctx)
  const session = buildTextSession(10)
  const result = await engine.compactNow(agentOf(session) as Parameters<SmartCompactEngine['compactNow']>[0], new AbortController().signal)
  assert.ok(result)
  assert.equal(summaryText(result), 'SUMMARY')
})
