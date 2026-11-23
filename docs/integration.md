# 接入指南

这个仓库不是一个可以直接对话的 Web 应用，而是一组可以嵌进现有 Agent 循环的内核模块。下面给出最小接入顺序，完整可运行版本见 `examples/minimal-agent.mjs` 与 `examples/ptc-batch.mjs`。

## 1. 请求前：取历史窗口并记录前缀

```js
import {
  resolveLaggingWindow,
  buildRequestFingerprint,
  commonPrefixRatio
} from 'local-first-agent-workbench-core';

const limits = {
  softMessages: 48,
  hardMessages: 64,
  softChars: 60000,
  hardChars: 90000
};

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

## 2. 工具返回后：决定是否蒸馏

```js
import { distillToolResult, readStoredToolResult, resolveTokenOpt } from 'local-first-agent-workbench-core';

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

## 3. 批量只读操作：使用 PTC

```js
import { buildPtcToolDefinition, runPtcTool, shutdownPtc } from 'local-first-agent-workbench-core';

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

## 4. 每次模型返回后：记录缓存样本

```js
import { normalizeCacheUsage, recordCacheSample, cacheMetricsDir } from 'local-first-agent-workbench-core';

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

## 5. 单轮上下文：预取、冷事实、产出索引与备忘

```js
import { buildTurnContext } from 'local-first-agent-workbench-core';

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
- `settings.contextEngine === false` 时退化为传统全量历史模式，用于对照基准。

## 6. 多 Agent 调度策略

```js
import { calibrateTasks, validateGranularity, resolveWriteConflicts, resolveSoftDeadline } from 'local-first-agent-workbench-core';

const { tasks } = calibrateTasks(plan.tasks, { historyMs });
const granularity = validateGranularity(tasks);
const { tasks: ordered } = resolveWriteConflicts(tasks);
const softDeadlineMs = resolveSoftDeadline({ historyMs });
```

这些函数都是纯函数，不负责真正启动 worker。调度循环读取返回值决定拆几个任务、谁依赖谁、何时判定长尾。`shouldHedge` 与 `shouldRedispatch` 只对可重试且无写入的结果生效，避免重复落盘。

## 7. 供应商字段兼容

`normalizeCacheUsage` 已覆盖：

- OpenAI 兼容：`prompt_tokens_details.cached_tokens`
- DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- Anthropic：`cache_read_input_tokens` / `cache_creation_input_tokens`

如果供应商没有返回缓存字段，不要把本地推算的 miss 当作 0% 命中；应标记为未上报，展示时显示未知。

## 8. 常见错误

- 每轮都做滑动窗口裁剪：前缀每步都变化，缓存命中率会剧烈抖动。应使用滞后裁剪。
- 在 system prompt 里拼时间戳：所有请求头部字节都不同，缓存直接失效。
- 对工具 schema 做无序序列化：同一组工具在不同构造路径下顺序不同，前缀哈希会变化。
- 把 `write_file` 的历史参数替换成占位符：模型会在后续轮次模仿占位符，污染真实产物。工具参数历史必须原样保留。
- 对短工具结果也强制蒸馏：多一次回读往返，延迟反而上升。

## 9. 验证方式

```bash
npm test
npm run example:minimal
npm run example:ptc
npm run benchmark:report
```

基准数据在 `benchmark/data/`，报告会生成到 `benchmark/output/`。报告中的传统版使用原生 function calling、全量历史与单循环 ReAct，关闭预取、冷事实、产出索引、轮次策略、计划内联、任务备忘、蒸馏与压缩；优化版启用 PTC 与单轮上下文引擎。这才是 PTC 与上下文优化相对传统 Agent 框架的完整对比。
