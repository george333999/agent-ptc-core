# Cache-stable Agent Core

> AgentProject 开源内核：用 PTC 批量只读工具和单轮上下文引擎减少模型往返，用按模型窗口推导的历史预算与缓存前缀工程把长对话命中率稳定在 90% 以上，并用进程内写锁与验证调度保证并发修改的一致性；主 Agent 自检、交付物契约和同轮工具调度保证结果真正按用户要求落盘。最新五组 1000 轮同窗 ABBA 基准下，token 低 69.8%、耗时低 14.8%、金额低 37.2%，准确率 99.8% 对 97.8%；墙钟约九成仍在模型侧，进一步优化主要靠减少模型步数。

本仓库是 AgentProject 的内核抽取版，保留十项可独立复用的能力：长对话缓存稳定性、按模型窗口推导的历史预算、单轮上下文引擎、工具结果蒸馏与回读、PTC 程序化只读工具调用、子任务调度与经济性门禁、并发写锁与验证调度、同轮工具并发调度、主 Agent 任务契约与交付物约束、上下文超限与限流治理。另附单轮延迟归因与可复现的分组基准报告。完整工作台中的 Web 编辑器、多 Agent 运行时、MCP、OCR 与文档处理没有包含在本仓库中。

**机制全景**：每一项机制解决的问题、为什么采用、实际效果、生效位置、与其他机制的交互和代价，见 [docs/mechanisms.md](docs/mechanisms.md)。其中“性能边界”和“金额口径”两节解释了为什么时间已经接近模型侧下限、金额为什么按 DeepSeek 价格估算。

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
| `server/history-window.js` | 滞后裁剪、软硬上限、user 消息对齐，支持按模型窗口推导预算，保证两次裁剪之间前缀只追加 |
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
  historyLimitsForContext,
  buildRequestFingerprint,
  buildTurnContext,
  resolveTurnContextBudget,
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
} from 'cache-stable-agent-core';
```

也可以按子路径导入：

```js
import { resolveLaggingWindow } from 'cache-stable-agent-core/history';
import { buildTurnContext } from 'cache-stable-agent-core/context';
import { distillToolResult } from 'cache-stable-agent-core/tools';
import { runPtcTool } from 'cache-stable-agent-core/ptc';
import { createResourceLocks } from 'cache-stable-agent-core/locks';
import { planToolLocks } from 'cache-stable-agent-core/scope';
import { createVerifyScheduler } from 'cache-stable-agent-core/verify';
import { shouldUseSocraticBrief } from 'cache-stable-agent-core/contract';
import { requiredDeliverableKinds } from 'cache-stable-agent-core/deliverable';
import { createToolScheduler } from 'cache-stable-agent-core/tool-scheduler';
import { planContextOverflow } from 'cache-stable-agent-core/guard';
import { createTurnMetrics } from 'cache-stable-agent-core/latency';
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

默认保留两档预算：旧版兼容默认是软上限 48 条 / 6 万字符、硬上限 64 条 / 15 万字符；长会话推荐使用 `historyLimitsForContext(modelWindow)`，把硬上限推到模型窗口的 97%（按 2.5 字符/token 保守换算），软上限取硬上限的 50%。后者让一次裁剪丢掉足够多历史，下一次裁剪间隔更长，避免每几轮就重建一次前缀。超过硬上限后裁到软上限，裁剪起点对齐到最近的 user 消息。效果是连续两轮请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。

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
- 短会话降级：前 3 个用户轮次把索引条目 240→120、预取总量 8000→4000 字符、事实/产出块 1000→400 token，避免固定注入成本在短会话里摊不薄。

`buildTurnContext` 是这四块的统一入口，`contextEngine === false` 时退化为传统全量历史模式，便于做对照基准。

### 5. 并发写锁与验证调度

多个工具同时读写同一文件时，会出现两个问题：写覆盖写，以及读到写了一半的内容。这个内核用三个模块把并发写与验证串起来：

- 资源锁：以工作区相对路径为键，提供文件与目录粒度的读写锁。读锁可并发，写锁互斥；目录锁覆盖其子孙路径；写者优先，读者不会越过更早的冲突写者；不可重入，避免同一调用链自锁。
- 命令作用域：从 `node --test`、`pytest`、`go test ./pkg/...`、`tsc -p` 等命令推断读写集合；无法判断时回退到工作区全局锁。显式声明的 scope 才被视为完整输入。
- 验证调度：同一命令与同一作用域的并发验证合并成一个 Promise；执行前快照输入文件版本，写操作会递增版本，验证结束时发现输入变化就重跑；不同作用域可以并行。

