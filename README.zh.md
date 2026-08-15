# dsh-smart-compact

DeepSeek Harness 的自定义 [`CompactionEngine`](https://github.com/DeepSeekAI/dsh) 后端：
可配置的**阈值提示**、达到上限时的**强制自动压缩**安全网、**DCP 风格的去重 / 清理建议**、
完全**可配置的摘要提示词**，以及保持原版行为的 `/compact` 命令。

> **为什么叫这个名字？** 三大策略族——重复工具输出去重、报错调用清理、模型驱动的
> `compress` 工具与 nudge 提示——源自 **DCP（Dynamic Context Pruning，动态上下文修剪）**，
> 即 opencode-dcp 保持长会话低成本的做法。但**机制不同**：opencode-dcp 只修剪
> 发给模型的载荷、不改动会话历史；本引擎挂在 DSH 的 `CompactionEngine` 槽位上，
> 在会话日志中写入标准的持久化压缩 bracket（零外部状态、原文永不删除）。
> "smart-compact" 命名的是机制；DCP 的血统在策略模块（`dcp.ts`）和 `dcp_status`
> 工具里。

**零外部状态。** 没有内核、没有账本文件、没有数据库、没有需要与日志保持同步的内存
状态机。每次压缩都是 append-only 会话日志里的标准持久化 bracket：

```
compaction/start  →  compaction/summary  →  user/message（surface 替换）  →  compaction/end
```

原始事件**永不删除**；块信息按需从日志重建（`rebuildBlockLedger`），所以崩溃、重启或
恢复会话后看到的状态始终一致。

## 挂载

每个 realm 只挂一个压缩后端——先禁用自带的 `compaction-basic` 行，再把它加进你的
组合文件（如 `~/.dsh/profiles/web/cordis.patch.yml`）：

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

插件以 `ctx.compaction` 注册。改完组合后重启 `dsh web`（web profile 没有 HMR）。

## 配置

| 选项 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.5` | 上下文占用达到该比例时注入建议提示（`agent/pre-step`），由模型决定是否使用 `compress` 工具。 |
| `mandatoryRatio` | `0.9` | 达到/超过该比例时引擎自动压缩最大可压缩范围（每轮一次）。 |
| `summarizationMaxTokens` | `8192` | 引擎直接调用 `ctx.llm.stream` 摘要（`purpose: 'compaction'`）的生成上限。 |
| `preserveRecent` | `5` | 最近 N 个 surface 节点永不自动压缩。 |
| `dedupEnabled` | `true` | 在 `dcp_status` 中提供 DCP 风格去重建议。 |
| `purgeErroredTurns` | `4` | 为最近 N 个报错轮次提供清理建议。 |
| `protectedTools` | `[]` | 这些工具名的调用/结果对永不压缩。 |
| `protectUserMessages` | `false` | 保留全部用户消息原文（永不压缩）。 |
| `summaryPrompt` | 内置 | 完整提示词模板；`{content}` 替换为范围原文。 |
| `modelContextLimit` | 自动探测 | 显式上下文窗口（token 数），优先于模型探测。 |
| `autoNudge` | `true` | 开启阈值建议提示。 |
| `autoTools` | `true` | 在 `ctx.tools` 注册 `compress` 与 `dcp_status` 模型工具。 |

## 行为

- **阈值提示**——surface 占用超过 `thresholdRatio` 后注入简短建议；系统提示段说明
  `compress` 工具（`range` / `message` 两种模式）并指向 `dcp_status`。
- **强制自动压缩**——占用达到 `mandatoryRatio`（或供应商确认 `context-overflow`）时，
  引擎用自写摘要自动压缩最大可压缩范围。这是**硬性安全网**，每轮只触发一次。
- **`/compact`**——引擎驱动的 LLM 摘要，压缩最大可压缩范围；通过 `runMaintenance`
  与驱动轮次串行化；失败按 `ManualCompactionError` 分类抛出
  （`busy` / `cancelled` / `changed` / `summary` / `commit`）。
- **DCP 风格建议**——`dcp_status` 报告去重（重复工具输出）与清理（报错轮次）候选，
  以及当前压力与可压缩范围。
- **安全**——直接路径绝不遮蔽压缩检查点或最新用户消息；配置的受保护工具与（可选）
  全部用户消息永不压缩；工具调用/结果配对保持完整；持久化 `compaction/start` 锁在
  摘要**之前**打开，并且总会释放（成功或记录失败）。

## 开发

```bash
npm install
npm run typecheck
npm test        # node --import tsx --test tests/*.test.ts
npm run build
```

## License

MIT
