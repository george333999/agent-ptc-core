# Changelog

## 0.5.3 - 2026-11-25

只新增说明文档，不改变 API 与运行行为。

### Docs

- `docs/plan-gate.md`：计划闸门的独立说明，包含三个组成部分、完整判定链、一轮内的时序、复杂度阈值影响面、配置方式、与历史裁剪预算的关系、实测结论、典型场景、已知代价与代码索引。
- `docs/plan-prompt-ab.md`、`benchmark/README.md`：补充指向计划闸门机制说明的入口。
- `package.json`、`package-lock.json`：版本号更新为 0.5.3。

## 0.5.2 - 2026-11-25

只修正基准报告的金额口径并补充 A/B 记录，不改变 API 与运行行为。

### Fixed

- `benchmark/report.mjs`：费用图、分组文案与汇总 KPI 统一改为“每轮估算费用”，与 README 表格同口径；修复费用纵轴 0 刻度显示为 `¥0.000000`、以及费用曲线被 0–1 的固定下限压成平线的问题。
- `benchmark/report-preview.html`：用修正后的脚本重新生成。
- `README.md`、`benchmark/README.md`：修正“短、中、长、超长四组优化版费用更低”的表述——长对话组优化版每轮 ¥0.0138，高于传统版 ¥0.0132（高 4.5%），其余三组更低。

### Docs

- `benchmark/README.md`：新增计划提示词与计划闸门的 A/B 记录（long 70 轮、xlong 100 轮）：关闭 planGate 并移除 todo 提示词后 long 费用 −13.2%、xlong −25.0%，准确率保持 100%；只提高强制计划阈值的影响落在单次运行波动内。
- `docs/plan-prompt-ab.md`：计划提示词与计划闸门的独立说明，包含概念区分、基准设置、完整结果表、机制解读、复现命令与样本边界。
- `package.json`、`package-lock.json`：版本号更新为 0.5.2。

## 0.5.1 - 2026-11-25

只增强文档，不改变 API 与运行行为。

### Changed

- `README.md`、`docs/mechanisms.md`、`benchmark/README.md`：补充机制设计约束、每项机制的实际效果、锁机制场景说明、性能边界与 DeepSeek 计价口径。
- 明确优化版墙钟 93.8% 来自模型调用（首 token 83.1%、解码 10.7%），本地工具 5.3%；即使本地工具耗时归零，每轮也只能再快约 6%。
- 明确金额按 DeepSeek 官方空闲价重算（命中 0.02 / 未命中 1 / 输出 4 CNY 每百万 tokens），高峰价为 2 倍；金额是估算值，不是账单。
- `package.json` 与 `package-lock.json` 版本号更新为 0.5.1；测试仍为 45 个文件、334 项，示例与基准脚本重新验证通过。

## 0.5.0 - 2026-11-25

项目名从 `Local-first Agent Workbench` 调整为 `Cache-stable Agent Core`：仓库实际是内核库，不包含 Web 工作台；Gitee 仓库路径暂时保留 `local-first-agent-workbench` 以兼容历史链接。同步 AgentProject P1/P1.1 的核心改动，并刷新五组基准与文档。

### Added

- `server/history-window.js`：新增 `historyLimitsForContext(contextWindow)`，按模型窗口 97% 推导硬上限、硬上限 50% 作为软上限；旧版 48/64 条、60k/150k 字符默认值继续保留，供显式 limits 使用。
- `server/turn-context.js`：新增 `resolveTurnContextBudget()`，前 3 个用户轮次自动把索引条目 240→120、预取 8000→4000 字符、事实/产出块 1000→400 token。
- `docs/mechanisms.md`：机制全景文档，逐项说明每项机制解决的问题、生效位置、模块交互、代价边界与验证文件。
- `benchmark/data/legacy-2026-11-23/`：归档上一版四组基准数据。

### Changed

- `server/context-policy.js`：轮内紧急裁剪阈值从 90% 提到 97%，避免常规步骤反复重建前缀。
- `README.md`、`docs/integration.md`、`docs/cache-stability.md`、`benchmark/README.md`：同步新预算、五组 500 轮基准和同档价口径；删除“十一项能力”与实际章节数不一致的表述。
- `benchmark/report.mjs`：分组改为 10/20/50/70/100 轮；金额统一按空闲价重算，避免两组运行时段跨峰谷造成 2 倍档位差。
- `package.json`：包名改为 `cache-stable-agent-core`，版本 0.5.0，描述与关键词同步；仓库 URL 暂时保留旧路径。
- 测试增至 45 个文件、334 项。

### Benchmark

