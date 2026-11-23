# Local-first Agent Workbench Core

> AgentProject 开源内核：用 PTC 批量只读工具和单轮上下文引擎减少模型往返，用缓存前缀工程把长对话命中率稳定在 90% 以上。真实基准下 token 与耗时均比传统框架低约 25%。

本仓库是 AgentProject 的内核抽取版，保留六项可独立复用的能力：长对话缓存稳定性、单轮上下文引擎、工具结果蒸馏与回读、PTC 程序化只读工具调用、子任务调度策略、可复现的分组基准报告。完整工作台中的 Web 编辑器、多 Agent 运行时、MCP、OCR 与文档处理没有包含在本仓库中。

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
| `server/plan-inline.js` | 计划内联与破坏性计划识别 |
| `server/worker-prompt.js` | 子 Agent 提示词、工具白名单与结果回传格式 |
| `server/prefix-diff.js` | 缓存命中序列归因，定位前缀漂移轮次 |
| `server/task-scheduler.js` | 子任务时长校准、粒度校验、写集合互斥、软截止与对冲 |
| `server/orchestration-metrics.js` | 编排指标：中位数、分位、长尾比与并行效率 |
| `server/benchmark-metrics.js` | 基准汇总、费用估算与 token 时间权衡 |
| `server/paths.js` | 工作区路径约束与越界校验 |
| `server/embeddings.js` | 向量检索配置与请求 |
| `server/ptc/` | PTC 语法校验、worker 沙箱、类型化只读工具、审计追踪 |
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
  runPtcTool
} from 'local-first-agent-workbench-core';
```

也可以按子路径导入：

```js
import { resolveLaggingWindow } from 'local-first-agent-workbench-core/history';
import { buildTurnContext } from 'local-first-agent-workbench-core/context';
import { distillToolResult } from 'local-first-agent-workbench-core/tools';
import { runPtcTool } from 'local-first-agent-workbench-core/ptc';
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

默认参数为软上限 48 条 / 6 万字符、硬上限 64 条 / 9 万字符；超过硬上限后裁到软上限，下一次裁剪至少再增长 16 条或 3 万字符。字符超限时按字符间隔做滞后保护，避免长消息场景每轮都触发裁剪。效果是连续两轮请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。

### 2. 工具结果蒸馏与回读

工具输出超过预算时，完整内容落盘，历史里只保留结构化摘要和 `result_id`：工具名、字符数、行数、字节数、JSON 结构、少量预览。模型需要细节时调用 `read_tool_result`，支持按行、按字符区间或 JSON Path 精确读取。

这样做的好处是上下文只保留决策需要的信息，而不是整份文件；代价是多一次回读往返。预算按上下文窗口自适应，中等结果优先保留原文，只有在结果确实很大时才蒸馏，避免为了省 token 反而增加轮次。

蒸馏实现同时处理了安全边界：密钥与令牌按正则脱敏、结果目录做路径越界校验、结果文件带 30 天 TTL、磁盘写入失败时自动退回完整内容，不影响主流程。

### 3. PTC 程序化工具调用

PTC 指 Programmatic Tool Calling。传统方式是模型每读一个文件就发起一次工具调用；PTC 让模型写一小段受控 JavaScript，在沙箱里一次完成列目录、读文件、搜索、知识库检索和技能读取，只在最后返回聚合结果。

安全设计分三层：

- 语法层：基于 acorn 的 AST 校验，禁止 `new`、`class`、`import`、`this`、`process`、动态属性访问等能力。
- 执行层：独立 worker 线程加 `node:vm`，无网络、无写文件、无 shell，单次运行有超时和工具调用次数上限。
- 接口层：只暴露类型化的只读 API，参数逐个校验类型、范围、未知键和路径穿越，不暴露通用文件系统。

可用 API：

```js
await files.list({ path, depth })
await files.read({ path, startLine, endLine })
await files.readMany({ paths, startLine, endLine })
await files.search({ query, path, glob, target, caseSensitive })
await knowledge.search({ query, topK })
await skills.read({ name })
```