一个容易忽略的正确性细节：推断出的作用域可能漏掉被 import 的源码，因此只有显式 scope 的验证结果允许缓存。`planToolLocks` 会把 `cacheable` 传给调度器，避免把一次侥幸通过当成长期结论。

锁是进程内锁，不跨进程或跨机器；PTC 是只读沙箱，不参与写锁。跨进程场景需要换成文件锁或外部协调服务。

### 6. 可复现的分组基准

`benchmark/` 下保留了极短 10 轮、短 20 轮、中 50 轮、长 70 轮、超长 100 轮的原始结果与报告生成脚本。报告是单文件 HTML，图表不依赖外部库，手机端可以直接打开。旧版四组数据归档在 `benchmark/data/legacy-2026-11-23/`，更早的五组数据在 `benchmark/data/legacy-2026-11-22/`。

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

最新一批是 2026-11-26 的同窗 ABBA 复测：模型 deepseek-chat，每组每变体 2 次运行，按 A-B-B-A 顺序交替，两个变体各 500 轮、合计 1000 轮真实对话。金额统一按空闲价重算（CNY / 100 万 tokens：命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4），避免两组运行时段跨峰谷造成 2 倍档位差。

| 分组 | 轮次/run | 墙钟 opt / base | 墙钟差 | Token opt / base | Token 差 | 金额 opt / base | 金额差 | 准确率 opt / base |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 极短对话 | 10 | 111.5s / 126.3s | -11.7% | 1.23M / 1.27M | -3.2% | ¥0.1652 / ¥0.1484 | +11.3% | 100% / 100% |
| 短对话 | 20 | 203.2s / 226.3s | -10.2% | 3.11M / 3.41M | -8.7% | ¥0.2754 / ¥0.2799 | -1.6% | 100% / 100% |
| 中对话 | 50 | 583.8s / 657.1s | -11.1% | 10.80M / 21.83M | -50.5% | ¥0.7633 / ¥1.0738 | -28.9% | 100% / 100% |
| 长对话 | 70 | 957.8s / 1071.5s | -10.6% | 16.32M / 46.87M | -65.2% | ¥1.3963 / ¥1.9423 | -28.1% | 99.3% / 92.1% |
| 超长对话 | 100 | 1444.2s / 1793.1s | -19.5% | 22.83M / 106.68M | -78.6% | ¥1.9800 / ¥3.8460 | -48.5% | 100% / 100% |
| **合计（2 run）** | **250/run** | **3300.6s / 3874.2s** | **-14.8%** | **54.29M / 180.05M** | **-69.8%** | **¥4.5802 / ¥7.2904** | **-37.2%** | **99.8% / 97.8%** |

五点结论：

1. 墙钟在五组全部领先传统版（-10.2% 到 -19.5%），整体 -14.8%；token -69.8%，金额 -37.2%。同窗交替排除了时段负载差，之前的“优化版更慢”是跨时段造成的假象。
2. token 与金额优势随对话变长迅速扩大：中对话 token -50.5%，超长对话 -78.6%。原因是 PTC 减少工具往返，按模型窗口推导的历史预算与上下文引擎压低了每轮注入，两者叠加后没有被窗口上限抵消。
3. 准确率 99.8% 对 97.8%。传统版在长对话 03:41 的 run 中 11 个 Excel 任务全部失败：先生成 xlsx，再转 CSV，然后 `delete_file` 把 xlsx 删掉，交付物缺失。这不是测评脚本误判，而是缺少交付物守卫导致的真实失败；优化版同窗口 99.3%（140 轮中 1 轮 review 未写入有效内容）。
4. 极短对话是唯一金额高于传统版的分组（+11.3%），但墙钟反而快 11.7%。PTC 的工具轮次更少（27.0 对 29.5），真正的差距是每次 `ptc_run` 的 JS 代码参数属于全新未命中 token：10 轮内多出约 1 万未命中输入，而未命中单价是命中的 50 倍，固定开销来不及摊薄。短对话组金额已基本持平（-1.6%），中对话起转为明显节省。
5. 长对话组使用 2 opt + 2 base 四个有效 run，剔除了两次明显的服务端卡顿 run（opt 单轮 192s、base P95 22.6s）；其余失败轮次全部计入，未做有利筛选。完整口径、逐组图表与可保存 PNG 见 [benchmark/README.md](benchmark/README.md) 和 [benchmark/abba-report-2026-11-26.html](benchmark/abba-report-2026-11-26.html)。

