# 接入指南

这个仓库不是一个可以直接对话的 Web 应用，而是一组可以嵌进现有 Agent 循环的内核模块。下面给出最小接入顺序，完整可运行版本见 `examples/minimal-agent.mjs` 与 `examples/ptc-batch.mjs`。

## 1. 请求前：取历史窗口并记录前缀

```js
import {
  historyLimitsForContext,
  resolveLaggingWindow,
  buildRequestFingerprint,
  commonPrefixRatio
} from 'cache-stable-agent-core';

// 长会话推荐：按模型窗口推导预算（硬上限 97%，软上限取硬上限的 50%）。
// 兼容旧行为可显式传 { softMessages: 48, hardMessages: 64, softChars: 60000, hardChars: 150000 }。
const limits = historyLimitsForContext(model.contextWindow || 128000);

let lastTrimLength = session.historyWindowLength || 0;
const { window, trimmed, windowLength } = resolveLaggingWindow(
  allHistory,
  lastTrimLength,
  limits,
  { lastTrimChars: session.historyWindowChars }
);
if (trimmed) {
  session.historyWindowLength = windowLength;
}

const fingerprint = buildRequestFingerprint({ system, tools, messages: window });
// 把 fingerprint.hash 写入日志，下一轮用 commonPrefixRatio 判断前缀是否被改动。
```

关键点：

- `system` 与 `tools` 必须字节稳定。对象键顺序交给 `stableStringify`，工具定义交给 `sortToolDefinitions`。
- 不要在历史中间插入时间戳、进度、临时摘要。所有易变信息只追加到消息尾部。
- 只有 `trimmed` 为真时才更新窗口长度，避免每轮都触发滑窗。

## 2. 任务契约与交付物

主 Agent 在复杂任务上先做一次固定自检。自检块只追加到当前用户消息尾部，不修改 system 与 tools：

```js
import { buildSocraticBrief, shouldUseSocraticBrief } from 'cache-stable-agent-core';

if (shouldUseSocraticBrief({ mode: 'agent', complexTask })) {
  messages[messages.length - 1].content += `\n\n${buildSocraticBrief()}`;
}
```

自检产出的完成判据与关键假设用 `normalizeContract` 归一化，并在派发子 Agent 时随任务简报下发：

```js
import {
  normalizeContract,
  renderDefinitionOfDone,
  renderAssumptions
} from 'cache-stable-agent-core';

const contract = normalizeContract(planInput);
const doneSection = renderDefinitionOfDone(contract.definitionOfDone);
const assumptionSection = renderAssumptions(contract.assumptions);
```

边界：

- 自检只属于主 Agent。子 Agent 没有完整对话，重复自问会导致假设分裂；缺少完成判据时以 `expectedOutput` 验收，并标记 `partial`、写入 `open_questions`。
- 自检块必须保持字节稳定，不包含时间、任务 ID 或随机数。

交付物契约用于验收，不替代执行：

```js
import {
  requiredDeliverableKinds,
  requiresWorkspaceDeliverable,
  deliverableExtensions
} from 'cache-stable-agent-core';

const kinds = requiredDeliverableKinds(userMessage); // 例如 ['xlsx']
const extensions = deliverableExtensions(kinds);     // ['.xlsx']
const needsFile = requiresWorkspaceDeliverable(userMessage);
```

工具成功落盘后按扩展名标记完成。用户要求 Excel 却只写了脚本时，应继续提醒或执行，不能把脚本当成交付物；判断只看动作词之后的目标片段，避免把输入文件误认成目标产物。

## 3. 工具返回后：决定是否蒸馏

```js
import { distillToolResult, readStoredToolResult, resolveTokenOpt } from 'cache-stable-agent-core';

const tokenOpt = resolveTokenOpt(settings, { contextWindow: model.contextWindow });
const distilled = distillToolResult({
  dataDir,
  sessionId: session.id,
  callId: toolCall.id,
  toolName: toolCall.name,
  output: fullOutput,
  budgets: tokenOpt.toolBudgets,
  enabled: tokenOpt.toolResultDistill,
  minChars: tokenOpt.distillMinChars,
  previewChars: tokenOpt.distillPreviewChars
});

// 写入模型历史的是 distilled.content；界面展示仍使用 fullOutput。
history.push({ role: 'tool', content: distilled.content });

// 模型要求细节时：
const slice = readStoredToolResult({
  dataDir,
  resultId: distilled.ref.resultId,
  startLine: 1,
  endLine: 200
});
```

