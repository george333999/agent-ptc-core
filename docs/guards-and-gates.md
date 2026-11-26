# 守卫与门禁：哪些机制在阻止错误，哪些在阻止不划算的操作

这份文档把散落在各模块里的“守卫（guard）”和“门禁（gate）”集中说明，回答三个问题：**它拦什么、什么时候拦、拦不住时怎么降级**。

> 守卫与门禁不是锁。锁解决“同时写同一资源会互相覆盖”的互斥问题；守卫解决“结果不可信或任务没真正完成”；门禁解决“这件事值不值得做”。三者经常同时出现，但职责不同。

## 1. 一张表看全

| 名称 | 类型 | 触发点 | 不满足时 | 代码 | 详细说明 |
| --- | --- | --- | --- | --- | --- |
| 任务契约自检 | 守卫 | 复杂任务开始前 | 缺少完成判据时以 `expectedOutput` 验收并标记 `partial` | `server/task-contract.js` | 本文 §3.1 |
| 交付物守卫 | 守卫 | 每轮结束时 | 继续提醒，直到真实产物落盘；只写脚本不算完成 | `server/deliverable.js` | 本文 §3.2 |
| 上下文守卫 | 守卫 | 供应商返回上下文超限 | 按真实上限收紧视图并重试；仍失败返回可读错误 | `server/context-guard.js` | 本文 §3.3 |
| 计划闸门 | 门禁 | Agent 第 0 步 | 复杂任务先只暴露计划工具，再放行真实工具 | 主仓库 `server/agent.js` | [plan-gate.md](plan-gate.md) |
| 压缩闸门 | 门禁 | 历史裁剪点 | 通过 70% 水位、结束阶段、预测溢出、区间与摘要检查才压缩 | `server/history-compact.js` | [compaction.md](compaction.md) |
| PTC 静态校验恢复 | 守卫 | `ptc_run` 语法校验失败 | 前 2 次带行号纠错，第 3 次降级到直连只读工具 | `server/ptc/validation.js`、`server/ptc/ast-validator.js` | [ptc.md](ptc.md) |
| PTC 预算决策 | 门禁 | 单次 `ptc_run` 100 次调用用尽 | 让用户选择继续 PTC、切换直连或补充要求 | `server/ptc/budget-decision.js` | [ptc.md](ptc.md) |
| 写入守卫 | 守卫 | `write_file` / `edit_file` | 单次 8000 字符硬上限；12000 字符视为截断；重复写直接返回 `unchanged`；同脚本最多 3 个版本 | 主仓库 `server/agent.js` 与工具层 | 本文 §3.4 |
| 工具调度屏障 | 守卫 | 同轮多个工具调用 | 审批、未知命令、未知工具、版本脚本作为屏障，禁止并发绕过 | `server/tool-scheduler.js` | [concurrency.md](concurrency.md) |
| 验证 stale 重跑 | 守卫 | 验证运行期间输入被修改 | 最多重跑 2 次，仍变化则标记 stale，避免把旧结论当通过 | `server/verify-scheduler.js` | [concurrency.md](concurrency.md) |
| 编排经济性门禁 | 门禁 | 启动并行子 Agent 前 | 预估加速比不足或 token 增量收益为负时拒绝并行，回退串行 | `server/orchestration-economics.js` | 本文 §3.5 |
| 短会话 PTC 门禁 | 门禁（未启用） | 预计 ≤10 轮且首轮 ≤2 个小文件 | 方案是改走原生只读工具；当前未启用，避免会话粘性波及中长任务 | 主仓库 `resolveTurnToolMode` | [ptc.md](ptc.md) |
| 空转与重复调用守卫 | 守卫 | 连续失败、重复调用、递增读取、重复写 | 先停止工具调用、给模型收尾机会；必要时进入恢复流程，不直接抛异常 | 主仓库 `server/agent.js` | 本文 §3.6 |

## 2. 执行顺序

```text
用户消息
  → 任务契约：明确真实目标与完成判据
  → 计划闸门：复杂任务先列 3–6 步计划
  → 单轮上下文：预取、冷事实、产出索引、任务备忘
  → 模型返回工具调用
      → 工具调度屏障：审批 / 未知命令 / 版本脚本先串行
      → 资源锁：文件、目录、工作区三级互斥
      → 执行工具
      → PTC 校验与预算：语法纠错、调用预算决策
  → 交付物守卫：检查用户要求的产品是否真实存在
  → 验证调度：输入变则 stale 重跑，合并相同验证
  → 最终回答
```

守卫失败时只有三种结局：**阻止**（审批、锁冲突、PTC 语法错误）、**修复**（纠错、stale 重跑、空转恢复）、**降级**（上下文超限压缩后重试、PTC 失败切直连）。不允许“静默通过”。

## 3. 逐项说明

### 3.1 任务契约自检

**拦什么**：任务目标理解错误、完成判据缺失、子 Agent 各自假设分裂。

**怎么做**：主 Agent 在复杂任务上回答五个固定问题（真实目标、已知/未知/假设、最可能失败点、方法取舍、下一步与委托），把完成判据和关键假设归一化后下发给子 Agent。自检块只追加到当前用户消息尾部，不改 system/tools 前缀。子 Agent 不再自问，只消费契约。

**降级**：没有完成判据时，以 `expectedOutput` 作为验收标准并标记 `partial`，而不是假装完成。

### 3.2 交付物守卫

**拦什么**：用户要 Excel，模型只写了生成脚本；用户指定 `reports/items.xlsx`，模型写到别的路径；模型生成后又把产物删掉。

