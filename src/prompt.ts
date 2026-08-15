/**
 * Summary prompt template. Fully configurable via `summaryPrompt`; the
 * `{content}` placeholder is replaced by the span's original text. The default
 * is a high-fidelity technical checkpoint instruction.
 * @module dsh-smart-compact/prompt
 */

export const DEFAULT_SUMMARY_PROMPT = `You are acting as a context compaction engine for an AI coding assistant. Below is the ORIGINAL conversation content that must be condensed into a single technical checkpoint.

Preserve every detail that matters for continuing the work: exact file paths, commands, error strings, identifiers, numeric values, function signatures, decisions and their rationale, user preferences, and explicitly requested pending work. Discard only redundant or spent detail (completed sub-steps, repeated content).

Output EXACTLY the Markdown structure below, in order, using terse bullets:
## Context
## Files and Code
## Decisions and Rationale
## Errors and Fixes
## Pending Work
## Next Step

Rules: write concise technical prose; keep identifiers and values verbatim; do not mention this summarization request; output only the checkpoint text.

Original content:
{content}`

/** Substitute the span text into a prompt template. */
export function buildSummaryPrompt(template: string, content: string): string {
  if (template.includes('{content}')) return template.replaceAll('{content}', content)
  return `${template}\n\nOriginal content:\n${content}`
}
