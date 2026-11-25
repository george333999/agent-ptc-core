# 机制全景：每个模块解决什么问题

这份文档回答三个问题：**框架里有哪些机制、每个机制在什么位置生效、它们之间如何互相约束**。阅读顺序建议先看“请求生命周期”，再按需跳到具体机制。

所有描述以当前 `0.5.0` 代码为准；旧版 `0.1.0`–`0.4.0` 的行为差异见 `CHANGELOG.md` 与 Gitee 提交历史。

## 请求生命周期中的位置

```text
用户消息
  │
  ├─ 1. 任务契约（复杂任务自检、完成判据、关键假设）
  ├─ 2. 单轮上下文装配（预取 / 冷事实 / 产出索引 / 备忘 / 短会话降级）
  ├─ 3. 历史窗口（按模型窗口推导上限，滞后裁剪，user 对齐）
  ├─ 4. 稳定前缀（system + tools 字节稳定，前缀指纹）
  │
  ├─ 模型调用（重试、限流、上下文超限治理）
  │      │
  │      └─ 多个工具调用
  │            ├─ 5. 同轮工具调度（路径依赖、屏障、并发上限）
  │            ├─ 6. PTC 批量只读（沙箱内一次完成多次读/搜）
  │            ├─ 7. 资源锁 + 命令作用域 + 验证调度
  │            └─ 8. 工具结果蒸馏 / 限流 / 回读
  │
  └─ 9. 交付物验收（按扩展名与产物内容判断是否真正完成）
        10. 延迟归因与缓存指标
        11. 分组基准（离线复现）
```

下面按机制说明。

---

## 1. 稳定前缀与缓存指纹

**解决的问题**：供应商的前缀缓存按“公共前缀”计费。system prompt、工具 schema 或历史中间任意一个字节变化，从变化点开始的内容都会重新计价。

**关键实现**

- `server/prefix.js`：`stableStringify` 按字典序序列化对象键；`hashText`、`buildCachePrefix`、`buildRequestFingerprint`、`commonPrefixRatio` 用于记录和比较前缀。
- `server/tool-order.js`：工具定义按工具名字节序排序，避免不同构造路径产出不同顺序。
- 所有动态内容（时间、进度、预取块、摘要）只追加到用户消息尾部，不插入 system/tools 或历史中间。

**与其他机制的关系**：历史裁剪、上下文引擎、工具结果蒸馏都会改变消息体；它们必须遵守“只追加、不回改”的约束，否则前面的前缀优化失效。

**代价与边界**：前缀稳定不减少 token 总量，只保证新增内容按未命中计价、旧内容按命中计价。它不能修复供应商侧缓存策略差异。

**验证**：`test/prefix.test.js`、`test/tool-order.test.js`、`test/cache-simulation.test.js`。

---

## 2. 历史窗口与按模型窗口推导预算

**解决的问题**：每一步都做滑动窗口会让窗口起点不断后移，前缀每步都变；一次裁得太少又会导致很快再次触发裁剪。

**关键实现**

- `DEFAULT_HISTORY_LIMITS`：兼容旧调用的 48/64 条、60k/150k 字符窗口。
- `historyLimitsForContext(contextWindow)`：按模型窗口推导“尽量不裁剪”的预算——硬上限为窗口的 97%（按 2.5 字符/token 保守换算），软上限为硬上限的 50%。一次裁得足够多，换取更长的下一次裁剪间隔。
- `shouldTrimHistory`：只有超过硬上限，且距离上次裁剪达到 `hard - soft` 间隔时才裁剪。
- `applyHistoryWindow`：裁剪起点向前对齐到最近的 user 消息，不把一轮对话拦腰截断。
- `resolveLaggingWindow`：跨轮复用上一次裁剪基准，保证新轮首个请求是上一轮末尾请求的前缀。