注意：

- 落盘失败时 `distilled` 为 false，`content` 会退回完整内容，不影响主流程。
- 摘要会按常见密钥格式脱敏，但不要把未知格式的密钥交给不可信模型。
- 回读会增加一轮模型往返。对短结果不要蒸馏；20 轮以上的任务收益更明显，10 轮以内收益有限。

## 4. 批量只读操作：使用 PTC

```js
import { buildPtcToolDefinition, runPtcTool, shutdownPtc } from 'cache-stable-agent-core';

const toolDefinition = buildPtcToolDefinition();
// 把 toolDefinition 注册到模型的 tools 列表，和其他工具一起排序。

const result = await runPtcTool(
  {
    code: `
      const found = await files.search({ query: 'TODO', path: 'src', target: 'content' });
      return { count: found.count, matches: found.matches.slice(0, 20) };
    `
  },
  {
    workspace,
    session: { id: session.id },
    runId,
    settings: { ptcAudit: true, ptcTimeoutMs: 8000 }
  }
);

await shutdownPtc();
```

PTC 只暴露只读工具。写文件、编辑、执行命令、MCP 和子 Agent 仍然走直连工具，避免把有副作用的操作放进沙盒。

文件密集时先 `files.list` 分页或 `files.search` 缩小范围，再按最多 50 个路径调用 `files.readMany`。单次 `ptc_run` 结果上限 24000 字符，程序内应完成计数、去重和字段投影，不要返回多份全文。

## 5. 每次模型返回后：记录缓存样本

```js
import { normalizeCacheUsage, recordCacheSample, cacheMetricsDir } from 'cache-stable-agent-core';

const usage = normalizeCacheUsage(response.usage);
await recordCacheSample(cacheMetricsDir(dataDir), {
  sessionId: session.id,
  runId,
  workerId,
  model: response.model,
  ...usage
});
```

日志按天写入 JSONL，只记录 token 计数、前缀哈希和任务标识，不记录提示词正文。`normalizeCacheUsage` 会返回 `cache_reported`：供应商没有上报缓存字段时为 false，此时命中率应显示未知，而不是 0%。

## 6. 单轮上下文：预取、冷事实、产出索引与备忘

```js
import { buildTurnContext } from 'cache-stable-agent-core';

const turn = buildTurnContext({
  session,
  message: userMessage,
  settings,
  workspace,
  baseModelContent: userMessage,
  knowledgeContext
});
// turn.modelContent 作为本轮用户消息发给模型。
// 所有注入块都追加在稳定前缀之后，不改变 system 与 tools。
```

- 只有消息里出现明确路径、行范围或符号时才预取文件正文，其余情况只给工作区索引。
- 预取缓存挂在会话对象上，同一文件未变化时按 mtime/size/hash 短路。
- 冷事实只在用户引用旧轮次时注入，避免窗口裁剪后丢失已确认信息。
- 前 3 个用户轮次会自动启用短会话预算（索引 120 条、预取 4000 字符、事实/产出 400 token）；需要固定大预算时可显式传 `maxPrefetchChars`。
- `settings.contextEngine === false` 时退化为传统全量历史模式，用于对照基准。

完整机制说明见 [mechanisms.md](mechanisms.md)。

## 7. 多 Agent 调度与经济性

```js
import {
  calibrateTasks,
  validateGranularity,
  resolveWriteConflicts,
  resolveSoftDeadline,
  estimateOrchestrationEconomics,
  evaluateEconomicsGate
} from 'cache-stable-agent-core';

const { tasks } = calibrateTasks(plan.tasks, { historyMs });
const granularity = validateGranularity(tasks);
const { tasks: ordered } = resolveWriteConflicts(tasks);
const softDeadlineMs = resolveSoftDeadline({ historyMs });
```

