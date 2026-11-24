# 基准数据与报告

这个目录保留内核抽取版的分组基准原始结果和报告生成脚本。它不是营销页，数据里有不好看的部分，阅读时请先看口径和样本量。

## 数据分组

| 文件前缀 | 轮次 | 说明 |
| --- | --- | --- |
| short | 10 | 短对话，主要验证首次前缀与工具蒸馏 |
| medium | 30 | 中对话，PTC 与上下文引擎的收益开始显现 |
| long | 60 | 长对话，接近窗口软上限 |
| xlong | 100 | 超长对话，验证长会话的稳定性与费用 |

最新一批数据采集于 2026 年 11 月 23 日晚间，两个变体合计 820 轮真实对话，0 次错误、0 次超时、0 条异常，四组产物校验全部通过。整体每轮 token 下降 24.4%，耗时下降 22.0%，估算金额下降 23.4%。旧版五组（10 / 20 / 50 / 70 / 100 轮）数据归档在 `data/legacy-2026-11-22/`，报告脚本只读取顶层数据文件。

每个分组包含 `opt` 与 `base` 两个变体：

- `opt`：PTC 程序化工具调用、单轮上下文引擎、滞后裁剪、工具结果蒸馏与自适应预算。
- `base`：传统框架，原生 function calling、全量历史、单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联、任务备忘、蒸馏与压缩。

两个变体使用同一模型、同一任务集、同一提示词。成功与否按产物文件自动校验，不以返回文本比对为准。

## 文件结构

```text
benchmark/
  data/                 原始 JSON，每次运行一个文件
  data/legacy-2026-11-22/ 旧版五组基准数据，仅作历史对照
  report.mjs            汇总并生成移动端 HTML 报告
  report-preview.html   预生成报告，StPage 可直接打开
  output/               运行 report.mjs 后生成，已被 .gitignore 忽略
```

原始 JSON 的关键字段：

```text
group          分组 id
variant        opt 或 base
toolMode       ptc 或 native
model          模型名
turns          计划轮次
runs           运行次数
prices         采集时的单价快照；报告会按官方价重算，不直接采用此字段
results[]      每次运行的明细
  totals       总 token、耗时、缓存命中、工具调用、费用、准确率
  turns[]      每轮耗时、步骤、工具调用、token、是否通过校验
```

## 生成报告

```bash
npm run benchmark:report
```

脚本会读取 `benchmark/data/`，生成：

- `benchmark/output/benchmark-report.html`
- `benchmark/output/benchmark-summary.json`

报告是单文件 HTML，不依赖外部库，手机端可以直接打开。仓库内的 `report-preview.html` 是预生成版本，方便没有 Node 环境时查看。

## 口径与限制

- 所有数值为多次运行的平均值，`runs` 字段标明实际运行次数；短对话 3 次，中、长、超长各 2 次。
- 准确率按产物文件自动校验，不是人工打分。
- 总 token 包含大量廉价缓存命中，判断成本应优先看缓存未命中 tokens 和估算费用。
- 计价统一使用 DeepSeek 官方峰谷价（CNY / 100 万 tokens）：空闲 命中 0.02 / 未命中 1 / 输出 4；高峰 命中 0.04 / 未命中 2 / 输出 8。报告按每次运行开始时间锁定档位，不使用历史数据里的 `prices` 快照。
- 只用 DeepSeek 的原因：其 usage 稳定返回 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`，可以分别按命中价与未命中价计费；其他供应商缺少统一的缓存字段，无法同口径比较。
- 每组 2 到 3 次运行，样本量仍然有限，结论应看趋势，不要抠小数点。
- 基准在 Windows 与 Node 20 环境采集，其他平台尚未系统验证。
- 优化版在四组均比传统版更快、更省；短对话的 token 与费用收益较小，属于初始化开销占比更高的正常现象。
- 单次运行的模型回复长度和工具结果长度会波动，base 走全量历史时这种波动会累积到后续轮次，因此同一分组不同批次的金额降幅可能有几个百分点的差异。

## 新增基准

1. 在 `data/` 放入同结构的 JSON，文件名以分组前缀开头。
2. 确认 `results[].totals` 包含 `totalTokens`、`durationMs`、`cacheHitTokens`、`cacheMissTokens`、`toolCalls`、`accuracy`。
3. 运行 `npm run benchmark:report`，检查图表和汇总是否完整。
4. 在提交说明中写明模型、轮次、运行次数和采集环境。