**与其他机制的关系**：裁剪会触发 `window-context` 重建被挤出轮次的摘要，并让 `turn-context` 的复用锚点失效；因此应尽量少裁剪。`context-policy.shouldTrimAtStep` 把轮内紧急裁剪阈值设为 97%，常规轮次只在轮边界裁剪。

**代价与边界**：窗口越大，单次请求越大；超过模型真实上限时由 `context-guard` 兜底压缩。裁剪点一旦发生，缓存必然重建一次，这是无法避免的代价。

**验证**：`test/history-window.test.js`、`test/window-v4.test.js`、`test/context-policy.test.js`。

---

## 3. 单轮上下文引擎

**解决的问题**：长对话的成本不只来自历史长度，还来自每轮临时注入的文件内容、旧事实和索引。

**关键实现**（统一入口 `server/turn-context.js`）

- **预取** `context-prefetch.js`：只有用户消息里出现明确路径、行范围或符号时才读正文；否则只给“路径 + 指纹 + 行数”的工作区索引。文件未变化时按 mtime/size/hash 短路。
- **冷事实** `cold-facts.js`：用户引用旧轮次时，从历史工具调用里抽取已确认事实补回，避免窗口裁剪后丢失信息。
- **产出索引** `artifact-index.js`：记录本轮生成或修改的文件摘要，后续引用直接复用，不重复读全文。
- **任务备忘** `task-memo.js`：同一任务签名重复出现且重复率达到阈值时，注入上一次的结论摘要。
- **短会话降级** `resolveTurnContextBudget`：前 3 个用户轮次把索引条目 240→120、预取总量 8000→4000 字符、事实/产出块 1000→400 token，避免固定注入成本在短会话里摊不薄。
- **复用去重**：同一会话内内容未变、且上一条注入消息仍在窗口内时，本轮只写一行引用，不重复注入正文。
- **窗口摘要** `window-context.js`：窗口推进时重建被挤出轮次的确定性摘要，并追加到最后一条用户消息。

**与其他机制的关系**：所有注入块都追加在稳定前缀之后；窗口裁剪后必须 `resetTurnContext`，否则会引用已经被裁掉的消息。`contextEngine === false` 时整体退化为传统全量历史模式，用于基准对照。

**代价与边界**：短会话里注入收益有限；预取读取本身有磁盘成本；任务备忘需要累计重复率，单次任务不会触发。

**验证**：`test/context-prefetch.test.js`、`test/cold-facts.test.js`、`test/task-memo.test.js`、`test/turn-context.test.js`、`test/window-context.test.js`。

---

## 4. 工具结果蒸馏、限流与回读

**解决的问题**：工具输出原样回灌会挤满上下文，模型还要多跑几轮才能拿到需要的部分。

**关键实现**（`server/tool-result.js`）

- 超过预算的结果完整落盘，历史只保留结构化摘要和 `result_id`：工具名、字符数、行数、字节数、JSON 结构、少量预览。
- `read_tool_result` 支持按行、字符区间、JSON Path 精确回读。
- 注入限流：超过单步注入上限时只注入头部与尾部，中间落盘，避免单个大结果把后续每一步的 prefill 都放大。
- 安全边界：常见密钥格式脱敏、结果目录路径越界校验、30 天 TTL、落盘失败自动退回完整内容。

**与其他机制的关系**：蒸馏发生在“工具结果写入历史”的那一刻，之后不再改写旧消息，避免破坏前缀缓存。回读会增加一轮模型往返，所以短结果不蒸馏。

**代价与边界**：摘要必须保留足够定位信息；模型如果忽略 `result_id` 直接推断，会产出错值，需要在提示词和验收层双重约束。

**验证**：`test/tool-result.test.js`、`test/token-opt.test.js`。

---

## 5. PTC 程序化只读工具

**解决的问题**：模型每读一个文件就发起一次工具调用，文件密集任务会在“读—看—再读”上消耗大量往返。

