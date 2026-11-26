# 上下文压缩（动态压缩）决策说明

本文说明上下文压缩“什么时候压缩、什么时候不压缩”的判定逻辑，以及各阈值的来源与调参入口。

> 本仓库包含 `history-compact.js`、`token-opt.js`、`history-window.js`、`context-policy.js`、`context-guard.js` 等压缩模块；`server/agent.js` 中的调用点（裁剪后搭便车、98% 紧急降级）与 `server/compaction-log.js` 位于 AgentProject 主仓库，文中相应位置已标注。

## 1. 一句话

压缩**只在窗口已经必须裁剪时搭便车执行**，并且要依次通过“结束阶段、70% 水位（按裁剪前体积）、预测溢出、最小体量、可压缩区间、摘要预算”六道闸；独立压缩（Phase 2）默认关闭。

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
| 0 | 不在结束阶段（`finalPhase === false`） | `finalPhase` |
| 1 | `tokenOpt.phase1` 开启 | `disabled` |
| 2 | 窗口 tokens ≥ 分档最小值：long 20,000 / short 10,000 / 类型未定 max(10,000, 12,000) | `tooSmall` |
| 3 | 窗口 tokens ≥ `minHistoryTokens`（默认 5,000） | `belowFloor` |
| 4 | 溢出水位：优先用调用方传入的 `contextTokens`（裁剪前完整历史体积），缺失时退回窗口 tokens；需 ≥ `phase1OverflowTokens`（未显式配置时由 `applyRoundPolicy` 填为上下文窗口的 **70%**；128k 约 89,600） | `belowOverflow` |
| 5 | 未启用“运行中租约”，或已达到溢出水位（`suppressMidRunCompaction` 默认关闭） | `midRunLease` |
| 6 | 预测式跳过：轮内（`usedSteps > 0`）、已知硬上限且 `predictiveCompaction !== false` 时，按“窗口 tokens + 每步增量 × 预计剩余步数”外推；若 `projected × predictiveSafety < hardLimitTokens`，说明本轮预计不会触顶，推迟到下一次裁剪 | `projectedNoOverflow` |
| 7 | 能选出可压缩区间：从上次覆盖末尾到**最近一条 user 消息**，目标节省 `phase1TargetRatio`（默认 50%），最低节省比例 30% | `noRange` |
| 8 | 区间原文 ≥ `minRangeTokens`（默认 5,000） | `rangeTooSmall` |
| 9 | 摘要 ≤ `max(原文 × summaryRatio, summaryFloorTokens)`（默认 0.15 / 1,200） | `qExceeds` |
| 10 | 摘要确实比原文小 | `netNegative` |

三处关键修正：

- **结束阶段不再压缩**：`finalPhase` 只跳过搭便车压缩，历史裁剪照常执行；收尾阶段不再新增工具，压缩只会额外制造一次前缀重建，还可能丢掉最终答复需要的细节。
- **水位按裁剪前体积**：裁剪一次会砍到软上限（约硬上限一半），若用裁剪后的残留窗口判断，水位线永远够不着；调用方必须传 `contextTokens`。
- **预测式跳过只在轮内生效**：轮边界（`usedSteps = 0`）还不知道这一轮会长多少步，继续按水位判断，避免在轮首误判。

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
| `finalPhase` | 已进入收尾阶段，跳过搭便车压缩（裁剪仍照常） | 一般无需调整；紧急超限仍由上下文守卫处理 |
| `belowOverflow` | 裁剪前的上下文体积未到 70% 水位 | 想更早压缩就调低 `phase1OverflowTokens` |
| `projectedNoOverflow` | 轮内预测不会触顶硬上限，推迟压缩 | 调低 `predictiveSafety` 会更积极压缩；关闭 `predictiveCompaction` 可回到纯水位判断 |
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
- 结束阶段（`finalPhase`）只跳过搭便车压缩，历史裁剪与 98% 紧急降级仍照常执行；这样既避免在收尾时白压一次，又保留“不超限”的兜底。

