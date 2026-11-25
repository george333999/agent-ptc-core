# 计划闸门（planGate）机制说明

本文说明 `server/agent.js` 中“计划闸门”的设计、判定条件、执行流程、配置方式与实测结论。成本 A/B 的完整数据另见 [plan-prompt-ab.md](plan-prompt-ab.md)。

> 本文件说明 AgentProject 主仓库代理循环中的计划闸门实现。本仓库对外发布的是上下文引擎模块，不包含 `server/agent.js` 代理循环；文中代码位置均指主仓库路径，供理解与移植参考。

## 1. 它是什么

计划闸门指**复杂任务的第一轮只暴露计划工具**：先让模型用 `todo_write` 列出 3–6 步计划，再放行真实工具。它由三部分配套组成：

| 组成 | 作用 | 代码位置 |
| --- | --- | --- |
| 常驻 todo 指令 | 系统提示词中的一行，建议模型对多步骤任务先列计划 | `server/agent.js` L951、L982-984 |
| 首步闸门 | 第 0 步注入“先列计划”提醒，并把工具集裁到 `todo_write / ask_user / propose_plan` | `server/agent.js` L2057-2072、L2088-2093 |
| 补救与收尾 | 模型没建计划时补一次提醒；计划全部完成时提醒收尾 | `server/agent.js` L2428-2432、L2081-2087 |

`settings.planGate = false` 会同时关掉这三部分，因此它测的是“计划相关提示的总成本”，而不是单独某一条提醒的成本。

## 2. 为什么需要，为什么又要分档

- **需要的理由**：模型在长任务上容易“边做边想”，漏步骤或提前收尾；先列计划能让进度对用户可见，也给后续步骤一个可核对的清单。
- **分档的理由**：计划本身要多一轮模型调用，还要在第 0 步压缩工具集。对刚跨过复杂线的任务（3–4 分），这轮计划经常不划算——模型本来就能一次做完。

因此阈值从“>3 分”调整为“≥5 分”：3–4 分直接执行，5 分及以上才强制先列计划。

## 3. 判定链

第 0 步是否触发，需要**同时**满足以下条件（`agent.js` L2059）：

```js
const planGateActive = agentGuardsEnabled
  && config.settings?.planGate !== false
  && !explicitDeliverable
  && shouldPlanFirst({
    step, complexTask,
    complexityScore: complexity.score,
    hasPlan,
    hasTodoTool: requestTools.some((tool) => tool?.function?.name === 'todo_write'),
    forcePptOptimize: step === 0 && canForcePptOptimize
  });
```

逐个解释：

1. `agentGuardsEnabled`：`settings.agentGuards !== false`。传统对照框架可以整体关闭守卫。
2. `settings.planGate !== false`：默认开启。
3. `!explicitDeliverable`：用户已经给出交付路径（`extractDeliverablePath(message)` 命中，如 `reports/items-6.xlsx`）时直接执行。**这条是实际使用中闸门很少触发的主要原因**——现代理请求大多会写明产物路径。
4. `shouldPlanFirst`（L540-554）内部再判断：
   - `complexTask` 为假 → 不拦。`complexTask = mode === 'agent' && complexity.tier === 'complex'`，而 `complex` 的门槛是 3 分（`server/task-complexity.js` L5-7、L83）；Chat 模式永远不拦。
   - `hasPlan` 为真 → 不拦。本轮已经建过计划，或续写轮次带了未完成的 todo，都算有计划。
   - `forcePptOptimize` 为真 → 不拦；PPT 优化路径由专门流程处理。
   - `!hasTodoTool` → 不拦；工具集里没有 `todo_write` 时闸门没有意义。
   - 复杂度分 `< 5` → 不拦。
   - 只对 `step === 0` 生效，后续步骤自动放行。

## 4. 一轮内的时序

```text
第 0 步
  ├─ 判定 planGateActive
  ├─ 追加提醒：“系统提醒：这是多步骤任务。第一步只暴露计划工具……”
  ├─ 工具集裁剪为 todo_write / ask_user / propose_plan
  └─ 模型调用
        ├─ 调用了 todo_write → planCreatedThisTurn = true
        │    第 1 步：工具集恢复全量，按计划执行
        │    计划全部 completed → 追加一次“计划已全部完成”的收尾提醒
        └─ 没有调用 todo_write → 注入一次补救提醒（每轮最多一次）
              pendingPlanNudge: “系统提醒：还没有建立计划……”
              第 1 步起恢复全量工具
```

相关细节：

- `planCreatedThisTurn` 只在 `todo_write` 成功且写入非空 todo 列表时置真（L3316-3319）。
- 收尾提醒只在**本轮**建过计划且 `isPlanComplete(session.todos)` 时触发一次，避免跨轮重复催促。
- 补救提醒放在下一轮请求的尾部，`planNudgeUsed` 保证每轮最多一次。

## 5. 复杂度分数与阈值影响面

`scoreTaskComplexity` 根据消息与附件给出 `score` 和 `tier`。基准任务集的分数分布：

| 分组 | 3 分 | 4 分 | 5 分 | 6 分 | 7 分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium（50 轮） | 12 | 29 | 0 | 8 | 1 |
| long（70 轮） | 23 | 23 | 12 | 0 | 12 |
| xlong（100 轮） | 33 | 33 | 17 | 0 | 17 |

阈值 ≥5 后，long 有 23 轮、xlong 有 33 轮的 4 分任务不再被强制先列计划；5/7 分任务维持原行为。medium 以 4 分为主，受影响面最大。