这些函数都是纯函数，不负责真正启动 worker。调度循环读取返回值决定拆几个任务、谁依赖谁、何时判定长尾。`shouldHedge` 与 `shouldRedispatch` 只对可重试且无写入的结果生效，避免重复落盘。

并行前还要判断“并行是否真的划算”：

```js
const economics = estimateOrchestrationEconomics({
  taskCount: ordered.length,
  criticalPathTasks: granularity.criticalPathTasks,
  taskSeconds: 25,
  parentContextTokens: 60000,
  prefixTokens: 18000,
  tailTokens: 6000
});
const gate = evaluateEconomicsGate({ economics, mode: 'advisory' });
```

`mode: 'enforce'` 时，不划算会返回 `allowed: false`，调用方应改为串行执行；默认 `advisory` 只告警，避免误杀长尾任务。`buildOrchestrationSkipResult` 返回与正常编排一致的结构，主 Agent 可以直接切换为串行。执行完成后用 `formatOrchestrationReport` 生成包含子任务结论、冲突与资源使用的可读报告。

## 8. 并发写：先上锁，再执行，最后验证

读操作可以并发，写操作必须互斥；同一批写完之后再跑验证，避免验证读到写了一半的文件。

```js
import path from 'node:path';
import {
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler
} from 'cache-stable-agent-core';

const locks = createResourceLocks();
const verify = createVerifyScheduler({ versions: locks.versions });
const helpers = {
  workspace,
  resolveInput: (rel) => path.join(workspace, rel),
  resolveOutput: (rel) => path.join(workspace, rel)
};

const plan = planToolLocks('write_file', { path: 'src/calc.js' }, helpers);
const lease = await locks.acquire(
  { reads: plan.reads, writes: plan.writes },
  { signal, timeoutMs: 30000 }
);
try {
  await writeFile(path.join(workspace, 'src/calc.js'), next);
  // 写入成功后递增版本，供验证调度判断输入是否过期
  locks.versions.bumpKeys(plan.writes);
} finally {
  lease.release();
}

const verifyPlan = planToolLocks('run_command', {
  command: 'node --test tests/calc.test.js'
}, helpers);
const result = await verify.run({
  key: verifyPlan.verify.key,
  workspace,
  inputFiles: verifyPlan.verify.inputFiles,
  outputFiles: verifyPlan.verify.outputFiles,
  cacheable: verifyPlan.verify.cacheable,
  execute: () => runCommand('node --test tests/calc.test.js')
});
```

三条规则：

- `planToolLocks` 会覆盖 read、list、search、write、edit、delete 与命令类工具；`ptc_run` 是只读沙箱，不需要锁。
- 显式传入 `scope` 时视为输入集合完整，验证结果可以缓存；由 `node --test`、`pytest`、`go test ./pkg/...`、`tsc -p` 推断出的 scope 不缓存，因为它可能漏掉被 import 的源码。
- 验证期间输入版本发生变化时，调度器会把结果标记为 stale 并重跑，最多到 `maxRuns`；不同作用域之间可以并行。

详细语义与测试见 [concurrency.md](concurrency.md)。

## 9. 同轮工具并发调度

同一轮模型可能返回多个工具调用。`createToolScheduler` 按路径依赖把它们分成可并发与屏障两类：

```js
import { createToolScheduler } from 'cache-stable-agent-core';

const scheduler = createToolScheduler({
  calls,
  ctx: { workspace, mode, outputRel },
  execute: (call, args) => executeTool(call.name, args, ctx),
  isBlocked: (call) => needsApproval(call)
});

for (const call of calls) {
  const early = scheduler.claim(call.id);
  if (early) {
    handle(await early);
    continue;
  }
  await scheduler.drain(call.id);
  const args = JSON.parse(call.arguments || '{}');
  handle({ call, ok: true, value: await executeTool(call.name, args, ctx) });
}
```

规则：

- 不同路径的写可以并发；同一路径的写按原顺序串行。
- 写后读同一文件必须等待写入完成；目录扫描与子文件写按祖先关系排序。
- 带显式或可推断 scope 的 `run_command` 是 verify 节点，未知命令与需要审批的调用是屏障。
- `_v43.py` 这类同脚本多版本写入强制走屏障，避免预执行绕过版本爆炸守卫。
- 默认并发上限 4，`AGENT_TOOL_CONCURRENCY=0` 可退回仅连续只读并发。