## 8. 配置项（`settings.tokenOpt`）

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `phase1` | `true` | 搭便车压缩总开关 |
| `phase2` | `false` | 独立压缩总开关 |
| `suppressMidRunCompaction` | `false` | 轮内禁止压缩（达到溢出阈值时例外） |
| `phase1OverflowTokens` | `0`（由 `applyRoundPolicy` 填为窗口 70%） | Phase 1 水位 |
| `predictiveCompaction` | `true` | 轮内按已用步数预测剩余上下文，预计不触顶时跳过压缩 |
| `predictiveSafety` | `1.1` | 预测安全系数；>1 表示只有明确不会溢出才跳过 |
| `phase1TargetRatio` | `0.5` | 单次压缩覆盖的历史比例（按字符），越大压缩次数越少、每次越狠 |
| `phase1MinTokens` / `phase1MinTokensShort` | 20,000 / 10,000 | 分档最小窗口 |
| `minHistoryTokens` | 5,000 | 全局最小历史 |
| `phase2MinTokens` | 30,000 | Phase 2 最小窗口 |
| `phase2IntervalSteps` | 10 | Phase 2 评估间隔 |
| `minStepsBetweenCompactions` | 5 | 两次压缩最小间隔 |
| `minRangeTokens` | 5,000 | 可压缩区间下限 |
| `minSavedRatio` | 0.3 | 最低节省比例 |
| `summaryRatio` / `summaryFloorTokens` | 0.15 / 1,200 | 摘要长度上限 |

## 9. 实测效果与边界

默认配置长对话 run（70 轮，deepseek-chat，128k 窗口）：

| 指标 | 结果 |
| --- | --- |
| 压缩评估 / 应用 | 3 / 3 |
| 节省 tokens | 89,671（命中 89,298 / 未命中 373） |
| 缓存命中 | 97.2% |
| 准确率 | 100% |

强制裁剪对照（60k 历史预算，仅用于验证压缩本身，不是默认配置）：

| 配置 | 墙钟 | Token | 金额（空闲价） | 准确率 | 命中 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Phase 1 开 | 696.9s | 5.59M | ¥0.8873 | 98.6% | 92.8% |
| Phase 1 关 | 722.8s | 5.68M | ¥0.9897 | 98.6% | 92.0% |

开压缩时 token 低 1.6%、金额低 10.4%、墙钟低 3.6%。收益主要来自少发的未命中输入；历史预算充足、很少触发裁剪时，压缩次数会自然下降，机制让位于前缀稳定性。

优点：

1. 压缩不主动制造重建点，缓存友好；
2. 结束阶段跳过、预测不溢出跳过，减少无收益压缩；
3. 水位按裁剪前体积判定，避免裁剪后永远够不着水位；
4. 70% 水位 + 滞后裁剪，避免低占用时反复压缩；
5. Phase 2 用“重复收益 vs 一次性重建”的价格不等式，而不是只看 token 数；
6. 每个跳过原因都有日志，具备闭环调参基础。

不足：

1. **预测式跳过依赖剩余步数估算**：缺少同类任务中位数时仍会偏保守；
2. **Phase 1 不计算摘要作为新增输入 token 的成本与信息损失风险**，只限制长度；
3. **阈值仍以固定值为主**（70%、20k/10k、0.3），不随任务类型、模型窗口、实际单价变化；
4. **`typeMedianSteps` 在部分调用方仍未传入**，Phase 2 的剩余步数估算会退化为“已用步数”；
5. `chars / 2.5` 的 token 估算对英文和代码偏高，可能提前触发。

### 9.1 改进方案的风险评估（未改代码）

前提：压缩摘要是**确定性事实清单**，不会触发额外的 LLM 调用。因此下列方案对墙钟影响很小，真正的影响在**未命中 token、缓存命中率与金额**。当前长/超长对话命中率约 97%，0.3pp 的命中损失大约对应 7%–10% 的金额上升（未命中单价是命中的 50 倍），所以验收必须先看金额和命中率，而不是只看总 token 变少。

