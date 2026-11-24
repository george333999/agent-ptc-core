# Local-first Agent Workbench Core

> AgentProject 开源内核：用 PTC 批量只读工具和单轮上下文引擎减少模型往返，用缓存前缀工程把长对话命中率稳定在 90% 以上，并用进程内写锁与验证调度保证并发修改的一致性；主 Agent 自检、交付物契约和同轮工具调度保证结果真正按用户要求落盘。最新四组 820 轮真实基准下，token 低 24.4%、金额低 23.4%、耗时低 22.0%，准确率 100%。

本仓库是 AgentProject 的内核抽取版，保留十一项可独立复用的能力：长对话缓存稳定性、单轮上下文引擎、工具结果蒸馏与回读、PTC 程序化只读工具调用、子任务调度与经济性门禁、并发写锁与验证调度、同轮工具并发调度、主 Agent 任务契约与交付物约束、上下文超限与限流治理、单轮延迟归因、可复现的分组基准报告。完整工作台中的 Web 编辑器、多 Agent 运行时、MCP、OCR 与文档处理没有包含在本仓库中。

## 为什么做这个

常见 Agent 框架在短任务上表现不错，但对话一长就会同时暴露三个问题：

1. 历史每轮全量重发，token 成本随轮次线性上涨。
2. 每步都做滑动窗口裁剪，导致请求前缀不断变化，缓存命中率剧烈抖动。
3. 工具结果原样回灌，上下文被大量文件内容挤满，模型还要多跑几轮才能拿到需要的部分。

这个内核针对的正是这三件事。它不依赖特定模型供应商，也不要求把项目上传到云端：状态、日志和工具结果都落在本地。

## 核心代码

核心逻辑都在 `server/`，没有隐藏的运行时服务。可以直接读、直接替换、直接嵌进自己的 Agent 循环。

| 模块 | 作用 |
| --- | --- |
| `server/history-window.js` | 滞后裁剪、软硬上限、user 消息对齐，保证两次裁剪之间前缀只追加 |
| `server/prefix.js` | 稳定序列化、前缀哈希、完整请求指纹、公共前缀比例 |
| `server/tool-result.js` | 工具结果蒸馏、密钥脱敏、落盘、按行或 JSON Path 回读 |
| `server/token-opt.js` | 优化开关、工具结果预算、单价与保守 token 估算 |
| `server/task-contract.js` | 主 Agent 五问自检、完成判据与关键假设、子 Agent 契约段落 |
| `server/deliverable.js` | 交付物类型识别、输出路径提取与扩展开关 |
| `server/limits.js` | 工具轮数上限、进度提醒与收尾预算 |
| `server/history-compact.js` | 历史事实压缩、压缩范围选择、净收益计算 |
| `server/task-type.js` | 任务类型与工具类别的稳定归类 |
| `server/tool-order.js` | 工具定义按名称字节序稳定排序 |
| `server/cache-usage.js` | OpenAI、DeepSeek、Anthropic 缓存字段归一化与供应商缓存能力判断 |
| `server/cache-metrics.js` | 按天追加缓存命中日志，失败不影响主流程 |
| `server/context-prefetch.js` | 单轮预取：明确路径或符号才读文件，其余只给路径索引 |
| `server/cold-facts.js` | 冷事实抽取：引用旧轮次时补回关键事实 |
| `server/artifact-index.js` | 产物索引、摘要与复用判定 |
| `server/task-memo.js` | 同一任务重复请求的备忘与复用率判断 |
| `server/turn-context.js` | 单轮上下文统一装配，所有内容只追加到用户消息尾部 |
| `server/window-context.js` | 被挤出轮次的确定性摘要与窗口恢复 |
| `server/context-policy.js` | 蒸馏、裁剪与降级策略判定 |
| `server/context-guard.js` | 供应商上下文超限识别、窗口收紧与压缩重试 |
| `server/parallel-tools.js` | 只读工具并行批次与单调用失败隔离 |
| `server/tool-scheduler.js` | 同轮工具按路径依赖与屏障并发调度 |
| `server/output-paths.js` | Chat/Agent 输出目录隔离与工作区路径解析 |
| `server/plan-inline.js` | 计划内联与破坏性计划识别 |
| `server/worker-prompt.js` | 子 Agent 提示词、工具白名单与结果回传格式 |
| `server/prefix-diff.js` | 缓存命中序列归因，定位前缀漂移轮次 |
| `server/task-scheduler.js` | 子任务时长校准、粒度校验、写集合互斥、软截止与对冲 |
| `server/orchestration-economics.js` | 并行收益门槛：加速比、token 开销与串行回退结果 |
| `server/orchestration-report.js` | 编排结果、冲突与资源使用的可读报告 |
| `server/orchestration-metrics.js` | 编排指标：中位数、分位、长尾比、并行效率与 worker 缓存摘要 |
| `server/llm-governor.js` | 自适应并发、429 抖动退避与熔断 |
| `server/latency-metrics.js` | 单轮延迟拆解、PTC 覆盖率与重复读取率 |
| `server/locks.js` | 轻量按 key 互斥 |
| `server/resource-locks.js` | 文件与目录读写锁、版本登记、冲突判定、超时与取消 |
| `server/command-scope.js` | 命令作用域解析、显式 scope 校验、工具锁计划 |
| `server/verify-scheduler.js` | 验证去重、输入版本校验、stale 重跑与每工作区并发控制 |
| `server/benchmark-metrics.js` | 基准汇总、费用估算与 token 时间权衡 |
| `server/paths.js` | 工作区路径约束与越界校验 |
| `server/embeddings.js` | 向量检索配置与请求 |
| `server/ptc/` | PTC 语法校验、worker 沙箱、类型化只读工具、预算决策、校验恢复与审计追踪 |
| `index.js` | 公共 API 聚合导出 |