**关键实现**（`server/ptc/`）

- 模型写一小段受控 JavaScript，在沙箱里一次完成列目录、批量读文件、搜索、知识库检索和技能读取，只返回聚合结果。
- 语法层：基于 acorn 的 AST 校验，禁止 `class`、`import`、`this`、`process`、动态属性访问；`new` 仅允许标准内置对象。
- 执行层：独立 worker + `node:vm`，无网络、无写文件、无 shell，单次运行有超时和调用次数上限。
- 接口层：只暴露类型化只读 API（`files.list/read/readMany/search`、`knowledge.search`、`skills.read`），参数逐个校验类型、范围、未知键和路径穿越。
- 预算与恢复：100 次工具调用预算用尽时提供继续/切换原生/用户输入三选一；静态校验失败自动纠错 2 次，连续 3 次失败降级到直连只读工具。

**与其他机制的关系**：PTC 是只读沙箱，不参与资源锁；写文件、编辑、命令、MCP 与子 Agent 仍走直连工具。PTC 结果作为普通工具结果进入蒸馏/限流流程。

**代价与边界**：批量代码质量依赖模型能力；单次结果上限 24000 字符，程序内应先聚合再返回；小模型应减少单次全文数量。

**验证**：`test/ptc-edge.test.js`、`test/ptc-search.test.js`、`test/ptc-budget-decision.test.js`、`test/ptc-recovery.test.js`。

---

## 6. 同轮工具并发调度与并行只读

**解决的问题**：模型一轮返回多个工具调用时，全部串行会浪费墙钟；全部并发又会让“写后读”和同路径写互相覆盖。

**关键实现**

- `server/tool-scheduler.js`：按路径依赖把调用分成“可并发”和“屏障”。不同路径写可并发，同路径写串行；写后读同一文件等待写入；目录扫描与子文件写按祖先关系排序；带确定 scope 的 `run_command` 是 verify 节点；未知命令、需要审批的调用、未知工具是屏障；`_v43.py` 这类同脚本多版本写入强制走屏障。
- `server/parallel-tools.js`：只读工具的并行批次与单调用失败隔离。
- 并发上限默认 4，`AGENT_TOOL_CONCURRENCY=0` 可退回仅连续只读并发。

**与其他机制的关系**：调度器只决定顺序，真正的互斥仍由资源锁保证；两者组合才能既快又不会互相覆盖。PTC 内部批量读取不经过调度器。

**代价与边界**：并发会放大瞬时磁盘与内存压力；依赖推断错误时宁可回退串行。

**验证**：`test/tool-scheduler.test.js`、`test/parallel-tools.test.js`。

---

## 7. 资源锁、命令作用域与验证调度

**解决的问题**：多个工具同时读写同一文件会出现写覆盖写，以及读取到写了一半的内容；验证也可能读到过期输入。

**关键实现**

- `server/resource-locks.js`：以工作区相对路径为键，文件与目录粒度读写锁。读锁可并发，写锁互斥；目录锁覆盖子孙路径；写者优先；同一请求内读写同一路径自动升级为写锁，避免 `LOCK_UPGRADE` 自锁。
- `server/command-scope.js`：从 `node --test`、`pytest`、`go test ./pkg/...`、`tsc -p` 等命令推断读写集合；无法判断时回退到工作区全局锁；只有显式 scope 才被视为完整输入。
- `server/verify-scheduler.js`：同命令同作用域的并发验证合并；执行前快照输入版本，写操作递增版本，验证结束时发现输入变化就标记 stale 并重跑；不同作用域可并行；缓存命中与执行都返回 `waitMs`，便于延迟归因。

**与其他机制的关系**：推断 scope 可能漏掉被 import 的源码，因此只有显式 scope 的验证结果允许缓存（`cacheable`）。锁是进程内锁，不跨进程或跨机器。

