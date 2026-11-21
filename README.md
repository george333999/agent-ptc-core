# Local-first Agent Workbench Core

> AgentProject 开源内核：用缓存前缀工程把长对话命中率稳定在 90% 左右，用 PTC 沙箱批量执行只读工具，减少模型往返与 token 消耗。

本仓库是 AgentProject 的内核抽取版，保留四项可独立复用的能力：长对话缓存稳定性、工具结果蒸馏与回读、PTC 程序化只读工具调用、可复现的分组基准报告。完整工作台中的 Web 编辑器、多 Agent 编排、MCP、OCR 与文档处理没有包含在本仓库中。

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
| `server/cache-usage.js` | OpenAI、DeepSeek、Anthropic 缓存字段归一化 |
| `server/cache-metrics.js` | 按天追加缓存命中日志，失败不影响主流程 |
| `server/paths.js` | 工作区路径约束与越界校验 |
| `server/embeddings.js` | 向量检索配置与请求 |
| `server/ptc/` | PTC 语法校验、worker 沙箱、类型化只读工具、审计追踪 |
| `index.js` | 公共 API 聚合导出 |

## 公共 API

```js
import {
  resolveLaggingWindow,
  buildRequestFingerprint,
  distillToolResult,
  readStoredToolResult,
  buildPtcToolDefinition,
  runPtcTool
} from 'local-first-agent-workbench-core';
```

也可以按子路径导入：

```js
import { resolveLaggingWindow } from 'local-first-agent-workbench-core/history';
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

默认参数为软上限 48 条、硬上限 64 条；超过硬上限后裁到软上限，下一次裁剪至少要再增长 16 条。效果是连续两轮请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。

### 2. 工具结果蒸馏与回读

工具输出超过预算时，完整内容落盘，历史里只保留结构化摘要和 `result_id`：工具名、字符数、行数、字节数、JSON 结构、少量预览。模型需要细节时调用 `read_tool_result`，支持按行、按字符区间或 JSON Path 精确读取。

这样做的好处是上下文只保留决策需要的信息，而不是整份文件；代价是多一次回读往返。基准数据显示这个取舍在 40 轮左右收益最高，在 100 轮时会被窗口上限抵消一部分。

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
await files.search({ query, path, glob, target, caseSensitive })
await knowledge.search({ query, topK })
await skills.read({ name })
```

同一任务的多次 `ptc_run` 共享 `state` 与顶层变量，需要清空时传 `reset: true`。写文件、编辑、执行命令、MCP 与子 Agent 仍然走直连工具，不进入 PTC。

### 4. 可复现的分组基准

`benchmark/` 下保留了短对话 8 轮、中对话 20 轮、长对话 40 轮、超长对话 100 轮的原始结果与报告生成脚本。报告是单文件 HTML，图表不依赖外部库，手机端可以直接打开。

结果口径：

- 优化版：开启历史窗口、工具结果蒸馏与结果预算。
- 对照版：关闭蒸馏与压缩，保留同样的 64 条消息窗口裁剪。
- 同模型、同工具、同提示词，按产物文件自动校验准确率。

对照版仍使用同一套 PTC 工具，因此这里的数字衡量的是蒸馏与压缩的增量，不是 PTC 相对原生工具的收益。PTC 与原生工具的完整对比需要单独的工具模式基线，不在本仓库的基准范围内。

## 基准结果

模型为 deepseek-chat，累计 412 轮真实对话。数值为多次运行的平均值。

| 分组 | 轮次 | 优化版 tokens | 对照版 tokens | token 变化 | 优化版耗时 | 对照版耗时 | 准确率（优化/对照） | 缓存命中（优化/对照） | 未命中（优化/对照） | 估算费用（优化/对照） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 短对话 | 8 | 376.3k | 393.4k | 少 4.4% | 48.1s | 47.6s | 100% / 100% | 92.0% / 90.5% | 29.5k / 36.7k | ¥0.0487 / ¥0.0552 |
| 中对话 | 20 | 1.14M | 1.38M | 少 17.1% | 123.3s | 132.1s | 100% / 100% | 92.9% / 89.0% | 79.6k / 149.1k | ¥0.1355 / ¥0.2103 |
| 长对话 | 40 | 1.74M | 2.32M | 少 25.0% | 255.3s | 206.5s | 98.75% / 100% | 90.7% / 85.7% | 157.9k / 327.8k | ¥0.2617 / ¥0.4279 |
| 超长对话 | 100 | 4.99M | 5.56M | 少 10.3% | 824.4s | 479.5s | 99% / 100% | 89.9% / 83.0% | 493.7k / 933.7k | ¥0.8305 / ¥1.1609 |

三点结论，包括不好看的部分：

1. token 节省在 40 轮达到峰值 25%，100 轮回落到 10%。原因是窗口硬上限把两侧都裁到相近规模，压缩空间被封顶。
2. 缓存命中率稳定在 90% 附近，100 轮的缓存未命中从约 93.4 万降到约 49.4 万。未命中单价更高，按计费口径收益大于表面 token 差。
3. 超长对话耗时比对照版多约 72%。蒸馏省下了上下文，但模型为了拿回细节增加了回读调用，工具调用从 222 次涨到 351 次。这是当前最明确的短板，也是下一步优化的第一优先级。

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
npm run example:ptc
npm run benchmark:report
```

`example:minimal` 演示历史窗口、前缀指纹、工具结果蒸馏与回读。`example:ptc` 在一个临时工作区里跑一次 PTC 批量搜索。`benchmark:report` 会读取 `benchmark/data/` 下的原始 JSON，在 `benchmark/output/` 生成 `benchmark-report.html` 和 `benchmark-summary.json`。仓库内附了一份预生成报告，可直接打开 `benchmark/report-preview.html` 查看。

当前 12 个测试文件、60 项测试全部通过。

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
  cache-usage.js      多供应商缓存用量字段归一化
  paths.js            工作区路径约束
  embeddings.js       向量检索配置与请求
  ptc/                PTC 语法校验、沙箱、类型化工具与追踪
test/                 12 个核心单元与模拟测试
examples/             最小接入示例与 PTC 示例
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
- 基准的对照组在中、长、超长分组只跑 1 次，样本量偏小，结论应看趋势而非小数点。
- 只在 Windows 与 Node 20 环境完整验证，Linux 与 macOS 尚未系统测试。
- PTC 的批量代码质量依赖模型能力。一次读取文件过多时，小模型容易出现漏读，应限制单次批量规模。
- 超长对话的延迟仍高于传统方案，尚未做自适应蒸馏预算。

## 路线图

1. 自适应蒸馏预算：按任务类型决定保留原文还是摘要，减少无意义回读。
2. 聚合下推：引导模型在 PTC 脚本内完成计数、去重、排序和字段投影，只返回结果。
3. 批量回读：一次读取多个 `result_id` 的片段，减少往返次数。
4. 第二阶段压缩：在离线评估确认净收益后按任务类型灰度开启。
5. 多模型评测：给出不同模型下 PTC 批量规模的安全上限。
6. 跨平台验证与 CI：把前缀稳定性与准确率回归接入持续集成。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 的流程私下报告。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

发布到 Gitee 的完整命令与检查清单见 [docs/release-gitee.md](docs/release-gitee.md)。

## 许可证

[MIT](LICENSE)
