[**English**](README.md) · [**简体中文**](README.zh.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-1f6feb.svg)
![Tests: 33/33](https://img.shields.io/badge/tests-33%2F33-brightgreen.svg)

# dsh-smart-compact

A custom [`CompactionEngine`](https://github.com/DeepSeekAI/dsh) backend for the
DeepSeek Harness: configurable **threshold prompting**, a **mandatory
auto-compaction** safety net at the limit, **DCP-style dedup / purge**
suggestions, a fully **configurable summary prompt**, and a `/compact` command
that keeps the original engine-driven behavior.

> **Why the name?** The strategy families — deduplication of repeated tool
> outputs, purging errored calls, a model-driven `compress` tool and nudges —
> are inspired by **DCP (Dynamic Context Pruning)**, the opencode-dcp
> approach to keeping long sessions cheap. The *mechanism* is different:
> opencode-dcp prunes only the outbound LLM payload without touching session
> history, while this engine lives on the DSH `CompactionEngine` seam and
> writes standard durable compaction brackets into the session log (zero
> external state, originals never deleted). "smart-compact" names the
> mechanism; the DCP lineage lives in the strategy module (`dcp.ts`) and the
> `dcp_status` tool.

**Zero external state.** No kernel, no ledger files, no database, no
in-memory state that must stay in sync with the log. Every compression is a
standard durable bracket in the append-only session log:

```
compaction/start  →  compaction/summary  →  user/message (surface replace)  →  compaction/end
```

Original events are **never deleted**; block information is rebuilt from the
log on demand (`rebuildBlockLedger`), so a crash, restart, or resumed session
always sees a consistent picture.

## Mount

One compaction backend per realm — disable the stock `compaction-basic` row
and add this one to your composition (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: compaction-smart
  name: 'dsh-smart-compact'
  config:
    thresholdRatio: 0.5
    mandatoryRatio: 0.9
    summarizationMaxTokens: 8192
    preserveRecent: 5
    dedupEnabled: true
    purgeErroredTurns: 4
    summaryPrompt: |
      Write ONE dense technical summary of the content below.
      Preserve exact paths, commands, error strings, identifiers,
      decisions and pending work; discard spent detail.
      {content}
```

The package registers itself as `ctx.compaction`. Restart `dsh web` after a
composition change (the web profile runs without HMR).

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.5` | Context-usage fraction where the advisory nudge appears (`agent/pre-step`); the model decides whether to use the `compress` tool. |
| `mandatoryRatio` | `0.9` | At/above this the engine auto-compacts the largest compressible span once per turn. |
| `summarizationMaxTokens` | `8192` | Generation cap for the direct `ctx.llm.stream` summary call (`purpose: 'compaction'`). |
| `preserveRecent` | `5` | Number of newest surface nodes never auto-compressed. |
| `dedupEnabled` | `true` | Offer DCP-style dedup suggestions in `dcp_status`. |
| `purgeErroredTurns` | `4` | Offer purge suggestions for the N most recent errored turns. |
| `protectedTools` | `[]` | Tool names whose call/result pairs are never compressed. |
| `protectUserMessages` | `false` | Keep every user message verbatim (never compress them). |
| `summaryPrompt` | built-in | Full prompt template; `{content}` is replaced with the span text. |
| `modelContextLimit` | auto-probed | Explicit context window (tokens) that wins over model probing. |
| `autoNudge` | `true` | Enable the threshold advisory nudge. |
| `autoTools` | `true` | Register `compress` and `dcp_status` model tools. |

## Behavior

- **Threshold prompting** — a short advisory nudge is injected once the
  surface usage crosses `thresholdRatio`. The system prompt section explains
  the `compress` tool (`range`/`message` modes) and points at `dcp_status`.
- **Mandatory auto-compaction** — when usage reaches `mandatoryRatio` (or the
  provider confirms `context-overflow`), the engine auto-compacts the largest
  compressible span with an engine-written summary. This is a **hard safety
  net**, gated once per turn.
- **`/compact`** — engine-driven LLM summary of the largest compressible span,
  serialized against driver turns via `runMaintenance`; failures surface as
  classified `ManualCompactionError`s (`busy`, `cancelled`, `changed`,
  `summary`, `commit`).
- **DCP-inspired suggestions** — `dcp_status` reports dedup (repeated tool
  outputs) and purge (errored turns) candidates plus the current pressure and
  compressible ranges.
- **Safety** — direct paths refuse to shadow compaction checkpoints or the
  latest user message; configured protected tools and (optionally) every user
  message are never compressed; tool-call/result pairs stay balanced; the
  durable `compaction/start` lock is opened *before* summarization and always
  released (success or recorded failure).

## Development

```bash
npm install
npm run typecheck
npm test        # node --import tsx --test tests/*.test.ts
npm run build
```

## License

MIT