**代价与边界**：锁粒度越细并发越高，但冲突判定越复杂；跨进程场景需要文件锁或外部协调服务。

**验证**：`test/resource-locks.test.js`、`test/command-scope.test.js`、`test/verify-scheduler.test.js`、`test/locks.test.js`。

---

## 8. 任务契约与交付物约束

**解决的问题**：长任务失败往往不是模型不会做，而是做偏了：把“生成 Excel”理解成“写脚本”，或者把输入文件当成交付物。

**关键实现**

- `server/task-contract.js`：复杂任务先回答五个固定问题（真实目标、已知/未知/假设、最可能失败点、方法取舍、下一步与委托），把完成判据与关键假设归一化，并在派发子 Agent 时下发。自检块只追加到当前用户消息尾部；子 Agent 不自问，避免假设分裂。
- `server/deliverable.js`：只识别动作词之后的目标片段（“读取 a.xlsx 转成 csv”只要求 csv），支持 xlsx/pptx/docx/pdf/csv/html，并提取用户指定的输出路径。

**与其他机制的关系**：契约只用于提醒和验收，不替代执行；工具成功落盘后按扩展名标记完成。交付物验收与上下文引擎独立，避免“注入改了但产物没生成”。

**代价与边界**：只识别常见格式与动作词；过于口语化或省略目标的请求仍可能需要调用方补充规则。

**验证**：`test/task-contract.test.js`、`test/deliverable.test.js`。

---

## 9. 上下文超限与 LLM 限流治理

**解决的问题**：长任务在最后一刻可能因为超过供应商上下文上限直接失败；高峰期 429 会让并发请求互相拖垮。

**关键实现**

- `server/context-guard.js`：识别 `maximum context length` 类错误，从错误文本解析真实上限，按 70% 目标压缩请求视图后重试；重试耗尽或无可压缩内容时返回可读错误。
- `server/llm-governor.js`：只包裹“建立请求 + 读取响应头”。自适应并发在 429 时减半、连续成功后逐步恢复；无 `Retry-After` 时用 full jitter 指数退避；服务端给出长等待时打开熔断。SSE 开始后不再重试，避免重复计费或重复输出。

**与其他机制的关系**：上下文治理是最后兜底，不应替代历史预算；限流只影响请求建立，不改变 Agent 决策。

**代价与边界**：压缩会丢失细节；熔断期间请求会快速失败，需要调用方决定重试或降级。

**验证**：`test/context-guard.test.js`、`test/llm-governor.test.js`。

---

## 10. 子任务调度与经济性门禁

**解决的问题**：并行子 Agent 不一定更快：拆分过细会增加前缀构建、调度和汇总成本。

**关键实现**

- `server/task-scheduler.js`：任务时长校准、粒度校验、写集合互斥、软截止与对冲。
- `server/orchestration-economics.js`：估算加速比、token 开销与串行回退结果；`mode: 'enforce'` 时不划算会返回 `allowed: false`。
- `server/orchestration-report.js`：编排结果、冲突与资源使用的可读报告。
- `server/orchestration-metrics.js`：中位数、分位、长尾比、并行效率与 worker 缓存摘要。
- `server/worker-prompt.js`：子 Agent 提示词、工具白名单与结果回传格式。

**与其他机制的关系**：子 Agent 复用字节一致的共享前缀；缺少完成判据时以 `expectedOutput` 验收并标记 `partial`。经济性门禁在真正启动 worker 之前执行。

**代价与边界**：收益估算依赖历史数据；任务粒度太小或写集合重叠时，串行更划算。

**验证**：`test/task-scheduler.test.js`、`test/orchestration-economics.test.js`、`test/orchestration-report.test.js`、`test/worker-prompt.test.js`。

---

## 11. 延迟归因、缓存指标与可复现基准

**解决的问题**：优化必须有可观测指标，否则容易把供应商波动误判为代码收益。

**关键实现**

