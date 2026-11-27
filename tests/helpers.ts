/**
 * Test helpers — detached sessions with realistic message logs via the public
 * `Session.create` API (no DSH runtime needed).
 */

import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, type ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'

/** Long enough to produce meaningful token counts. */
const LONG = 'JWT access tokens with 15 minute expiry and refresh tokens stored in Redis with 30 day TTL, implemented in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute. '.repeat(20)

export function longText(label: string, seed: number): string {
  return `${LONG} [${label} ${seed}]`
}

export function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

export function appendAssistant(session: Session, text: string, turn = 1, step = 1): void {
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
}

export function appendToolCall(session: Session, text: string, callId: string, turn = 1, step = 1): void {
  const id = callId as ToolCallId
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        { type: 'tool-call', id, name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
}

export function appendToolResult(session: Session, text: string, callId: string, turn = 1, step = 1, isError = false): void {
  const id = callId as ToolCallId
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError }),
  }, { surfaceOp: 'append' })
}

/** A session with `count` alternating user/assistant text messages in one open turn. */
export function buildTextSession(count: number): Session {
  const session = Session.create('test-session' as SessionId)
  appendTurn(session, 1)
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) appendUser(session, longText('msg', index))
    else appendAssistant(session, longText('reply', index), 1, index)
  }
  return session
}

/** A session with one repeated tool call (dedup fixture) plus text around it. */
export function buildToolSession(): Session {
  const session = Session.create('tool-session' as SessionId)
  appendTurn(session, 1)
  appendUser(session, 'run the check twice')
  appendToolCall(session, 'calling bash', 'call-1', 1, 1)
  appendToolResult(session, 'OUTPUT-OLD huge content '.repeat(40), 'call-1', 1, 2)
  appendAssistant(session, 'still investigating', 1, 3)
  appendToolCall(session, 'calling bash again', 'call-2', 1, 4)
  appendToolResult(session, 'OUTPUT-NEW', 'call-2', 1, 5)
  appendUser(session, 'done')
  return session
}