- 五组各 1 次运行，优化版与传统版各 250 轮，合计 500 轮；准确率均 100%。
- 整体每轮：优化版 150k token / 6.34s / ¥0.0131，传统版 345k / 8.05s / ¥0.0143；token 低 56.5%、耗时低 21.3%、同档金额低 8.3%。
- 极短对话（10 轮）仍是例外：优化版 token 多 21.8%、费用高 49%，固定开销无法摊薄。
- 墙钟约 93.8% 来自模型侧，每步首 token 延迟 1.10–1.48s，且与 prompt 大小关系不大。

## 0.4.0 - 2026-11-24

与 AgentProject 当前完善版内核同步：补齐主 Agent 任务契约、交付物验收、同轮工具并发调度、上下文超限兜底、LLM 限流治理、单轮延迟归因与并行编排经济性门禁。

### Added

- `server/task-contract.js`：主 Agent 五问自检、完成判据与关键假设归一化、子 Agent 契约段落渲染；自检块只追加到当前用户消息尾部，不破坏前缀缓存。
- `server/deliverable.js`：按动作词后的目标片段识别 xlsx/pptx/docx/pdf/csv/html 交付物，提取用户指定输出路径，避免把输入文件误判为目标产物。
- `server/context-guard.js`：识别供应商上下文超限错误，解析真实上限并按 70% 目标压缩请求视图后重试；重试耗尽时返回可读错误。
- `server/parallel-tools.js`：只读工具并行批次与单调用失败隔离。
- `server/tool-scheduler.js`：同轮工具按路径依赖与屏障并发调度，覆盖写后读、目录扫描、verify 节点、版本化脚本屏障与并发上限。
- `server/output-paths.js`：Chat/Agent 输出目录隔离与工作区路径解析，供工具层与调度器共用。
- `server/limits.js`：200 轮工具上限、40% 进度提醒与收尾预留。
- `server/llm-governor.js`：自适应并发、429 抖动退避、`Retry-After` 解析与长等待熔断。
- `server/latency-metrics.js`：单轮墙钟拆解、首字/解码、阶段归因、PTC 覆盖率、重复读取率与缓存上报状态。
- `server/orchestration-economics.js` 与 `server/orchestration-report.js`：并行收益门槛、串行回退结果与编排结果报告。
- `server/locks.js`：轻量按 key 互斥 `KeyedMutex`。
- 新增 13 个测试文件，覆盖任务契约、交付物、上下文超限、并行工具、工具调度、输出路径、轮次预算、LLM 治理、延迟指标、编排经济性、编排报告、路径缓存与轻量互斥；同时更新锁、验证调度与 worker 提示词测试。

### Changed

- `server/paths.js`：工作区根使用原生 `realpath` 缓存（LRU + TTL），新增 `invalidatePathCache` 与 `pathCacheStats`；PTC 与直连工具共用同一份根缓存。
- `server/resource-locks.js`：版本指纹加入内容短哈希，外部工具改写内容但保留大小与 mtime 时也能检出；同一请求内读写同一路径自动升级为写锁，不再抛 `LOCK_UPGRADE`。
- `server/verify-scheduler.js`：缓存命中与正常执行都返回 `waitMs`，验证排队时间可归因到单轮延迟。
- `server/worker-prompt.js`：子 Agent 明确不做自检，只消费主 Agent 下发的完成判据与假设；缺少判据时以 `expectedOutput` 验收并标记 `partial`。
- `server/command-scope.js`、`server/task-type.js`：原生 Excel 写入工具 `write_xlsx` 按写工具加锁并归类为 `edit`。
- `server/ptc/index.js`、`server/ptc/tools.js`：补充“禁止 endLine+1 逐行试探、交付物写完后停止探索”的提示，并复用共享工作区根缓存。
- `index.js` 与 `package.json` 增加任务契约、交付物、上下文守卫、工具调度、LLM 治理、延迟、经济性、报告、路径与互斥子路径导出。
- 仓库测试增至 42 个文件、331 项。

### Fixed

- 同一请求读写同一文件被误判为非法升级，导致批量原地修改失败。
- 外部工具保留 mtime 与大小改写内容时，验证快照漏检。
- 验证排队时间未进入返回值，长尾无法归因。
- PTC 与直连工具各自缓存工作区根，极端情况下可能解析出不同根路径。

## 0.3.1 - 2026-11-24

补齐文件密集场景的 PTC 性能与边界处理，并清理公开基准数据中的本机临时路径。

### Added

- `files.list` 支持 `offset` / `limit` / `nextOffset` 分页：每页最多 400 条，扁平的 500+ 文件目录可以完整枚举。
- `files.search` 返回 `skippedLarge`：超过 1MB 的目录文件（单文件 2MB）不再静默跳过，空结果时会给出可执行提示。
- PTC 只读正文缓存：按绝对路径、mtime 与 size 复用，刚写入的文件强制重读。
- 补齐 PTC 预算决策与校验恢复模块：预算用尽时提供继续 / 转直连 / 自由输入三种选择，静态校验失败自动纠错 2 次后降级。
- 新增 PTC 边界、搜索、预算决策与校验恢复测试，覆盖分页、50 路径、字符上限、超大文件、路径越界与缓存失效。