**怎么做**：只识别动作词之后的目标片段，例如“读取 a.xlsx 转成 csv”只要求 csv，避免把输入文件当交付物；支持 xlsx/pptx/docx/pdf/csv/html/json，并提取用户指定的输出路径。工具成功落盘后按扩展名标记完成，未满足时继续提醒。

**效果**：同窗 ABBA 长对话中，传统版在 03:41 的 run 里 11 个 Excel 任务全部“生成 xlsx → 转 CSV → 删除 xlsx”，交付物缺失，准确率只有 84.3%；优化版同窗口 99.3%。这不是测评脚本误判，而是缺少交付物守卫的真实失败。

### 3.3 上下文守卫

**拦什么**：请求超过供应商上下文上限，直接返回 400，长任务在最后一刻失败。

**怎么做**：识别 `maximum context length` 类错误，从错误文本解析真实上限，按 70% 目标压缩请求视图后重试；重试耗尽或没有可压缩内容时返回可读错误。

**边界**：它是最后兜底，不替代历史预算与动态压缩；压缩会丢失细节，所以正常路径应尽量不发生。

### 3.4 写入守卫（主仓库）

**拦什么**：半写文件、重复整篇重写、单次输出过大导致 JSON 截断、同脚本无限版本。

**怎么做**：

- 临时文件 + `rename` 原子替换，失败回滚；`write_file` 与 `edit_file` 都走同一路径。
- 写入内容与现有文件完全相同时直接返回 `unchanged`，不重复写盘；连续 4 次相同写入才触发停止。
- 单次写入超过 8000 字符直接拒绝，提示用 `append: true` 分段；单次参数超过 12000 字符判定为模型输出截断，不再按普通 JSON 错误重试。
- 同一脚本主干本轮最多 3 个版本，第 4 个版本拦截并进入恢复流程。

**边界**：这些规则在 AgentProject 主仓库的代理循环与工具层，内核抽取版只包含锁、调度与交付物模块，不包含 `write_file` 实现。

### 3.5 编排经济性门禁

**拦什么**：“为了并行而并行”——任务拆得太细、写集合重叠、前缀构建成本高于节省的时间。

**怎么做**：启动 worker 前估算加速比与 token 增量；默认只做建议（`advisory`），`mode: 'enforce'` 时才在不划算时返回 `allowed: false`。写集合互斥、软截止与对冲由 `task-scheduler.js` 配合。

**边界**：收益依赖历史耗时校准；没有历史数据时估算会偏保守。

### 3.6 空转与重复调用守卫（主仓库）

**拦什么**：同一个工具/参数反复调用、逐行递增读取、同一文件反复整篇重写、连续命令失败。

**怎么做**：第 3 次重复提示模型不要重复；第 5 次停止并进入恢复流程。检测到空转后不直接抛异常，而是先停止工具调用、给模型一次收尾机会，最终返回包含停止原因、已生成文件、失败信息与下一步建议的正常结果。

**边界**：守卫只负责止损，不负责把任务做对；恢复流程仍需真实生成交付物。

## 4. 为什么守卫和门禁要分开

- **守卫是正确性问题**：结果不可信时必须阻止、修复或降级，不能静默通过。
- **门禁是经济性问题**：操作本身能做，但不值得做；拒绝或推迟不会让结果错误。
- 两者都必须**缓存友好**：提醒只追加到当前用户消息尾部，不重写 system/tools；检查是幂等的，同一轮最多提醒一次。
- 两者都必须**可观测**：计划闸门记录触发/跳过原因，压缩记录 `belowOverflow / projectedNoOverflow / finalPhase`，交付物守卫记录缺口，验证调度记录 stale 与重跑次数。

## 5. 已知边界

1. 内核抽取版不包含主仓库的 `server/agent.js` 代理循环，因此计划闸门、写入守卫、空转守卫是**参考实现与文档**，不是 npm 包强制执行的逻辑。
2. 交付物守卫只覆盖常见格式与动作词；过于口语化或省略目标的请求仍需要调用方补充规则。
3. 计划闸门依赖复杂度评分；用户已给出明确产物路径时直接执行，这是闸门很少触发的正常原因。
4. 动态压缩无法判断信息价值，只控制水位、体积、区间与摘要长度；结束阶段与预测跳过减少无收益压缩，但不能消除信息损失风险。
5. 短会话 PTC 门禁目前未启用；绝对收益约 ¥0.017/10 轮会话，优先级低于减少 LLM 往返与保持前缀稳定。

## 6. 代码与测试索引

| 内容 | 代码 | 测试 |
| --- | --- | --- |
| 任务契约 | `server/task-contract.js` | `test/task-contract.test.js` |
| 交付物守卫 | `server/deliverable.js` | `test/deliverable.test.js` |
| 上下文守卫 | `server/context-guard.js` | `test/context-guard.test.js` |
| 压缩闸门 | `server/history-compact.js` | `test/history-compact.test.js`、`test/history-compact-simulation.test.js` |
| PTC 预算决策 | `server/ptc/budget-decision.js` | `test/ptc-budget-decision.test.js` |
| PTC 校验恢复 | `server/ptc/validation.js`、`server/ptc/ast-validator.js` | `test/ptc-recovery.test.js` |
| 工具调度屏障 | `server/tool-scheduler.js` | `test/tool-scheduler.test.js` |
| 验证 stale 重跑 | `server/verify-scheduler.js` | `test/verify-scheduler.test.js` |
| 编排经济性门禁 | `server/orchestration-economics.js` | `test/orchestration-economics.test.js` |
| 轮次与收尾预算 | `server/limits.js` | `test/limits.test.js` |