调度器只决定顺序，互斥仍由资源锁保证；两者组合才能既快又不会互相覆盖。

## 10. 上下文超限与限流

供应商返回 `maximum context length` 一类 400 时，不要直接把原始错误抛给用户：

```js
import { planContextOverflow } from 'cache-stable-agent-core';

try {
  return await request(messages);
} catch (error) {
  const plan = planContextOverflow({
    contextWindow,
    messages,
    errorMessage: error.message,
    retriesUsed
  });
  if (plan.handled && plan.retry) return request(plan.messages);
  if (plan.handled) throw new Error(plan.error);
  throw error;
}
```

`planContextOverflow` 会从错误文本解析真实上限、按 70% 目标压缩请求视图，并在重试次数用尽后返回可读错误。无可压缩内容时直接失败，避免空转重试。

请求建立阶段可以交给 `fetchWithRetry`：自适应并发、429 抖动退避与长 `Retry-After` 熔断都在这里处理。

```js
import { fetchWithRetry } from 'cache-stable-agent-core';

const response = await fetchWithRetry(url, init, { signal, retries: 2 });
```

它只包裹“建立请求 + 读取响应头”，SSE 开始后不再重试，避免重复计费或重复输出。

## 11. 延迟归因

```js
import { createTurnMetrics } from 'cache-stable-agent-core';

const latency = createTurnMetrics();
latency.startLlm();
// ...首个增量到达时
latency.markFirstToken();
latency.endLlm();
latency.addToolMs(toolMs);
latency.addSaveMs(saveMs);
latency.addApprovalWaitMs(waitMs);
latency.addUsage(normalizedUsage);
const snapshot = latency.snapshot();
```

`snapshot()` 给出 `durationMs`（扣除用户思考/审批等待）、`wallMs`、`llmTtftMs`、`llmDecodeMs`、`toolMs`、`saveMs`、`overheadMs`、PTC 覆盖率、重复读取率、按阶段归因与缓存上报状态。它只观测，不改变执行逻辑。

## 12. 供应商字段兼容

`normalizeCacheUsage` 已覆盖：

- OpenAI 兼容：`prompt_tokens_details.cached_tokens`
- DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- Anthropic：`cache_read_input_tokens` / `cache_creation_input_tokens`

如果供应商没有返回缓存字段，不要把本地推算的 miss 当作 0% 命中；应标记为未上报，展示时显示未知。

## 13. 常见错误

- 每轮都做滑动窗口裁剪：前缀每步都变化，缓存命中率会剧烈抖动。应使用滞后裁剪。
- 在 system prompt 里拼时间戳：所有请求头部字节都不同，缓存直接失效。
- 对工具 schema 做无序序列化：同一组工具在不同构造路径下顺序不同，前缀哈希会变化。
- 把 `write_file` 的历史参数替换成占位符：模型会在后续轮次模仿占位符，污染真实产物。工具参数历史必须原样保留。
- 对短工具结果也强制蒸馏：多一次回读往返，延迟反而上升。

## 14. 验证方式

```bash
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
node --test test/resource-locks.test.js test/command-scope.test.js test/verify-scheduler.test.js test/tool-scheduler.test.js test/locks.test.js
node --test test/task-contract.test.js test/deliverable.test.js test/context-guard.test.js test/llm-governor.test.js test/latency-metrics.test.js
```

基准数据在 `benchmark/data/`，旧版数据归档在 `benchmark/data/legacy-2026-11-22/` 与 `legacy-2026-11-23/`，报告只读取顶层文件并生成到 `benchmark/output/`。最新五组为 10/20/50/70/100 轮，两个变体各 250 轮、合计 500 轮；优化版每轮 token 低 56.5%、耗时低 21.3%、同档金额低 8.3%。报告中的传统版使用原生 function calling、全量历史与单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联、任务备忘、蒸馏与压缩；优化版启用 PTC、单轮上下文引擎与按模型窗口推导的历史预算。这才是 PTC 与上下文优化相对传统 Agent 框架的完整对比。