上一批（2026-11-25，跨时段单次运行，500 轮）的每轮均值表保留用于历史对照。该批长对话组受时段影响，金额结论已被同窗 ABBA 取代：

| 分组 | 轮次 | 优化版 tokens | 传统版 tokens | token 变化 | 优化版耗时 | 传统版耗时 | 准确率（优化/传统） | 缓存命中（优化/传统） | 未命中（优化/传统） | 费用（优化/传统） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 极短对话 | 10 | 76.9k | 63.2k | 多 21.8% | 6.3s | 5.8s | 100% / 100% | 90.7% / 93.9% | 71k / 38k | ¥0.0112 / ¥0.0075 |
| 短对话 | 20 | 98.0k | 137.0k | 少 28.5% | 5.5s | 5.6s | 100% / 100% | 95.0% / 96.6% | 98k / 93k | ¥0.0091 / ¥0.0096 |
| 中对话 | 50 | 142.2k | 251.9k | 少 43.5% | 5.7s | 8.1s | 100% / 100% | 96.0% / 98.5% | 284k / 183k | ¥0.0113 / ¥0.0123 |
| 长对话 | 70 | 157.5k | 306.0k | 少 48.5% | 6.5s | 7.3s | 100% / 100% | 95.5% / 98.9% | 488k / 244k | ¥0.0138 / ¥0.0132 |
| 超长对话 | 100 | 165.8k | 487.8k | 少 66.0% | 6.7s | 9.3s | 100% / 100% | 95.5% / 99.2% | 742k / 379k | ¥0.0145 / ¥0.0177 |

上一批的主要结论是 token 随轮次增长、整体金额低 8.3%，但长对话组金额略高；由于两组运行时段不同，长组差异不能直接归因于框架。最新结论以上面的同窗 ABBA 表为准。

计划提示词与计划闸门的单独成本 A/B（long 70 轮、xlong 100 轮，含复现命令与边界）见 [docs/plan-prompt-ab.md](docs/plan-prompt-ab.md)。

### 性能边界：墙钟已经接近模型侧下限

把每轮 `durationMs` 按 `latency-metrics` 的字段拆开后，2026-11-25 批次的优化版整体 93.8% 的墙钟花在模型调用（首 token 83.1%、解码 10.7%），本地工具 5.3%，落盘接近 0，未归因 0.6%。2026-11-26 ABBA 批次的超长组仍约 92% 在模型侧，每轮平均 3.7 次模型调用；传统版整体模型侧 89.8%，每步首 token 1.48 秒。

这意味着墙钟已经接近这套模型下的下限：即使把本地工具耗时压到 0，2026-11-25 批次每轮也只能从 6.34 秒降到约 6.0 秒，收益不到 6%；ABBA 批次的整体差距为 -14.8%，主要来自更少的模型往返与更小的上下文。继续压缩上下文主要降低金额，对时间帮助有限；要再降时间，应减少模型步数、回读往返和输出长度，而不是继续加大压缩。极短对话是唯一金额例外：10 轮摊不薄 PTC 的固定未命中开销，金额高 11.3%，但墙钟仍快 11.7%。完整拆解见 [docs/mechanisms.md](docs/mechanisms.md)。

### 金额口径：按 DeepSeek 官方价格估算

基准金额是按 token 用量和 DeepSeek 官方单价计算的估算值，不是账单。单价（CNY / 100 万 tokens）：空闲时段命中 ¥0.02、未命中 ¥1、输出 ¥4；高峰时段为 2 倍（¥0.04 / ¥2 / ¥8）。2026-11-25 批次的原始运行全部在高峰时段，数据与报告已统一归一化为空闲价，`peakCostCny` 保留原始高峰成本；2026-11-26 ABBA 批次跨峰谷，两组均按空闲价重算。真实账单请按实际发送时段另算。

