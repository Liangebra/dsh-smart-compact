# PR 描述 — dsh-smart-compact（全新独立插件仓库）

> 目标：新建独立 GitHub 仓库 **`dsh-smart-compact`**（不要用 dsh-compact-dcp 这个名字）。
> 流程：GitHub 新建仓库 → 本地文件夹 `C:\Users\12258\dev\dsh-compact-dcp` 改名为
> `dsh-smart-compact` → 在文件夹内 `git init` → GitHub Desktop 添加本地仓库 →
> 推送到新仓库 → 仓库设置里打上 **`dsh-plugin`** topic → 可选：`npm publish` 发布。

---

**Title:** `dsh-smart-compact — 智能上下文压缩引擎（CompactionEngine 后端）`

**Description（仓库 README 已含完整内容，这里给 PR/发布摘要）:**

### 这是什么

DeepSeek Harness 的 `ctx.compaction` 自定义后端，替换官方 `compaction-basic`：

- **阈值提示（默认 50%）**：`agent/pre-step` 注入简短建议，模型自己决定是否用 `compress` 工具
- **强制兜底（默认 90%）**：模型不动手时引擎用可配置提示词自动摘要最旧范围；`context-overflow` 直接兜底（每轮一次）
- **`/compact`**：保持原版行为——引擎选最大可压缩范围 + LLM 摘要（自定义提示词），失败按 `ManualCompactionError` 分类（busy/cancelled/changed/summary/commit）
- **DCP 策略族（源自 opencode-dcp 的 Dynamic Context Pruning）**：去重（同工具+参数只留最近输出）、报错清理（N 轮后剪大输入留错误）、`dcp_status` 工具
- **保护机制**：绝不遮蔽压缩检查点、最新用户消息；可配置 `protectedTools`（工具调用/结果对）与 `protectUserMessages`（全部用户消息）

### 核心设计

- **零外部状态**：不建内核/账本/DB/旁车文件；每次压缩都是 append-only 会话日志里的标准 bracket：
  `compaction/start → compaction/summary → user/message(replace) → compaction/end`，原文永不删除；块账本从日志按需重建（`rebuildBlockLedger`）
- **持久锁安全**：`compaction/start` 在 LLM 摘要**之前**写入；任何失败（LLM/范围变动/提交阶段）都落 `compaction/end(error)`，绝不留悬挂锁
- **配对平衡**：范围切割尊重工具调用/结果配对（`toolPairingBalancedBefore/After`）
- **CJK-aware token 估算**：中文 1 字/token，其余约 4 字符/token

### 质量

- 测试 33 项（config/region/dcp/engine/tools）：typecheck ✓ / test 33/33 ✓ / build ✓
- 两轮独立安全评审 **VERDICT: PASS**（悬挂锁、状态一致性、零外部状态、直接路径保护均已验证）

### 使用

```yaml
# 同一 realm 禁用 compaction-basic 后挂载
- id: compaction-smart
  name: 'dsh-smart-compact'
  config:
    thresholdRatio: 0.5
    mandatoryRatio: 0.9
```

安装：`npm i dsh-smart-compact`（发布后）或 `npm i <你的仓库路径>`。