## 公共 API

```js
import {
  resolveLaggingWindow,
  buildRequestFingerprint,
  buildTurnContext,
  distillToolResult,
  readStoredToolResult,
  buildPtcToolDefinition,
  runPtcTool,
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler,
  shouldUseSocraticBrief,
  requiredDeliverableKinds,
  createToolScheduler,
  planContextOverflow,
  createTurnMetrics
} from 'local-first-agent-workbench-core';
```

也可以按子路径导入：

```js
import { resolveLaggingWindow } from 'local-first-agent-workbench-core/history';
import { buildTurnContext } from 'local-first-agent-workbench-core/context';
import { distillToolResult } from 'local-first-agent-workbench-core/tools';
import { runPtcTool } from 'local-first-agent-workbench-core/ptc';
import { createResourceLocks } from 'local-first-agent-workbench-core/locks';
import { planToolLocks } from 'local-first-agent-workbench-core/scope';
import { createVerifyScheduler } from 'local-first-agent-workbench-core/verify';
import { shouldUseSocraticBrief } from 'local-first-agent-workbench-core/contract';
import { requiredDeliverableKinds } from 'local-first-agent-workbench-core/deliverable';
import { createToolScheduler } from 'local-first-agent-workbench-core/tool-scheduler';
import { planContextOverflow } from 'local-first-agent-workbench-core/guard';
import { createTurnMetrics } from 'local-first-agent-workbench-core/latency';
```

完整接入顺序见 [docs/integration.md](docs/integration.md)。

## 核心能力

### 1. 缓存前缀稳定性

模型侧的自动前缀缓存只有在本次请求是上次请求的前缀时才会命中。只要 system prompt、工具 schema 或历史中间位置发生一个字节变化，后面全部内容都会重新计价。

本内核用四层机制保证前缀只追加、不回改：

- 稳定序列化：对象键按字典序输出，保证同一份配置序列化后的字节一致。
- 工具定义固定排序：按工具名排序，避免不同构造路径产生不同顺序。
- 滞后裁剪：历史超过硬上限时才一次性裁剪到软上限，两次裁剪之间至少间隔一个窗口差，避免每次追加都触发滑窗。
- 裁剪边界对齐：裁剪起点向前对齐到最近的 user 消息，不把一轮对话拦腰截断。