计算公式为 `cost = 命中/1e6*0.02 + 未命中/1e6*1 + 输出/1e6*4`。2026-11-25 批次优化版每轮约 142.1k 命中、6.7k 未命中、0.88k 输出，合计约 ¥0.0131；传统版约 340.0k 命中、3.7k 未命中、0.93k 输出，合计约 ¥0.0143。同窗 ABBA 批次整体为 ¥4.5802 对 ¥7.2904（-37.2%）。只用 DeepSeek 做同口径比较，是因为它稳定返回 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`；其他供应商缺少统一缓存字段。金额为估算值，不含税费、折扣或供应商调价。

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

当前 45 个测试文件、334 项测试全部通过。

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
test/                 45 个核心单元、边界与模拟测试
examples/             最小接入、上下文引擎与 PTC 示例
benchmark/
  data/               2026-11-25 五组真实基准原始结果
  data/abba-2026-11-26/ 同窗 ABBA 五组汇总
  data/legacy-2026-11-22/ 旧版五组基准数据
  data/legacy-2026-11-23/ 上一版四组基准数据
  abba-report-2026-11-26.html 同窗 ABBA 报告（单文件 HTML）
  abba-report-2026-11-26.png  同窗 ABBA 报告长图（手机端可保存）
  report.mjs          报告生成脚本
  report-preview.html 预生成报告
  README.md           基准口径与数据说明
docs/
  mechanisms.md       机制全景：每项机制的作用、交互与取舍
  cache-stability.md  缓存命中率修复的完整过程
  concurrency.md      并发写锁、命令作用域与验证调度
  ptc.md              PTC 设计与安全边界
  integration.md      接入指南
  release-gitee.md    Gitee 发布步骤
```

## 已知限制

- 只包含内核，不能直接启动一个可对话的 Web 应用。
- 基准每组 1 次运行，样本量有限，结论应看趋势而非小数点。
- 只在 Windows 与 Node 20 环境完整验证，Linux 与 macOS 尚未系统测试。
- PTC 的批量代码质量依赖模型能力。`readMany` 最多支持 50 个路径，但单次返回的正文受 24000 字符结果上限约束；小模型应减少单次全文数量，优先在程序内聚合。
- 并发锁是进程内锁，不跨进程或跨机器；需要跨进程写保护时应替换为文件锁或外部协调服务。
- 短对话组收益有限：极短 10 轮场景 token 多 21.8%、费用高 49%，初始化和调度开销占比更高，这个规模不适合作为主场景。
- 墙钟约 93.8% 来自模型侧：每步固定首 token 延迟约 1.10–1.48 秒，且与 prompt 大小关系不大；进一步降耗主要靠减少模型调用步数，而不是继续压缩上下文。
- 推断出的命令作用域可能不完整，因此其验证结果不缓存；只有显式声明读写集合的验证才会命中缓存。
- 交付物契约只识别常见格式与动作词；过于口语化或省略目标的请求仍可能需要调用方补充规则。

## 路线图

1. 批量回读：一次读取多个 `result_id` 的片段，减少长对话里的回读往返。
2. 聚合下推：引导模型在 PTC 脚本内完成计数、去重、排序和字段投影，只返回结果。
3. 第二阶段压缩：在离线评估确认净收益后按任务类型灰度开启。
4. 多模型评测：给出不同模型下 PTC 批量规模的安全上限。
5. 跨平台验证与 CI：把前缀稳定性与准确率回归接入持续集成。

## 版本与旧版源码

当前对外版本为 0.5.5。0.5.5 同步了动态压缩的结束阶段跳过、裁剪前体积水位与预测式跳过，补入同窗 ABBA 基准（五组 1000 轮）和极短对话的 PTC 固定开销分析，不改变对外 API。0.5.1–0.5.4 主要增强文档。0.5.0 在 0.4.0 的任务契约、交付物约束与同轮工具调度之上，新增按模型窗口推导的历史预算（`historyLimitsForContext`）、短会话上下文预算降级（`resolveTurnContextBudget`），把轮内紧急裁剪阈值从 90% 提到 97%，并把基准更新为五组 500 轮、同档价重算。项目名同步调整为 Cache-stable Agent Core：仓库实际是内核库，不包含 Web 工作台；Gitee 仓库路径暂时保留 `local-first-agent-workbench` 以兼容历史链接，可在仓库设置中改为 `cache-stable-agent-core`。0.1.0 到 0.4.0 的内核源码保留在 Gitee 仓库 https://gitee.com/george333999/local-first-agent-workbench 的提交历史中，旧版基准原始数据归档在 `benchmark/data/legacy-2026-11-22/` 与 `benchmark/data/legacy-2026-11-23/`。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的流程私下报告。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

发布到 Gitee 的完整命令与检查清单见 [docs/release-gitee.md](docs/release-gitee.md)。

## 许可证

[MIT](LICENSE)