注意：分数只是必要条件，最终还要过 `!explicitDeliverable`。基准提示词大多带产物路径，所以真正触发闸门的轮次远少于上表。

## 6. 配置方式

| 方式 | 用法 | 影响 |
| --- | --- | --- |
| 配置项 | `settings.planGate = false` | 关闭常驻 todo 指令 + 首步闸门 + 两类提醒 |
| 基准参数 | `node scripts/benchmark-turns.mjs --group=long --variant=opt --runs=1 --planGate=0` | 仅优化版生效，供 A/B 使用 |
| 默认 | 不写该字段 | 视为开启（`!== false`） |

目前只有配置层开关，前端设置页没有暴露；普通使用无需关心。

## 7. 与历史裁剪的关系

计划工具调用（`todo_write` / `propose_plan`）只是过程记录：

- 在主仓库的实现中，这些 assistant 消息仍随请求发送给模型，但 `historyBudget` 会把它们从条数/字符预算中排除（主仓库 `server/history-window.js` L49-77）；
- 窗口基准也按同一口径记录（`server/window-context.js` L42-47），避免“计划消息 → 触发裁剪 → 前缀重建”的连锁；
- 计划调用对应的 `tool` 结果消息仍计入预算，体量通常只有几十字节；
- 实测这一项对总成本影响很小（long 未命中 47.4 万 vs 基线 48.8 万），保留是因为风险低，而不是因为收益大。

## 8. 实测结论

同一内核、long 70 轮 / xlong 100 轮、DeepSeek 空闲价口径，单次 A/B：

| 配置 | long 费用 | long 步数 | long 准确率 | xlong 费用 | xlong 步数 | xlong 准确率 |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| 基线（阈值 3 分） | ¥0.9659 | 295 | 70/70 | ¥1.4468 | 440 | 100/100 |
| 阈值 5 分 | ¥0.9261 | 278 | 70/70 | ¥1.5617 | 436 | 99/100 |
| 关闭闸门 + 移除 todo | ¥0.8386 | 305 | 70/70 | ¥1.0855 | 394 | 100/100 |

- 只提阈值：long −4.1%、xlong +7.9%，在同日同配置波动带内，不能当作方向性收益。
- 关闭闸门：long −13.2%、xlong −25.0%。收益主要来自常驻 todo 指令消失后 `todo_write` 调用从 24/34 次降到 0，而不是闸门本身——闸门在这批带交付路径的任务里很少触发。
- xlong 唯一失败是第 6 轮 Excel 产物校验，发生在任何裁剪之前且闸门未生效，与计划配置无关。

## 9. 典型行为

| 场景 | 是否拦 | 原因 |
| --- | --- | --- |
| 5 分 + “生成 reports/x.xlsx” | 否 | `explicitDeliverable` 为真 |
| 5 分 + 无路径 | 是 | 复杂且交付物不明确，值得先列计划 |
| 4 分 + 无路径 | 否 | 新阈值下 4 分直接执行（旧阈值会拦） |
| Chat 模式任意任务 | 否 | 只约束 Agent 任务 |
| 续写且带未完成 todo | 否 | `hasPlan` 为真 |
| 本轮已调用过 todo_write | 否 | 闸门只作用于第 0 步 |

## 10. 已知代价与调优建议

- **首步工具受限会多一轮**：模型若无视提醒去调别的工具，只会拿不到工具而重试，等于多花一次调用。补救提醒可缓解，但仍有成本。
- **提醒追加在请求尾部**：会改变尾部的缓存块，对前缀命中的影响集中在该轮的第一步。
- **阈值不宜再上调**：6–7 分任务若也不强制计划，容易在长任务里丢步骤；下调则会回到“简单复杂任务多一轮”的老问题。
- **调参前先看分布**：用 `scoreTaskComplexity` 统计目标场景的分数分布，再决定阈值；不要只看单次 A/B 的比例。
- **不要混淆开关语义**：`planGate = false` 是“关闭全部计划提示”，不是“只关首步工具裁剪”。

## 11. 测试与代码索引

相关测试（均位于主仓库）：

- `test/unit/agent-guard.test.js`：`shouldPlanFirst` 的边界（4 分不拦、5 分拦、有单/有 todo 不拦等）。
- `test/unit/history-window.test.js`：`historyBudget` 与裁剪阈值口径。
- `test/integration/agent-ptc-budget-guard.test.js`：闸门与 PTC 预算守卫的联动。

代码索引（主仓库）：

| 内容 | 位置 |
| --- | --- |
| `shouldPlanFirst` | `server/agent.js` L540-554 |
| `isPlanComplete` | `server/agent.js` L535 |
| 系统提示词条件输出 | `server/agent.js` L951、L982-984 |
| 复杂度与显式交付物判定 | `server/agent.js` L1566-1570 |
| 闸门判定与提醒 | `server/agent.js` L2057-2072 |
| 工具集裁剪 | `server/agent.js` L2088-2093 |
| 收尾提醒 | `server/agent.js` L2081-2087 |
| 补救提醒 | `server/agent.js` L2428-2432 |
| `planCreatedThisTurn` | `server/agent.js` L3316-3319 |
| 计划消息预算口径 | `server/history-window.js` L49-77 |
| 窗口基准同口径 | `server/window-context.js` L42-47 |
| 基准开关 | `scripts/benchmark-turns.mjs` L93 |

## 12. 变更记录

- 2026-11-25：新增 `settings.planGate` 开关（默认开启，行为不变）；强制计划阈值 3 分 → 5 分；计划类 assistant 消息不计入历史裁剪预算；基准脚本支持 `--planGate=0`。
