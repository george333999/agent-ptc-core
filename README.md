# Agent PTC Core

这是从 AgentProject 中提炼出的“Orchestrator-Worker + PTC（Programmatic Tool Calling）”核心结构参考实现。

它保留了真实可运行的 PTC 沙箱、DAG 调度和 Worker 编排；`demo/` 用一个脚本化模型演示“读取 6 个文件”如何变成 2 个 Worker、每个 Worker 1 次 `ptc_run` 批量读取。

## 快速开始

```bash
npm install
npm run demo
npm test
```

`npm run demo` 不调用真实模型，不需要 API Key；它使用脚本化 `chatRunner` 驱动 Worker，实际执行 PTC 沙箱和只读文件工具。

## 结构

```text
主 Agent (Orchestrator)
  ├─ 拆解任务 → DAG
  ├─ 派发 N 个 Worker（并发上限 4，子任务上限 8）
  │    ├─ 每个 Worker 独立上下文 / 独立 PTC 命名空间
  │    ├─ Worker 调用 ptc_run
  │    ├─ PTC 静态校验 → worker_threads 沙箱
  │    └─ 代码中批量调用 files.read/search 等只读工具
  └─ 汇总结构化结果 → 冲突检测 → 主 Agent 仲裁
```

## 文件说明

### 最小核心

- `src/orchestrator.js`
  - DAG 校验、环检测、并行同文件写入冲突检测
  - Worker 调度、并发控制、依赖传递
  - 单 Worker 超时、总超时、连续失败熔断
  - Worker 结果规范化、冲突检测、结构化报告
  - 通过 `chatRunner` / `toolRunner` / `workerRunner` 注入宿主能力

- `src/ptc/index.js`
  - PTC 对外唯一入口 `ptc_run`
  - 工具定义、引擎单例、run/scope 释放
- `src/ptc/engine.js`
  - 每次执行生成 `tr_ptc_` trace ID
  - 每个任务/子 Agent 一个 worker 线程和一个命名空间
  - 墙钟超时、工具调用预算、I-PTC 状态复用
  - 工具错误统一经过 `onToolError` 钩子并审计
- `src/ptc/worker.js`
  - 在 `vm` + `worker_threads` 中执行模型生成的代码
  - 受限全局对象，不暴露 `process` / `require` / 动态 `import`
- `src/ptc/specs.js`
  - `files.list`、`files.read`、`files.search`、`knowledge.search`、`skills.read` 的参数规格
- `src/ptc/tools.js`
  - 类型化只读工具实现，参数逐项校验，返回规范 JSON
- `src/ptc/ast-validator.js`
  - 三层 AST 静态校验：语法 → 逃逸/危险语法 → 命名空间/绑定
- `src/ptc/trace.js`
  - `tr_ptc_` 追踪、审计日志、模型调试日志
- `src/ptc/metrics.js`
  - PTC 与原生工具调用的 token 预测模型

### 宿主集成参考

`src/reference/` 是从 AgentProject 复制出来的宿主侧文件，用于展示 PTC 如何接入完整 Agent：

- `agent.js`：主 Agent 循环、`runSubAgent`、`ptc_run` 接入、每轮 token 累加
- `tools.js`：PTC 模式工具定义收口、`task` / `orchestrate` / `ptc_run` 分支
- `paths.js`：工作区路径约束
- `embeddings.js`：知识库检索配置

这些文件依赖 AgentProject 的其它模块（providers、store、websearch 等），不保证在本目录直接运行；它们用于对照集成方式。

## 关键设计

1. **PTC 只读**
   - 沙箱只暴露只读工具；写文件、命令、MCP 仍走直连工具，并经审批。
   - PTC 负责“批量读、过滤、聚合”，直连工具负责“有副作用的操作”。

2. **三层静态校验**
   - 第一层：语法解析
   - 第二层：拒绝 `process`、`require`、动态 import、`this`、`class`、`new`、动态属性访问等逃逸面
   - 第三层：只允许已声明/已持久化的命名空间方法与绑定

3. **I-PTC 状态**
   - 同一任务内多次 `ptc_run` 复用 `state` 和顶层变量/函数。
   - 子 Agent / Worker 使用独立 scope，避免并行时共享状态；任务结束立即释放。

4. **Worker 隔离**
   - Worker 只拿到任务简报、约束、已知信息和上游结果，不继承完整对话历史。
   - 每个 Worker 有独立 PTC 命名空间，避免互相排队和状态污染。

5. **可仲裁结果**
   - Worker 返回 `status`、`result`、`evidence`、`confidence`、`open_questions`。
   - 主 Agent 根据冲突检测结果决定是否重派或人工确认。

## 宿主需要提供的能力

核心 `orchestrator.js` 不直接依赖具体模型或工具，运行时必须注入：

- `chatRunner({ model, messages, tools, temperature, signal })`
- `toolRunner(name, args, ctx)`
- `buildWorkerTools({ settings, task, allowAskUser, ptc })`：返回该 Worker 可用的工具 schema
- 可选 `requestPlanApproval({ plan })`
- 可选 `askUser({ question, options, allowFreeText, task })`
- `workspace`、`session`、`runId`、`fileHistory`、`workspaceQuotaBytes` 等上下文

`demo/run.mjs` 展示了最小注入方式：`chatRunner` 用脚本返回 `ptc_run`，`toolRunner` 转发到 `runPtcTool`，`buildWorkerTools` 只返回 `ptc_run`。

PTC 侧需要宿主提供：

- `workspace`：只读工具解析路径的根目录
- `settings`：`disabledTools`、`ptcAudit`、`ptcTimeoutMs`
- 可选 `knowledge`、`skills`：知识库和技能读取能力

## 适用场景

- 读多写少的代码库探索、批量检索、跨目录分析
- 可拆成独立子任务的复杂问题
- 需要上下文隔离、结构化汇总和人工仲裁的任务

不适用：

- 强顺序、强共享状态的写操作
- 极小任务（拆解成本高于收益）
- 模型代码生成能力较弱且没有重派机制的场景

## 真实测试结论

在 45 个文件读取任务上，本地 `qwen2.5:7b` 的真实结果：

- 传统单 Agent：45/45，169.6k tokens，59.7s
- 多 Agent + PTC 首轮：6/45，约 25.1k tokens
- 缺口重派后：45/45，123.6k tokens，170.0s

结论：结构成立，token 优势明显；但小模型生成多文件 PTC 代码不稳定，需要限制每个 Worker 的批量规模或使用代码能力更强的模型。

## 使用建议

如果要把它作为开源参考实现：

1. 先补一个最小可运行示例和依赖注入适配层。
2. 把 `agent.js` / `tools.js` 中与 PTC/编排无关的工具拆掉。
3. 为 PTC 增加更明确的宿主接口文档和沙箱安全说明。
4. 增加 `LICENSE`、贡献指南和版本化 API。