### Changed

- `files.readMany` 上限从 20 提升到 50，重复路径只读一次，内部改为异步有界并发读取。
- `files.read`、`files.list`、`files.search` 改为异步路径解析，工作区根只做一次 realpath；目录搜索先收集路径，再分块并发读正文，避免同步 stat 阻塞主线程。
- PTC 工具描述与 worker 提示词同步更新：删除“一次最多 8 个文件”的旧约束，补充分页、50 路径上限、24000 字符结果上限与文件密集任务策略。
- 仓库测试增至 32 个文件、247 项。
- 基准 JSON 中的本机 `workspace` 字段统一脱敏为 `<benchmark-temp>`，基准生成脚本不再写入真实临时路径。

### Fixed

- 搜索命中正好 200 条时被误标为 `truncated`；现在只有出现第 201 条才标记截断。
- 超大文件在目录搜索中被跳过但返回 0 条且无提示；现在通过 `skippedLarge` 与 `hint` 显式告知。
- 目录搜索逐文件 `statSync` 导致主线程阻塞；现在大小过滤下沉到异步读取阶段。

## 0.3.0 - 2026-11-23

与 AgentProject 当前优化版内核同步，新增并发写锁、命令作用域与验证调度，并更新基准与文档。

### Added

- `server/resource-locks.js`：文件、目录与工作区粒度的读写锁，支持写者优先、队头跳过、超时、取消与不可重入检测。
- `server/command-scope.js`：从 `node --test`、`pytest`、`go test ./pkg/...`、`tsc -p` 推断命令作用域，无法判断时回退工作区锁；`planToolLocks` 覆盖只读、写入与命令类工具。
- `server/verify-scheduler.js`：相同验证合并、输入版本快照、stale 重跑、每工作区并发控制与结果缓存。
- `VersionStore`：记录文件版本、大小、修改时间与短哈希，供验证判断输入是否过期。
- `docs/concurrency.md`：锁、作用域与验证调度的语义、接入示例、指标与边界。
- 新增 3 个测试文件，仓库测试增至 28 个文件、224 项。

### Changed

- 同步当前内核的上下文窗口、轮次策略、工具蒸馏、工具结果注入、PTC 校验与 worker 提示实现。
- 基准更新为短 10 轮、中 30 轮、长 60 轮、超长 100 轮，短组 3 次运行、其余各 2 次，两个变体合计 820 轮；旧版五组数据归档到 `benchmark/data/legacy-2026-11-22/`。
- README、接入文档、缓存稳定性文档统一到最新口径；公共 API 增加锁、作用域、验证调度、轮次策略与工具注入相关导出。
- 版本号提升到 0.3.0，新增 `./locks`、`./scope`、`./verify` 子路径导出。

### Fixed

- 推断作用域不再缓存验证结果：推断输入可能漏掉被 import 的源码，缓存会把失败误报成通过；只有显式 scope 才允许缓存。
- 锁超时定时器不再提前解除引用，避免进程在没有其他句柄时退出。
- 读请求可以跳过被无关写锁挡住的请求，同时保持写者优先，避免队头阻塞。

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
- 报告与基准脚本统一按 DeepSeek 官方峰谷价计价：空闲 命中 0.02 / 未命中 1 / 输出 4，高峰 0.04 / 2 / 8（CNY / 100 万 tokens），按每次运行开始时间锁定档位；不再采用历史数据里自定的单价。README 与 benchmark 说明补充了只用 DeepSeek 计价的 usage 原因。
- 历史窗口默认值改为软 48 条 / 6 万字符、硬 64 条 / 9 万字符；字符超限时支持按字符间隔滞后裁剪。
- `resolveTokenOpt` 支持按上下文窗口推导工具结果预算，新增 `distillMinChars`、`distillPreviewChars`、`phase1OverflowTokens`、`suppressMidRunCompaction`。
- `distillToolResult` 新增 `minChars` 与 `previewChars`，中等结果优先保留原文，减少回读往返。
- `selectCompactionRange` 支持 `maxEndAbs`，当前用户轮次不进入压缩范围。
- `normalizeCacheUsage` 增加 `cache_reported`，区分“0% 命中”和“供应商未上报”。
- PTC 解析、沙箱、规格与工具层同步到优化版实现。

### Tests

- 25 个测试文件、155 项测试全部通过，新增上下文引擎、调度策略、前缀归因、编排指标与官方峰谷计价测试。

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
- 超长对话的墙钟耗时仍高于传统方案，主要来自蒸馏后的回读往返（0.1.0 时期；0.5.0 起五组基准中超长组已低于传统方案）。
- 只在 Windows 与 Node 20 环境完整验证。
