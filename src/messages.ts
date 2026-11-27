/**
 * Session-log text projection: extract model-facing plain text from DSH
 * content blocks and message events. No kernel, no side state — the log is
 * the only source of truth.
 * @module dsh-smart-compact/messages
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Extract plain text from a content block array or string. Recursive: a real
 * DSH `tool-result` block is `{ type: 'tool-result', toolCallId, content:
 * ContentBlock[] }` — the inner array holds the actual text blocks, so a
 * top-level-only walk would drop every tool result.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; content?: unknown; name?: unknown; arguments?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'tool-call') {
      parts.push(`Tool: ${String(b.name ?? '')}\nArguments: ${typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? null)}`)
    } else if (Array.isArray(b.content)) {
      parts.push(extractText(b.content))
    }
  }
  return parts.join('\n')
}

/** The model-facing text of any surface message event ('' for non-message). */
export function extractEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return extractText((event.data as { content?: unknown }).content)
    case 'assistant/message':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    case 'tool/result':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    default:
      return ''
  }
}
