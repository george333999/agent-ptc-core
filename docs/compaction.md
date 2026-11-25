# 上下文压缩（动态压缩）决策说明

本文说明上下文压缩“什么时候压缩、什么时候不压缩”的判定逻辑，以及各阈值的来源与调参入口。

> 本仓库包含 `history-compact.js`、`token-opt.js`、`history-window.js`、`context-policy.js`、`context-guard.js` 等压缩模块；`server/agent.js` 中的调用点（裁剪后搭便车、98% 紧急降级）与 `server/compaction-log.js` 位于 AgentProject 主仓库，文中相应位置已标注。

## 1. 一句话

压缩**只在窗口已经必须裁剪时搭便车执行**，并且要依次通过“70% 水位、最小体量、可压缩区间、摘要预算”四道闸；独立压缩（Phase 2）默认关闭。

## 2. 两层结构：裁剪与压缩

| 层 | 作用 | 何时发生 | 实现 |
| --- | --- | --- | --- |
| 裁剪（history window） | 把过长的历史截短 | 窗口超过硬上限，且满足滞后间隔 | `server/history-window.js` |
| 压缩（compaction） | 把旧消息换成事实摘要，保留可检索信息 | 仅当裁剪发生（Phase 1），或独立评估通过（Phase 2） | `server/history-compact.js` |

两者分离的核心原因：裁剪必然会重建请求前缀，压缩挂在这个重建点上就不会**额外**制造一次缓存失效；如果让压缩自己决定时机，每次压缩都会打断前缀缓存。

## 3. 前置：裁剪触发的条件

`historyLimitsForContext` 按上下文窗口推导字符上限（`server/history-window.js`）：

- `hardChars = max(150000, window × 0.97 × 2.5)`，`softChars = hardChars × 0.5`；
- 128k 上下文时约为硬上限 310,400 字符、软上限 155,200 字符；消息条数上限为 600 / 1200。

`shouldTrimHistory` 采用**滞后裁剪**：超过硬上限后，还要等字符量比上一次裁剪多出 `hardChars − softChars` 才真正裁剪。这样两次裁剪之间的请求前缀保持“只追加”，不会每步滑窗。

`shouldTrimAtStep` 再限制轮内时机：`step 0`（轮边界）可以正常裁剪；轮内只有上下文占用 ≥97% 才允许紧急裁剪。

> 预算口径：`historyBudget` 会排除只包含 `todo_write / propose_plan` 的 assistant 消息，但对应的 `tool` 结果仍计入；窗口基准也按同一口径记录。

## 4. Phase 1：搭便车压缩（默认开启）

`planPiggybackCompaction` 按顺序判断，任一不满足即跳过并记录原因：

| 顺序 | 条件 | 不满足时的 reason |
| --- | --- | --- |
| 1 | `tokenOpt.phase1` 开启 | `disabled` |
| 2 | 窗口 tokens ≥ 分档最小值：long 20,000 / short 10,000 / 类型未定 max(10,000, 12,000) | `tooSmall` |
| 3 | 窗口 tokens ≥ `minHistoryTokens`（默认 5,000） | `belowFloor` |
| 4 | 窗口 tokens ≥ `phase1OverflowTokens`（未显式配置时取上下文窗口的 **70%**；128k 约 89,600） | `belowOverflow` |
| 5 | 未启用“运行中租约”，或已达到溢出阈值（`suppressMidRunCompaction` 默认关闭） | `midRunLease` |
| 6 | 能选出可压缩区间：从上次覆盖末尾到**最近一条 user 消息**，目标节省 50%，最低节省比例 30% | `noRange` |
| 7 | 区间原文 ≥ `minRangeTokens`（默认 5,000） | `rangeTooSmall` |
| 8 | 摘要 ≤ `max(原文 × summaryRatio, summaryFloorTokens)`（默认 0.15 / 1,200） | `qExceeds` |
| 9 | 摘要确实比原文小 | `netNegative` |

注意第 9 条：Phase 1 不做“回读 / 重建”的成本扣减——因为这次前缀本来就要重建。因此 Phase 1 的实质门槛是**水位 + 体积 + 可压缩比例 + 摘要长度**，而不是金额不等式。

## 5. Phase 2：独立压缩（默认关闭）

`planStandaloneCompaction` 的额外条件：

| 条件 | 默认值 |
| --- | --- |
| `tokenOpt.phase2` 开启 | 默认 `false` |
| 任务类型已确定（非 pending） | — |
| 距上次压缩 ≥ `minStepsBetweenCompactions` | 5 步 |
| 评估间隔 `phase2IntervalSteps` | 每 10 步 |
| 窗口 tokens ≥ `phase2MinTokens` | 30,000 |
| 区间与摘要检查 | 同 Phase 1 第 6–8 条 |

通过上述检查后，还要满足前瞻收益不等式：

```text
(原文 tokens − 摘要 tokens) × 剩余步数  >  压缩点之后的 tokens × (未命中价 / 命中价 − 1)
```

- 左边是“剩余步数里反复省下的 token”，右边是“这一次重建前缀”的代价；
- 价格比 `k` 默认由配置价推导（默认 50）；
- `剩余步数` 优先用同类任务中位数，缺失时退回“已用步数”。**当前调用方没有传 `typeMedianSteps`，实际总是走 fallback**，因此这一步的估算偏保守。

`resolveRoundPolicy` 还会按用户消息数分档：<20 条为 short，20–40 条为 medium，>40 条为 long；中/长对话会**强制关闭 Phase 2**，避免在关键路径上反复破坏前缀缓存。