默认参数为软上限 48 条 / 6 万字符、硬上限 64 条 / 15 万字符；超过硬上限后裁到软上限，下一次裁剪至少再增长 16 条或 9 万字符。字符超限时按字符间隔做滞后保护，避免长消息场景每轮都触发裁剪。效果是连续两轮请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。

### 2. 工具结果蒸馏与回读

工具输出超过预算时，完整内容落盘，历史里只保留结构化摘要和 `result_id`：工具名、字符数、行数、字节数、JSON 结构、少量预览。模型需要细节时调用 `read_tool_result`，支持按行、按字符区间或 JSON Path 精确读取。

这样做的好处是上下文只保留决策需要的信息，而不是整份文件；代价是多一次回读往返。预算按上下文窗口自适应，中等结果优先保留原文，只有在结果确实很大时才蒸馏，避免为了省 token 反而增加轮次。

蒸馏实现同时处理了安全边界：密钥与令牌按正则脱敏、结果目录做路径越界校验、结果文件带 30 天 TTL、磁盘写入失败时自动退回完整内容，不影响主流程。

### 3. PTC 程序化工具调用

PTC 指 Programmatic Tool Calling。传统方式是模型每读一个文件就发起一次工具调用；PTC 让模型写一小段受控 JavaScript，在沙箱里一次完成列目录、读文件、搜索、知识库检索和技能读取，只在最后返回聚合结果。

安全设计分三层：

- 语法层：基于 acorn 的 AST 校验，禁止 `class`、`import`、`this`、`process`、动态属性访问等能力；`new` 仅允许 Set、Map、Date、RegExp、Error、Array、Object、Promise 这些标准内置对象。
- 执行层：独立 worker 线程加 `node:vm`，无网络、无写文件、无 shell，单次运行有超时和工具调用次数上限。
- 接口层：只暴露类型化的只读 API，参数逐个校验类型、范围、未知键和路径穿越，不暴露通用文件系统。

可用 API：

```js
await files.list({ path, depth, offset, limit })       // 每页最多 400 条，用 nextOffset 继续
await files.read({ path, startLine, endLine })         // 正文最多 500k 字符
await files.readMany({ paths, startLine, endLine })    // 最多 50 个路径，重复路径只读一次
await files.search({ query, path, glob, target, caseSensitive, regex })
await knowledge.search({ query, topK })
await skills.read({ name })
```

文件密集任务先 `search` 或 `list` 缩小范围，再用 `readMany` 分批读取。批量读取与内容搜索走异步有界 I/O，同一文件在多轮 `ptc_run` 中按 mtime/size 复用只读缓存；单次结果上限 24000 字符，因此要在程序内投影必要字段，不要返回多份全文。`search` 最多返回 200 条命中、最多扫描 4000 个文件，超过 1MB 的文件会跳过并计入 `skippedLarge`。

同一任务的多次 `ptc_run` 共享 `state` 与顶层变量，需要清空时传 `reset: true`。写文件、编辑、执行命令、MCP 与子 Agent 仍然走直连工具，不进入 PTC。

单次 `ptc_run` 的 100 次工具调用预算用尽时，内核提供澄清决策协议：继续 PTC、切换到直连工具，或由用户输入其它要求；选择继续会重新获得完整预算，不会只多放行一次调用。静态校验失败支持 2 次自动纠错，连续 3 次失败后自动降级到直连只读工具。

### 4. 单轮上下文引擎

长对话的成本不只来自历史长度，还来自每轮临时注入的内容。上下文引擎把这些内容收敛成四个可控块，并且全部追加在稳定前缀之后：