| 方案 | 是否影响默认配置 | 预期收益 | 主要风险 | 落地前提 |
| --- | --- | --- | --- | --- |
| 1. 预测式跳过推广到轮边界 | 会 | 少压一次、减少信息损失 | 预测偏短而实际跑得长，会再次触顶并多一次裁剪/前缀重建；一次错误跳过的缓存损失通常比“多压一次”更贵 | 稳定的 `typeMedianSteps`、方差阈值、先跑影子模式 |
| 2. Phase 1 最小收益门槛 | 会 | 跳过低价值压缩，金额持平或下降 | 窗口变大，可能更早触发下一次裁剪；命中率波动 | 把摘要按新增未命中输入计价，并把下次裁剪成本计入；同窗 A/B |
| 3. 命中率取近 N 次中位数、`k` 用真实账单价 | 不会（Phase 2 默认关闭） | 减少噪声导致的错误压缩 | 仅对手动开启 Phase 2 的用户生效；样本不足时中位数失真 | 保留 Phase 2 默认关闭；用真实价与最近样本 |
| 4. 补齐 `typeMedianSteps` 统计来源 | 不会（Phase 2 默认关闭） | 改善剩余步数估算，并为方案 1 提供数据基础 | 任务分类错误、历史数据过期 | 离线聚合、按任务类型分桶、过期回退 |
| 5. 按实际任务分布校准 70% 水位 | 会 | 减少快增长任务的溢出裁剪、避免稳定任务的过早压缩 | 分类错误会导致频繁裁剪或窗口过大，直接影响缓存命中与金额 | 先采集分布；保留 70% 兜底；按 long/xlong 同窗 A/B |

**建议落地顺序**：先做 4（数据基础）→ 3（只影响 Phase 2，风险最低）→ 2（最可能降低金额）→ 5（按分布校准）→ 最后才考虑 1。每一步先用影子模式记录“本来会不会压缩、会不会裁剪”，确认不会增加裁剪次数和未命中 token，再做同窗 ABBA。

**验收门槛**：

- 金额下降或持平；
- 缓存命中率下降不超过 0.2pp；
- 准确率不下降；
- P95 墙钟不恶化；
- 裁剪次数与压缩次数不高于基线；
- 任一条件不满足就回退，不进入默认配置。

## 10. 代码索引

| 内容 | 位置 |
| --- | --- |
| 裁剪上限与滞后 | `server/history-window.js`（`historyLimitsForContext`、`shouldTrimHistory`、`historyBudget`） |
| 轮内裁剪时机 | `server/context-policy.js`（`shouldTrimAtStep`） |
| Phase 1 判定 | `server/history-compact.js`（`planPiggybackCompaction`） |
| 结束阶段与预测跳过 | `server/history-compact.js`（`planPiggybackCompaction` 的 `finalPhase` / `predictiveCompaction` 分支） |
| 70% 水位填充与分档 | `server/token-opt.js`（`applyRoundPolicy`） |
| Phase 2 判定 | `server/history-compact.js`（`planStandaloneCompaction`） |
| 区间选择 | `server/history-compact.js`（`selectCompactionRange`） |
| 净收益与剩余步数 | `server/history-compact.js`（`computeNetBenefit`、`estimateRemainingSteps`） |
| 阈值与分档 | `server/token-opt.js`（`resolveTokenOpt`、`resolveRoundPolicy`、`applyRoundPolicy`） |
| 紧急降级 | `server/context-guard.js`、`server/context-policy.js` |
| 调用点（裁剪后搭便车、98% 降级） | 主仓库 `server/agent.js` 主循环 |
| 事件日志 | 主仓库 `server/compaction-log.js` |

## 11. 变更记录

- 2026-11-25：新增本文，记录现有动态压缩判定逻辑、阈值与调参入口。
- 2026-11-26：补入结束阶段跳过（`finalPhase`）、裁剪前体积水位（`contextTokens`）与预测式跳过（`projectedNoOverflow`）；补充默认 run 与强制裁剪 A/B 的实测数据；同步 `history-compact.js`、`token-opt.js` 与 3 个单元测试到开源仓库。