## 6. 跳过原因速查

| reason | 含义 | 常见调参方向 |
| --- | --- | --- |
| `belowOverflow` | 未到 70% 水位 | 想更早压缩就调低 `phase1OverflowTokens` |
| `tooSmall` / `belowFloor` | 窗口太小 | 一般无需调整，属于保护 |
| `noRange` / `rangeTooSmall` | 可压缩区间不足 | 检查 `minSavedRatio`、`minRangeTokens` |
| `qExceeds` | 摘要压不到目标长度 | 调整 `summaryRatio` / `summaryFloorTokens` 或摘要模板 |
| `netNegative` | 摘要不比原文小，或（Phase 2）不等式不成立 | 缩短摘要、减少 `afterTokens` |
| `midRunLease` | 运行中租约阻止压缩 | 仅在启用 `suppressMidRunCompaction` 时出现 |
| `recentCompaction` | 距上次压缩太近（Phase 2） | 调整 `minStepsBetweenCompactions` |

这些事件都由 `recordCompactionEvent` 落盘（`server/compaction-log.js`，位于主仓库），可直接统计各原因分布来调阈值。

## 7. 紧急路径

- 收到上下文长度错误时，`planContextOverflow` 决定是降级、裁剪还是压缩（`server/context-guard.js`）。
- 轮内上下文占用 ≥98% 时，先把最旧的工具结果降级为短摘要（保留最近 4 条、每条 800 字符），再考虑裁剪/压缩（`server/context-policy.js`）。
- 结束阶段（`finalPhase`）不再新增工具，但仍可能触发裁剪；目前没有“结束阶段禁止压缩”的保护。

## 8. 配置项（`settings.tokenOpt`）

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `phase1` | `true` | 搭便车压缩总开关 |
| `phase2` | `false` | 独立压缩总开关 |
| `suppressMidRunCompaction` | `false` | 轮内禁止压缩（达到溢出阈值时例外） |
| `phase1OverflowTokens` | `0`（即窗口 70%） | Phase 1 水位 |
| `phase1MinTokens` / `phase1MinTokensShort` | 20,000 / 10,000 | 分档最小窗口 |
| `minHistoryTokens` | 5,000 | 全局最小历史 |
| `phase2MinTokens` | 30,000 | Phase 2 最小窗口 |
| `phase2IntervalSteps` | 10 | Phase 2 评估间隔 |
| `minStepsBetweenCompactions` | 5 | 两次压缩最小间隔 |
| `minRangeTokens` | 5,000 | 可压缩区间下限 |
| `minSavedRatio` | 0.3 | 最低节省比例 |
| `summaryRatio` / `summaryFloorTokens` | 0.15 / 1,200 | 摘要长度上限 |

## 9. 评价与改进方向

优点：

1. 压缩不主动制造重建点，缓存友好；
2. 70% 水位 + 滞后裁剪，避免低占用时反复压缩；
3. Phase 2 用“重复收益 vs 一次性重建”的价格不等式，而不是只看 token 数；
4. 每个跳过原因都有日志，具备闭环调参基础。

不足：

1. **水位驱动而非预测驱动**：不估算“剩余步数 × 每步增量”，可能在本轮快结束时白压一次，或压得太晚；
2. **缺少结束阶段保护**：`finalPhase` 附近剩余步数很少，压缩收益必然为负；
3. **Phase 1 不计算摘要输出成本与信息损失风险**，只限制长度；
4. **阈值全部写死**（70%、20k/10k、0.3），不随任务类型、模型窗口、实际单价变化；
5. **`typeMedianSteps` 从未传入**，Phase 2 的剩余步数估算实际退化为“已用步数”；
6. `chars / 2.5` 的 token 估算对英文和代码偏高，可能提前触发。

建议优先级：

1. 预测式触发：预计本轮会触顶才提前压缩，否则推迟到下一个裁剪点；
2. 结束阶段跳过：`step >= maxSteps − finalReserve` 时禁止新压缩；
3. Phase 1 增加最小收益门槛（含摘要输出成本与风险系数）；
4. 命中率取近 N 次中位数，`k` 用真实账单价；
5. 补齐 `typeMedianSteps` 的统计来源，让 Phase 2 的前瞻估算真正可用。

## 10. 代码索引

| 内容 | 位置 |
| --- | --- |
| 裁剪上限与滞后 | `server/history-window.js`（`historyLimitsForContext`、`shouldTrimHistory`、`historyBudget`） |
| 轮内裁剪时机 | `server/context-policy.js`（`shouldTrimAtStep`） |
| Phase 1 判定 | `server/history-compact.js`（`planPiggybackCompaction`） |
| Phase 2 判定 | `server/history-compact.js`（`planStandaloneCompaction`） |
| 区间选择 | `server/history-compact.js`（`selectCompactionRange`） |
| 净收益与剩余步数 | `server/history-compact.js`（`computeNetBenefit`、`estimateRemainingSteps`） |
| 阈值与分档 | `server/token-opt.js`（`resolveTokenOpt`、`resolveRoundPolicy`、`applyRoundPolicy`） |
| 紧急降级 | `server/context-guard.js`、`server/context-policy.js` |
| 调用点（裁剪后搭便车、98% 降级） | 主仓库 `server/agent.js` 主循环 |
| 事件日志 | 主仓库 `server/compaction-log.js` |

## 11. 变更记录

- 2026-11-25：新增本文，记录现有动态压缩判定逻辑、阈值与调参入口。
