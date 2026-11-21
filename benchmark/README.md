# 基准数据与报告

这个目录保留内核抽取版的分组基准原始结果和报告生成脚本。它不是营销页，数据里有不好看的部分，阅读时请先看口径和样本量。

## 数据分组

| 文件前缀 | 轮次 | 说明 |
| --- | --- | --- |
| short | 8 | 短对话，主要验证首次前缀与工具蒸馏 |
| medium | 20 | 中对话，蒸馏收益开始显现 |
| long | 40 | 长对话，压缩与蒸馏的综合收益峰值 |
| ultra | 100 | 超长对话，窗口硬上限成为主要约束 |

每个分组包含 `opt` 与 `base` 两个变体：

- `opt`：开启滞后裁剪、工具结果蒸馏、结果预算与历史压缩。
- `base`：关闭蒸馏与压缩，仅保留同样的窗口裁剪。

对照组不是另一个模型，也不是另一个提示词。它用于回答“同一模型、同一工具、同一任务下，这些 token 优化到底值不值”。对照组仍使用同一套 PTC 工具，因此它衡量的是蒸馏与压缩的增量，不是 PTC 相对原生工具的收益。

## 文件结构

```text
benchmark/
  data/                 原始 JSON，每次运行一个文件
  report.mjs            汇总并生成移动端 HTML 报告
  report-preview.html   预生成报告，StPage 可直接打开
  output/               运行 report.mjs 后生成，已被 .gitignore 忽略
```

原始 JSON 的关键字段：

```text
group          分组 id
variant        opt 或 base
model          模型名
turns          计划轮次
runs           运行次数
results[]      每次运行的明细
  totals       总 token、耗时、缓存命中、工具调用、准确率
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

- 所有数值为多次运行的平均值，`runs` 字段标明实际运行次数。
- 准确率按产物文件自动校验，不是人工打分。
- 总 token 包含大量廉价缓存命中，判断成本应优先看缓存未命中 tokens 和估算费用。
- 对照组每组运行次数较少，结论应看趋势，不要抠小数点。
- 基准在 Windows 与 Node 20 环境采集，其他平台尚未系统验证。
- 超长对话的耗时明显高于对照组，原因是蒸馏后模型增加了回读往返。这是已知短板，不应被 token 节省掩盖。

## 新增基准

1. 在 `data/` 放入同结构的 JSON，文件名以分组前缀开头。
2. 确认 `results[].totals` 包含 `totalTokens`、`durationMs`、`cacheHitTokens`、`cacheMissTokens`、`toolCalls`、`accuracy`。
3. 运行 `npm run benchmark:report`，检查图表和汇总是否完整。
4. 在提交说明中写明模型、轮次、运行次数和采集环境。
