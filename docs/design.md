# dsh-smart-compact — Design (approved 2026-08-15)

自定义 DeepSeek Harness 上下文压缩引擎，挂在 `ctx.compaction` 槽位（替换官方
compaction-basic）。融合 opencode-dcp 思想，满足以下需求：

- 阈值可设（默认 50%）：达到即提示模型压缩（模型自己选、自己写摘要）
- 上限可设（默认 90%）：模型必须压缩；若模型不动作，引擎用自定义提示词自动摘要最旧范围兜底
- 硬溢出（context-overflow）：引擎直接自动摘要最旧范围（最后防线）
- `/compact` 保持原版行为：引擎自动选最旧范围 + LLM 摘要（自定义提示词）
- 摘要提示词完全可配置
- DCP 思想：去重（相同工具+参数只留最近输出）、清理报错调用（N 轮后剪大输入留错误）、保护机制（策略族源自 opencode-dcp 的 Dynamic Context Pruning，见 `src/dcp.ts` 与 `dcp_status` 工具）
- **零外部状态**：不建内核/账本/内存状态机/旁车文件；所有块信息从 append-only 会话日志重建；原文永不删除

## 架构

```
src/
├── index.ts          # SmartCompactEngine（CompactionEngine 后端）+ 接线
├── region.ts         # 范围解析/工具配对平衡 + 日志块账本重建 + 持久事务
├── summarize.ts      # LLM 摘要调用（自定义提示词）
├── compress-tool.ts  # compress（range/message 模式）+ dcp_status 工具
├── nudge.ts          # 阈值/强制提示注入（agent/pre-step）+ 范围表
├── dcp.ts            # DCP 去重 + 报错清理建议
├── prompt.ts         # 默认摘要提示词模板（可配）
├── messages.ts       # 会话事件文本投影
├── tokens.ts         # CJK-aware token 估算
└── config.ts         # 配置 schema + 校验
```

## 数据流

```
每个模型请求前 (agent/pre-step) → tokenMeter 测压（surfaceTokens / 窗口）
├─ < thresholdRatio(0.5)    → 无事
├─ [0.5, mandatoryRatio)    → 注入提示消息（建议压缩 + 范围表 + DCP 建议）
├─ ≥ mandatoryRatio(0.9)    → 注入强制提示；compactIfNeeded('pressure') 每轮一次自动兜底
└─ context-overflow         → compactIfNeeded 直接自动摘要最旧范围

模型主动：compress 工具（range/message）→ 模型写摘要 → 持久 replace
/compact  : compactNow → 引擎选最大可压缩范围 → LLM 摘要（自定义提示词）→ 持久 replace
```

## 持久化（唯一机制）

每个压缩 = 标准 bracket：`compaction/start → compaction/summary →
user/message(surfaceOp replace) → compaction/end`，全部写入 append-only 会话日志。
`compaction/start` 即持久锁，**在任何 LLM 摘要工作之前**由 `beginCompaction` 写入；
失败路径用 `abortCompaction` 落一个带 error 的 `compaction/end`（锁永不悬挂、原 surface 保留）；
成功路径 `completeCompaction` 追加 summary（含 `provider/model/sourceCommandId`，
LLM 直调路径带 `llmStreamCall: true + rawOutput`）+ 替换消息 + end。
`rebuildBlockLedger` 从日志重建块账本；`shadowedSeqsOf` 按 surface 位置取被遮蔽节点。
`runCompactionTransaction` 是 begin+complete 的同步便捷包装（模型已写好摘要的工具路径用）。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| thresholdRatio | 0.5 | 提示线 |
| mandatoryRatio | 0.9 | 强制线（可设 1.0） |
| summaryPrompt | 内置模板 | 摘要提示词（`{content}` 占位符） |
| summarizationMaxTokens | 8192 | 引擎摘要输出上限 |
| preserveRecent | 5 | 保护最近 N 条 |
| dedupEnabled | true | DCP 去重建议 |
| purgeErroredTurns | 4 | DCP 报错清理（0=关） |
| protectedTools | 空 | 永不压缩这些工具名的调用/结果对 |
| protectUserMessages | false | 保留全部用户消息原文（默认仅保护最新一条） |
| modelContextLimit | 自动探测回退 128000 | 压力计算窗口 |
| autoTools / autoNudge | true | 工具/提示开关 |

## 安全与稳定原则

- 范围选择尊重工具调用/结果配对（绝不切断）；不可分割单元宁可留着
- 摘要必须非空才落事务；LLM 失败抛错、surface 不变
- 事务全部走标准事件 + 持久锁；并发由 seam 的 lock 保证
- 强制兜底每轮一次（cadence 防抖），避免高频压缩 churn
- 零外部状态 ⇒ 无"状态不同步"类错乱；重启后从日志完整重建
- 直接路径（compactRegion / compress 工具）绝不遮蔽：压缩检查点节点、最新一条真实用户消息（enforceProtection）
- 摘要期间范围变动 → 中止 bracket 并按 'changed' 分类；/compact 失败按
  ManualCompactionError 分类（busy/cancelled/changed/summary/commit）
- 测试：33 项（config/region/dcp/engine/tools），typecheck + build 全绿

## 挂载

```yaml
- id: compaction-smart
  name: 'dsh-smart-compact'
  config:
    thresholdRatio: 0.5
    mandatoryRatio: 0.9
# 同一 realm 内需禁用 compaction-basic（二者都提供 ctx.compaction）
```