- 预取：只有用户消息里出现明确路径、行范围或符号时才读文件；其余情况只给“路径 + 指纹 + 行数”的工作区索引。文件未变化时按 mtime/size/hash 短路，不重复读取。
- 冷事实：用户引用旧轮次时，从历史工具调用里抽取关键事实补回，避免模型因为窗口裁剪而丢失已确认信息。
- 产出索引：记录本轮生成或修改的文件，后续引用时直接复用摘要，不重复读全文。
- 任务备忘：同一任务签名重复出现时，注入上一次的结论摘要。

`buildTurnContext` 是这四块的统一入口，`contextEngine === false` 时退化为传统全量历史模式，便于做对照基准。

### 5. 并发写锁与验证调度

多个工具同时读写同一文件时，会出现两个问题：写覆盖写，以及读到写了一半的内容。这个内核用三个模块把并发写与验证串起来：

- 资源锁：以工作区相对路径为键，提供文件与目录粒度的读写锁。读锁可并发，写锁互斥；目录锁覆盖其子孙路径；写者优先，读者不会越过更早的冲突写者；不可重入，避免同一调用链自锁。
- 命令作用域：从 `node --test`、`pytest`、`go test ./pkg/...`、`tsc -p` 等命令推断读写集合；无法判断时回退到工作区全局锁。显式声明的 scope 才被视为完整输入。
- 验证调度：同一命令与同一作用域的并发验证合并成一个 Promise；执行前快照输入文件版本，写操作会递增版本，验证结束时发现输入变化就重跑；不同作用域可以并行。

一个容易忽略的正确性细节：推断出的作用域可能漏掉被 import 的源码，因此只有显式 scope 的验证结果允许缓存。`planToolLocks` 会把 `cacheable` 传给调度器，避免把一次侥幸通过当成长期结论。

锁是进程内锁，不跨进程或跨机器；PTC 是只读沙箱，不参与写锁。跨进程场景需要换成文件锁或外部协调服务。

### 6. 可复现的分组基准

`benchmark/` 下保留了短对话 10 轮、中对话 30 轮、长对话 60 轮、超长对话 100 轮的原始结果与报告生成脚本。报告是单文件 HTML，图表不依赖外部库，手机端可以直接打开。旧版五组数据归档在 `benchmark/data/legacy-2026-11-22/`。

结果口径：

- 优化版：PTC 程序化工具调用 + 单轮上下文引擎 + 滞后裁剪 + 工具结果蒸馏与自适应预算。
- 传统版：原生 function calling + 全量历史 + 单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联、任务备忘、蒸馏与压缩。
- 同模型、同任务、同提示词，按产物文件自动校验准确率，不以返回文本比对为准。

### 7. 任务契约与交付物约束

长任务失败往往不是模型不会做，而是做偏了：把“生成 Excel”理解成“写一个 Python 脚本”，或者把输入文件当成交付物。内核用两个纯函数模块把“做什么”和“算不算完成”固定下来：

- `task-contract.js`：主 Agent 在复杂任务上回答五个固定问题（真实目标、已知/未知/假设、最可能失败点、方法取舍、下一步与委托），并把完成判据与关键假设下发给子 Agent。自检块只追加到当前用户消息尾部，不改 system/tools 前缀；子 Agent 不自问，避免假设分裂。
- `deliverable.js`：只识别动作词之后的目标片段，例如“读取 a.xlsx 转成 csv”只要求 csv，“生成一份分析报告”不会被误判成 Excel；支持 xlsx/pptx/docx/pdf/csv/html，并提取用户指定的输出路径。

契约只用于提醒和验收，不替代执行。工具成功落盘后按扩展名标记完成；用户要 Excel 却只写了脚本时，守卫会继续提醒，直到真实产物出现。

### 8. 同轮工具并发调度

模型一轮可以返回多个工具调用。`tool-scheduler.js` 按路径依赖把调用分成“可并发”和“屏障”：

- 不同路径的写可以并发，同一路径的写按原顺序串行；
- 写后读同一文件必须等待写入完成，目录扫描与子文件写按祖先关系排序；
- 带确定 scope 的 `run_command` 是 verify 节点，未知命令、需要审批的调用与未知工具是屏障；
- `_v43.py` 这类同脚本多版本写入强制走屏障，避免预执行绕过版本守卫。