- `server/latency-metrics.js`：把单轮墙钟拆成首字等待、解码、工具、落盘、审批等待、编排与未归因残差；`durationMs` 扣除用户思考与审批时间；统计 PTC 覆盖率、重复读取率、按 plan/execute/finalize 阶段的调用与 token 归因、缓存是否上报。
- `server/cache-usage.js`：归一化 OpenAI、DeepSeek、Anthropic 的缓存字段；未上报时标记未知，不把本地推算的 miss 当成 0% 命中。
- `server/cache-metrics.js`：按天追加 JSONL 缓存日志，失败不影响主流程。
- `benchmark/`：五组真实基准（10/20/50/70/100 轮），优化版与传统版同模型、同任务、同提示词，按产物文件校验准确率。

**与其他机制的关系**：指标只观测，不参与调度决策；基准报告使用同一档价重算金额，避免两组运行时段跨峰谷造成 2 倍误差。

**代价与边界**：单次运行仍有波动；样本量有限时结论应看趋势；金额为按 token 的估算值，不等同于最终账单。

**验证**：`test/latency-metrics.test.js`、`test/cache-usage.test.js`、`test/cache-metrics.test.js`、`test/benchmark-metrics.test.js`。

---

## 默认开关与适用场景

| 机制 | 默认 | 关闭方式 | 最适合的场景 |
| --- | --- | --- | --- |
| 稳定前缀 | 开 | 不建议关闭 | 所有长对话 |
| 按窗口推导历史预算 | 由调用方选择 | 传旧版 48/64、60k/150k 的显式 limits | 128k 以上窗口、长会话 |
| 单轮上下文引擎 | 开 | `contextEngine: false` | 多文件、连续任务 |
| 工具结果蒸馏 | 开（按预算） | `toolResultDistill: false` | 大文件读取、日志 |
| PTC | 可选 | 使用原生 tools | 文件密集、批量只读 |
| 同轮工具调度 | 开 | `AGENT_TOOL_CONCURRENCY=0` | 一轮多工具调用 |
| 资源锁/验证调度 | 调用方接入 | 单线程只读任务 | 并发写、测试验证 |
| 任务契约/交付物 | 开 | `socraticBrief: false` 或自定义规则 | 复杂任务、办公交付物 |
| 上下文治理/限流 | 开 | 不推荐 | 长任务、高峰期 |
| 子任务经济性门禁 | advisory | `mode: 'enforce'` 可强制执行 | 多 Agent 编排 |
| 指标与基准 | 开 | 生产可只保留日志 | 优化评估、回归 |

## 常见误用

- 每轮都滑动窗口：前缀每步都变，缓存命中率会崩。
- 在 system prompt 里拼时间戳或任务 ID：所有请求头部都不同。
- 把 `write_file` 的历史参数替换成占位符：模型会模仿占位符，污染真实产物。
- 对短工具结果也强制蒸馏：多一次回读往返，墙钟反而增加。
- 把推断出的命令 scope 当作完整输入并缓存验证结果：可能漏掉被 import 的源码。

## 与旧版的差异（0.5.0）

- 新增 `historyLimitsForContext`：默认按模型窗口 97% 推导裁剪线，软上限取硬上限 50%。
- 轮内紧急裁剪阈值从 90% 提到 97%；轮边界降级阈值从 80% 提到 98%（调用方负责）。
- 新增 `resolveTurnContextBudget`：前 3 个用户轮次自动降低索引/预取/事实预算。
- 基准更新为五组（10/20/50/70/100 轮）、250 轮/变体，共 500 轮；旧数据归档在 `benchmark/data/legacy-2026-11-22` 与 `legacy-2026-11-23`。
- 项目名从 `Local-first Agent Workbench` 调整为 `Cache-stable Agent Core`：仓库实际是内核库，不包含 Web 工作台；Gitee 仓库路径暂时保留 `local-first-agent-workbench` 以兼容历史链接。
