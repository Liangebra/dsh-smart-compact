[**English**](README.md) · [**简体中文**](README.zh.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-1f6feb.svg)
[![CI](https://github.com/Liangebra/dsh-smart-compact/actions/workflows/ci.yml/badge.svg)](https://github.com/Liangebra/dsh-smart-compact/actions/workflows/ci.yml)

# dsh-smart-compact

A custom [`CompactionEngine`](https://github.com/deepseek-ai/deepseek-harness) backend for the
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


## Upstream compatibility

This release targets DSH `0.2.3-alpha.2` and Node.js 24+. The exact published DSH packages are pinned in the manifest and lockfile. CI installs the checked-in dependency graph, type-checks, tests, builds, and checks the package contents. Compatibility with later releases and real-provider end-to-end sessions is not yet established. The npm bundle targets base-backed profiles; the manual mount example below is an alternative. See the [upstream compaction reference](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction/compaction-basic).

## Install (TUI / CLI profiles)

Once the npm version is published, install into the **same profile as your existing TUI**:

```bash
dsh plugin --profile tui add dsh-smart-compact@0.2.1
dsh --profile tui
```

If your TUI uses a different profile name (for example `dsh-tui` or `pi-tui`), substitute it in both commands. The package declares a DSH bundle that disables the base `compaction-basic` row and mounts `compaction-smart`; it does not install a terminal frontend. `/compact` continues to use the active compaction backend. Set options by overriding the `compaction-smart` row in that profile's `cordis.patch.yml`.

To uninstall, run `dsh plugin --profile tui remove dsh-smart-compact` and restart the profile. Do not manually mount a second backend in the same scope. This bundle targets base-backed profiles running DSH 0.2.3-alpha.2; independently isolated backends (such as some Web presets) need separate overrides.

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
| `headroomTokens` | `4096` | Additional input headroom after reserving the routed model's output budget. |
| `mandatoryRatio` | `0.9` | At/above this the engine auto-compacts the largest compressible span once per turn. |
| `summarizationMaxTokens` | `8192` | Generation cap for the direct `ctx.llm.stream` summary call . |
| `preserveRecent` | `5` | Number of newest surface nodes protected from compression. |
| `dedupEnabled` | `true` | Offer DCP-style dedup suggestions in `dcp_status`. |
| `purgeErroredTurns` | `4` | Offer purge suggestions for errored calls at least N turns old; zero disables them. |
| `protectedTools` | `[]` | Tool names whose call/result pairs are never compressed. |
| `protectUserMessages` | `false` | Keep every user message verbatim (never compress them). |
| `summaryPrompt` | built-in | Full prompt template; `{content}` is replaced with the span text. |
| `modelContextLimit` | auto-probed | Explicit context window (tokens) that wins over model probing. |
| `autoNudge` | `true` | Enable the threshold advisory nudge. |
| `autoTools` | `true` | Register `compress` and `dcp_status` model tools. |

## Behavior

- **Threshold prompting** — a short advisory nudge is injected once the
  estimated total input usage crosses `thresholdRatio`. The system prompt section explains
  the `compress` tool (`range`/`message` modes) and points at `dcp_status`.
- **Mandatory auto-compaction** — when usage reaches `mandatoryRatio` (or the
  provider confirms `context-overflow`), the engine auto-compacts the largest
  compressible span with an engine-written summary. This is a **hard safety
  net**, gated once per turn for normal pressure; overflow recovery retries only after durable surface progress, at most once until a successful response or idle state.
- **Model switching** — price the proposed routed request including its reserved output tokens, try up to three safe reductions, and reject a switch if the mandatory threshold cannot be met. Summaries use the last model that actually answered, when available.
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
npm ci
npm run typecheck
npm test        # node --import tsx --test tests/*.test.ts
npm run build
```

## License

MIT