并发上限默认 4，`AGENT_TOOL_CONCURRENCY=0` 可退回仅连续只读并发。调度器只决定顺序，真正的互斥仍由资源锁保证；Chat 与 Agent 共用同一套输出路径解析，`outputs/report.md` 在 Chat 下会映射到 `outputs/chat/report.md`，读写落到同一个锁键。

### 9. 上下文超限与请求治理

`context-guard.js` 识别供应商的 `maximum context length` 类错误，从错误文本解析真实上限，按 70% 目标压缩请求视图后重试；重试次数用尽或无可压缩内容时返回可读错误，不把原始 400 直接抛给用户。

`llm-governor.js` 只包裹“建立请求 + 读取响应头”：自适应并发在 429 时减半、连续成功后逐步恢复；没有 `Retry-After` 时用 full jitter 指数退避；服务端给出长等待时打开熔断，排队中的请求立即失败而不是继续撞限流。SSE 开始后不再重试，避免重复计费或重复输出。

### 10. 延迟归因与 PTC 覆盖率

`latency-metrics.js` 把单轮墙钟拆成模型首字等待、解码、工具、落盘、审批等待、编排与未归因残差；`durationMs` 会扣除用户思考与审批时间。它还统计 PTC 轮次覆盖率、重复读取率、按 plan/execute/finalize 阶段的调用与 token 归因，以及缓存是否真正上报。所有指标只观测，不参与调度决策。

## 基准结果

模型为 deepseek-chat，四个分组各跑多次，两个变体合计 820 轮真实对话（短对话 3 次运行，中、长、超长各 2 次），数据采集于 2026 年 11 月 23 日晚间。计价使用 DeepSeek 官方峰谷价（CNY / 100 万 tokens）：空闲 命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4；高峰 命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8。档位按每次运行开始时间锁定，本次四组均落在周一晚间空闲时段。

