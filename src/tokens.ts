/**
 * CJK-aware token estimation: 1 token per CJK character, 4 chars per token
 * otherwise — the same heuristic vocabulary as the harness token meter, so
 * shadowed-token accounting stays consistent with pressure measurement.
 * @module dsh-smart-compact/tokens
 */

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

export function countTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}
