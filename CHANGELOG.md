# Changelog

## 0.2.0 - 2026-11-23

与 AgentProject 优化版内核同步，补齐单轮上下文引擎与调度策略。

### Added

- 单轮上下文装配 `buildTurnContext`：预取、冷事实、产出索引、任务备忘统一追加到稳定前缀之后。
- 上下文预取：明确路径/符号才读正文，其余只给工作区索引；按 mtime/size/hash 短路。
- 冷事实抽取与旧轮次引用判断，窗口裁剪后仍能补回已确认信息。
- 产出索引与复用判定，避免重复读取同一份产物。
- 任务签名与备忘提示，同一任务重复请求时复用上次结论。
- 被挤出轮次的确定性摘要 `createWindowContext` 与窗口恢复。
- 上下文策略 `context-policy`：按上下文占比决定蒸馏、裁剪与旧结果降级。
- 计划内联 `plan-inline` 与破坏性计划识别。
- 子 Agent 提示词与工具白名单 `worker-prompt`。
- 前缀漂移归因 `prefix-diff`，可按轮定位缓存未命中来源。
- 调度策略 `task-scheduler`：时长校准、粒度校验、写集合互斥、软截止、对冲与重派。
- 编排指标 `orchestration-metrics` 与基准费用估算 `benchmark-metrics`。
- 供应商缓存能力判断 `supportsPrefixCache` / `cacheStrategyFor`。

### Changed

- 基准数据更新为 2026-11-22 的五组真实结果（10 / 20 / 50 / 70 / 100 轮），对照组改为传统框架（原生 function calling + 全量历史）。
- 报告生成器按数据文件的 `prices` 字段计价，修正此前费用口径偏低的问题；README 与 benchmark 说明同步更新。
- 历史窗口默认值改为软 48 条 / 6 万字符、硬 64 条 / 9 万字符；字符超限时支持按字符间隔滞后裁剪。
- `resolveTokenOpt` 支持按上下文窗口推导工具结果预算，新增 `distillMinChars`、`distillPreviewChars`、`phase1OverflowTokens`、`suppressMidRunCompaction`。
- `distillToolResult` 新增 `minChars` 与 `previewChars`，中等结果优先保留原文，减少回读往返。
- `selectCompactionRange` 支持 `maxEndAbs`，当前用户轮次不进入压缩范围。
- `normalizeCacheUsage` 增加 `cache_reported`，区分“0% 命中”和“供应商未上报”。
- PTC 解析、沙箱、规格与工具层同步到优化版实现。

### Tests

- 25 个测试文件、152 项测试全部通过，新增上下文引擎、调度策略、前缀归因与编排指标测试。

## 0.1.0 - 2026-11-21

首个开源内核版本。

### Added

- 滞后裁剪历史窗口，保证两次裁剪之间请求前缀只追加。
- 稳定序列化、工具定义排序、前缀哈希与完整请求指纹。
- 工具结果蒸馏、密钥脱敏、落盘、TTL 与按行或 JSON Path 回读。
- PTC 程序化只读工具调用：AST 校验、worker 沙箱、类型化 API、审计追踪与状态复用。
- 多供应商缓存字段归一化与按天缓存命中日志。
- 历史事实压缩、压缩范围选择与净收益计算。
- 公共 API 聚合入口 `index.js`，支持子路径导入。
- 最小接入示例与 PTC 示例。
- 四组真实模型基准数据、报告生成脚本与预生成 HTML 报告。
- 接入指南、缓存稳定性文档、PTC 设计文档与 Gitee 发布步骤。

### Tests

- 12 个测试文件、60 项测试全部通过。

### Known limitations

- 只包含内核，不包含 Web 工作台与多 Agent 编排。
- 基准对照组在中、长、超长分组只运行 1 次。
- 超长对话的墙钟耗时仍高于传统方案，主要来自蒸馏后的回读往返。
- 只在 Windows 与 Node 20 环境完整验证。