为什么只用 DeepSeek 计价：DeepSeek 的 usage 稳定返回 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`，可以分别按命中价与未命中价计费，并与官方峰谷价一一对应。其他供应商要么不返回缓存字段，要么字段含义不同，无法做到同口径。金额为按官方单价的估算值，实际账单以供应商为准。

下表是每个分组单次运行的均值，费用为一次会话的估算金额。

| 分组 | 轮次 | 优化版 tokens | 传统版 tokens | token 变化 | 优化版耗时 | 传统版耗时 | 准确率（优化/传统） | 缓存命中（优化/传统） | 未命中（优化/传统） | 估算费用（优化/传统） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 短对话 | 10 | 476.8k | 515.0k | 少 7.4% | 47.7s | 53.4s | 100% / 100% | 93.1% / 93.3% | 32.5k / 34.2k | ¥0.0646 / ¥0.0681 |
| 中对话 | 30 | 1.87M | 2.50M | 少 25.1% | 160.3s | 188.2s | 100% / 100% | 94.2% / 94.2% | 107.3k / 142.8k | ¥0.2376 / ¥0.2903 |
| 长对话 | 60 | 4.40M | 5.57M | 少 21.1% | 354.8s | 431.5s | 100% / 100% | 94.4% / 94.0% | 244.6k / 332.3k | ¥0.5672 / ¥0.7315 |
| 超长对话 | 100 | 7.14M | 9.85M | 少 27.5% | 547.8s | 754.5s | 100% / 100% | 94.2% / 94.0% | 409.5k / 584.5k | ¥0.9399 / ¥1.2811 |

四点结论：

1. token 节省随轮次增长而扩大，超长对话达到 27.5%，中对话 25.1%，整体每轮下降 24.4%。原因是 PTC 减少了工具往返，上下文引擎压低了每轮注入，两者叠加后没有被窗口上限抵消。
2. 耗时四组全部低于传统框架，节省 10.7% 到 27.4%。超长对话 547.8s 对 754.5s，快 27.4%；工具调用 219 次对 357 次，说明减少往返确实换回了墙钟时间。
3. 缓存命中率两个变体都在 93.1% 到 94.4%，不是这次差异的主要来源。真正的差异是每轮发送的上下文体积与工具往返次数；未命中 tokens 在超长对话为 40.95 万对 58.45 万，少 30.0%。费用按官方单价计算后，超长对话为 ¥0.9399 对 ¥1.2811，低 26.6%。
4. 准确率全部为 100%，按产物文件校验，820 轮中没有出现工具调用失败、超时或异常值。整体每轮平均，优化版 5.53 秒、6.89 万 token、¥0.0090，传统版 7.09 秒、9.12 万 token、¥0.0117；820 轮合计模型费用约 ¥8.5。优化版没有为了省 token 或省时间牺牲任务成功率。

## 适用场景

当前内核最适合同一代码库或同一套文档集上的持续任务：

- 多文件阅读、跨目录依赖分析、遗留系统接手；
- 跨文件重构、批量修改、配置迁移、框架升级；
- 长报告、测试补全、迁移方案等需要多轮上下文的连续任务；
- 固定材料反复问答的知识库或办公文档场景；
- 需要工具调用、审批和可回滚写操作的工程任务。

相对不适合：

- 一次性短问答、单文件小改；
- 强实时交互、纯 GUI 操作；
- 无法审批的高风险写操作；
- 需要任意跨会话语义记忆但没有 RAG 或知识库支撑的场景。

这些任务里框架开销可能大于收益，或者应该改用更轻的方案。

## 快速开始

要求 Node.js 20 及以上。

```bash
npm install
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
```

`example:minimal` 演示历史窗口、前缀指纹、工具结果蒸馏与回读。`example:context` 演示单轮上下文引擎：明确路径才预取、产出索引、第二次引用直接命中缓存。`example:ptc` 在一个临时工作区里跑一次 PTC 批量搜索。`benchmark:report` 会读取 `benchmark/data/` 下的原始 JSON，在 `benchmark/output/` 生成 `benchmark-report.html` 和 `benchmark-summary.json`。仓库内附了一份预生成报告，可直接打开 `benchmark/report-preview.html` 查看。旧版五组数据放在 `benchmark/data/legacy-2026-11-22/`，报告脚本只读取顶层数据文件。

当前 42 个测试文件、331 项测试全部通过。

本仓库是内核库，不包含 Web 服务入口。接入方式是在自己的 Agent 循环中调用这些模块：请求前用 `resolveLaggingWindow` 取历史窗口，用 `buildRequestFingerprint` 计算并记录前缀哈希，工具返回后用 `distillToolResult` 决定是否落盘。

## 目录结构

```text
index.js              公共 API 聚合导出
server/               核心模块
  prefix.js           稳定序列化、前缀哈希、公共前缀比例
  history-window.js   滞后裁剪、软硬上限、user 消息对齐
  token-opt.js        优化开关、预算、单价与保守 token 估算
  tool-result.js      工具结果蒸馏、脱敏、落盘、分段回读
  history-compact.js  历史事实压缩、净收益计算
  task-type.js        任务类型与工具类别的稳定归类
  tool-order.js       工具定义稳定排序
  task-contract.js    主 Agent 自检、完成判据与关键假设
  deliverable.js      交付物类型识别与输出路径提取
  limits.js           工具轮数上限与收尾预算
  cache-metrics.js    按天追加缓存命中日志
  cache-usage.js      多供应商缓存用量字段归一化与缓存能力判断
  context-prefetch.js 单轮预取与工作区索引
  cold-facts.js       冷事实抽取
  artifact-index.js   产物索引与复用判定
  task-memo.js        任务备忘
  turn-context.js     单轮上下文统一装配
  window-context.js   被挤出轮次摘要与窗口恢复
  context-policy.js   蒸馏、裁剪与降级策略
  context-guard.js    上下文超限识别与压缩重试
  parallel-tools.js   只读工具并行批次
  tool-scheduler.js   同轮工具按路径依赖并发调度
  output-paths.js     Chat/Agent 输出目录隔离
  plan-inline.js      计划内联
  worker-prompt.js    子 Agent 提示词与工具白名单
  prefix-diff.js      前缀漂移归因
  task-scheduler.js   子任务调度策略
  orchestration-economics.js 并行收益门槛
  orchestration-report.js    编排结果报告
  orchestration-metrics.js 编排指标
  llm-governor.js     自适应并发、退避与熔断
  latency-metrics.js  单轮延迟拆解与 PTC 覆盖率
  locks.js            轻量按 key 互斥
  resource-locks.js   文件与目录读写锁、版本登记
  command-scope.js    命令作用域解析与工具锁计划
  verify-scheduler.js 验证去重与 stale 重跑
  benchmark-metrics.js 基准汇总与费用估算
  paths.js            工作区路径约束与根缓存
  embeddings.js       向量检索配置与请求
  ptc/                PTC 语法校验、沙箱、类型化工具、预算决策与追踪