同一任务的多次 `ptc_run` 共享 `state` 与顶层变量，需要清空时传 `reset: true`。写文件、编辑、执行命令、MCP 与子 Agent 仍然走直连工具，不进入 PTC。

### 4. 单轮上下文引擎

长对话的成本不只来自历史长度，还来自每轮临时注入的内容。上下文引擎把这些内容收敛成四个可控块，并且全部追加在稳定前缀之后：

- 预取：只有用户消息里出现明确路径、行范围或符号时才读文件；其余情况只给“路径 + 指纹 + 行数”的工作区索引。文件未变化时按 mtime/size/hash 短路，不重复读取。
- 冷事实：用户引用旧轮次时，从历史工具调用里抽取关键事实补回，避免模型因为窗口裁剪而丢失已确认信息。
- 产出索引：记录本轮生成或修改的文件，后续引用时直接复用摘要，不重复读全文。
- 任务备忘：同一任务签名重复出现时，注入上一次的结论摘要。

`buildTurnContext` 是这四块的统一入口，`contextEngine === false` 时退化为传统全量历史模式，便于做对照基准。

### 5. 可复现的分组基准

`benchmark/` 下保留了极短对话 10 轮、短对话 20 轮、中对话 50 轮、长对话 70 轮、超长对话 100 轮的原始结果与报告生成脚本。报告是单文件 HTML，图表不依赖外部库，手机端可以直接打开。

结果口径：

- 优化版：PTC 程序化工具调用 + 单轮上下文引擎 + 滞后裁剪 + 工具结果蒸馏与自适应预算。
- 传统版：原生 function calling + 全量历史 + 单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联、任务备忘、蒸馏与压缩。
- 同模型、同任务、同提示词，按产物文件自动校验准确率，不以返回文本比对为准。

## 基准结果

模型为 deepseek-chat，两个变体合计 560 轮真实对话（极短与短对话各 2 次运行，中、长、超长各 1 次）。计价使用 DeepSeek 官方峰谷价（CNY / 100 万 tokens）：空闲 命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4；高峰 命中 ¥0.04 / 未命中 ¥2 / 输出 ¥8。档位按每次运行开始时间锁定，本次五组均落在周日空闲时段。