test/                 42 个核心单元、边界与模拟测试
examples/             最小接入、上下文引擎与 PTC 示例
benchmark/
  data/               最新四组真实基准原始结果
  data/legacy-2026-11-22/ 旧版五组基准数据
  report.mjs          报告生成脚本
  report-preview.html 预生成报告
  README.md           基准口径与数据说明
docs/
  cache-stability.md  缓存命中率修复的完整过程
  concurrency.md      并发写锁、命令作用域与验证调度
  ptc.md              PTC 设计与安全边界
  integration.md      接入指南
  release-gitee.md    Gitee 发布步骤
```

## 已知限制

- 只包含内核，不能直接启动一个可对话的 Web 应用。
- 基准每组 2 到 3 次运行，样本量仍然有限，结论应看趋势而非小数点。
- 只在 Windows 与 Node 20 环境完整验证，Linux 与 macOS 尚未系统测试。
- PTC 的批量代码质量依赖模型能力。`readMany` 最多支持 50 个路径，但单次返回的正文受 24000 字符结果上限约束；小模型应减少单次全文数量，优先在程序内聚合。
- 并发锁是进程内锁，不跨进程或跨机器；需要跨进程写保护时应替换为文件锁或外部协调服务。
- 短对话组收益有限：10 轮场景 token 少 7.4%、费用少 5.1%，初始化和调度开销占比更高，这个规模不适合作为主场景。
- 推断出的命令作用域可能不完整，因此其验证结果不缓存；只有显式声明读写集合的验证才会命中缓存。
- 交付物契约只识别常见格式与动作词；过于口语化或省略目标的请求仍可能需要调用方补充规则。

## 路线图

1. 批量回读：一次读取多个 `result_id` 的片段，减少长对话里的回读往返。
2. 聚合下推：引导模型在 PTC 脚本内完成计数、去重、排序和字段投影，只返回结果。
3. 第二阶段压缩：在离线评估确认净收益后按任务类型灰度开启。
4. 多模型评测：给出不同模型下 PTC 批量规模的安全上限。
5. 跨平台验证与 CI：把前缀稳定性与准确率回归接入持续集成。

## 版本与旧版源码

当前对外版本为 0.4.0，在 0.3.1 的文件密集 PTC 优化之上，补齐任务契约与交付物约束、同轮工具并发调度、上下文超限兜底、LLM 限流治理、单轮延迟归因与并行编排经济性门禁；同时修复锁自重叠、共享路径缓存、验证排队归因等跨模块一致性问题。0.1.0 到 0.3.1 的内核源码保留在 Gitee 仓库 https://gitee.com/george333999/local-first-agent-workbench 的提交历史中，旧版五组基准原始数据归档在 `benchmark/data/legacy-2026-11-22/`。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的流程私下报告。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

发布到 Gitee 的完整命令与检查清单见 [docs/release-gitee.md](docs/release-gitee.md)。

## 许可证

[MIT](LICENSE)