为什么只用 DeepSeek 计价：DeepSeek 的 usage 稳定返回 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`，可以分别按命中价与未命中价计费，并与官方峰谷价一一对应。其他供应商要么不返回缓存字段，要么字段含义不同，无法做到同口径。金额为按官方单价的估算值，实际账单以供应商为准。

| 分组 | 轮次 | 优化版 tokens | 传统版 tokens | token 变化 | 优化版耗时 | 传统版耗时 | 准确率（优化/传统） | 缓存命中（优化/传统） | 未命中（优化/传统） | 估算费用（优化/传统） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 极短对话 | 10 | 484.9k | 516.7k | 少 6.1% | 46.9s | 52.3s | 100% / 100% | 92.75% / 92.89% | 34.7k / 36.3k | ¥0.0666 / ¥0.0679 |
| 短对话 | 20 | 928.6k | 1.23M | 少 24.4% | 91.6s | 101.6s | 100% / 100% | 92.85% / 92.64% | 65.5k / 89.5k | ¥0.1304 / ¥0.1567 |
| 中对话 | 50 | 2.81M | 3.88M | 少 27.6% | 256.4s | 384.1s | 100% / 100% | 91.48% / 91.33% | 235.9k / 331.1k | ¥0.4373 / ¥0.6288 |
| 长对话 | 70 | 4.51M | 5.98M | 少 24.5% | 415.7s | 586.8s | 100% / 100% | 90.40% / 90.63% | 425.7k / 550.6k | ¥0.8152 / ¥1.0666 |
| 超长对话 | 100 | 6.52M | 8.67M | 少 24.8% | 650.3s | 919.4s | 100% / 100% | 90.95% / 90.87% | 578.5k / 776.3k | ¥1.1940 / ¥1.5873 |

四点结论：

1. token 节省在中对话达到峰值 27.6%，长对话与超长对话仍保持约 25%，没有随轮次回落。原因是 PTC 减少了工具往返，上下文引擎压低了每轮注入，两者叠加后不被窗口上限抵消。
2. 耗时全程低于传统框架，节省 9.8% 到 33.2%。超长对话 650.3s 对 919.4s，快 29.3%；工具调用 247 次对 404 次，说明减少往返确实换回了墙钟时间。
3. 缓存命中率两个变体都在 90% 到 93%，不是这次差异的主要来源。真正的差异是每轮发送的上下文体积与工具往返次数；未命中 tokens 在超长对话为 57.9 万对 77.6 万，少 25.5%。费用按官方单价计算后，超长对话为 ¥1.1940 对 ¥1.5873，同样低约四分之一。
4. 准确率全部为 100%，按产物文件校验。优化版没有为了省 token 或省时间牺牲任务成功率。

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

`example:minimal` 演示历史窗口、前缀指纹、工具结果蒸馏与回读。`example:context` 演示单轮上下文引擎：明确路径才预取、产出索引、第二次引用直接命中缓存。`example:ptc` 在一个临时工作区里跑一次 PTC 批量搜索。`benchmark:report` 会读取 `benchmark/data/` 下的原始 JSON，在 `benchmark/output/` 生成 `benchmark-report.html` 和 `benchmark-summary.json`。仓库内附了一份预生成报告，可直接打开 `benchmark/report-preview.html` 查看。

当前 25 个测试文件、155 项测试全部通过。

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
  cache-metrics.js    按天追加缓存命中日志
  cache-usage.js      多供应商缓存用量字段归一化与缓存能力判断
  context-prefetch.js 单轮预取与工作区索引
  cold-facts.js       冷事实抽取
  artifact-index.js   产物索引与复用判定
  task-memo.js        任务备忘
  turn-context.js     单轮上下文统一装配
  window-context.js   被挤出轮次摘要与窗口恢复
  context-policy.js   蒸馏、裁剪与降级策略
  plan-inline.js      计划内联
  worker-prompt.js    子 Agent 提示词与工具白名单
  prefix-diff.js      前缀漂移归因
  task-scheduler.js   子任务调度策略
  orchestration-metrics.js 编排指标
  benchmark-metrics.js 基准汇总与费用估算
  paths.js            工作区路径约束
  embeddings.js       向量检索配置与请求
  ptc/                PTC 语法校验、沙箱、类型化工具与追踪
test/                 25 个核心单元与模拟测试
examples/             最小接入、上下文引擎与 PTC 示例
benchmark/
  data/               真实分组基准原始结果
  report.mjs          报告生成脚本
  report-preview.html 预生成报告
  README.md           基准口径与数据说明
docs/
  cache-stability.md  缓存命中率修复的完整过程
  ptc.md              PTC 设计与安全边界
  integration.md      接入指南
  release-gitee.md    Gitee 发布步骤
```

## 已知限制

- 只包含内核，不能直接启动一个可对话的 Web 应用。
- 基准的传统版在中、长、超长分组只跑 1 次，样本量偏小，结论应看趋势而非小数点。
- 只在 Windows 与 Node 20 环境完整验证，Linux 与 macOS 尚未系统测试。
- PTC 的批量代码质量依赖模型能力。一次读取文件过多时，小模型容易出现漏读，应限制单次批量规模。
- 极短对话的收益有限：10 轮场景 token 少 6.1%、费用少 3.5%，初始化和调度开销占比更高，这个规模不适合作为主场景。

## 路线图

1. 批量回读：一次读取多个 `result_id` 的片段，减少长对话里的回读往返。
2. 聚合下推：引导模型在 PTC 脚本内完成计数、去重、排序和字段投影，只返回结果。
3. 第二阶段压缩：在离线评估确认净收益后按任务类型灰度开启。
4. 多模型评测：给出不同模型下 PTC 批量规模的安全上限。
5. 跨平台验证与 CI：把前缀稳定性与准确率回归接入持续集成。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的流程私下报告。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

发布到 Gitee 的完整命令与检查清单见 [docs/release-gitee.md](docs/release-gitee.md)。

## 许可证

[MIT](LICENSE)
