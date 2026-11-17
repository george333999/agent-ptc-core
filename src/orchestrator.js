import { resolveWithinWorkspace } from './paths.js';
import { newPtcTraceId, recordModelDebug } from './ptc/trace.js';
import { disposePtcScope } from './ptc/index.js';

const MAX_SUBTASKS = 8;
const MIN_SUBTASKS = 2;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 4;
const DEFAULT_WORKER_TIMEOUT_MS = 120000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 600000;
const MAX_WORKER_STEPS = 8;
const MAX_TOOL_OUTPUT = 12000;
const READ_TOOL_NAMES = new Set(['list_files', 'read_file', 'search_files']);
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

export class OrchestrationError extends Error {
  constructor(message, code = 'ORCHESTRATION_ERROR', details = null) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.details = details;
  }
}

function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...（已截断，共 ${value.length} 字符）`;
}

function normalizeRelativePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function normalizeStringList(value, limit = 24, maxLength = 800) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .map((item) => clip(item, maxLength)))]
    .slice(0, limit);
}

function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  return Math.ceil(value.replace(/\s+/g, ' ').length / 3);
}

export function parseStructuredResult(text) {
  let content = String(text ?? '').trim();
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  const start = content.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function normalizeWorkerResult(task, rawText, extra = {}) {
  const parsed = parseStructuredResult(rawText);
  const statuses = new Set(['completed', 'partial', 'failed']);
  const status = parsed && statuses.has(parsed.status) ? parsed.status : (extra.status || 'partial');
  const result = parsed
    ? String(parsed.result ?? '').slice(0, 8000)
    : clip(rawText || '子 Agent 没有返回内容。', 5000);
  const evidence = parsed
    ? normalizeStringList(parsed.evidence, 12, 600)
    : [];
  const confidenceValue = parsed ? Number(parsed.confidence) : 0.35;
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0.35;
  const openQuestions = parsed
    ? normalizeStringList(parsed.open_questions, 10, 500)
    : ['子 Agent 未按结构化 JSON 返回，主 Agent 需要复核原始输出。'];
  return {
    taskId: task.id,
    title: task.title,
    status,
    result,
    evidence,
    confidence,
    open_questions: openQuestions,
    writes: task.writeFiles || [],
    durationMs: extra.durationMs || 0,
    usage: extra.usage || null,
    structured: Boolean(parsed),
    error: extra.error || ''
  };
}

function dependencyReachability(plan) {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const cache = new Map();
  return function dependsOn(sourceId, targetId) {
    const key = `${sourceId}|${targetId}`;
    if (cache.has(key)) return cache.get(key);
    const seen = new Set();
    const stack = [sourceId];
    while (stack.length) {
      const id = stack.pop();
      if (id === targetId) {
        cache.set(key, true);
        return true;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const task = byId.get(id);
      for (const dependency of task?.dependsOn || []) stack.push(dependency);
    }
    cache.set(key, false);
    return false;
  };
}

function assertNoCycles(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map();
  const visit = (id, path) => {
    const current = state.get(id) || 0;
    if (current === 1) {
      throw new OrchestrationError(`子任务依赖存在环：${[...path, id].join(' → ')}`, 'DAG_CYCLE');
    }
    if (current === 2) return;
    state.set(id, 1);
    for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency, [...path, id]);
    state.set(id, 2);
  };
  for (const task of tasks) visit(task.id, []);
}

export function validateOrchestrationPlan(input, { workspace }) {
  if (!input || typeof input !== 'object') {
    throw new OrchestrationError('编排参数必须是对象。', 'INVALID_PLAN');
  }
  const goal = clip(String(input.goal ?? '').trim(), 600);
  if (!goal) throw new OrchestrationError('缺少编排目标（goal）。', 'INVALID_PLAN');

  const estimatedMinutes = positiveNumber(input.estimatedMinutes, 0);
  const decompositionCostMinutes = positiveNumber(input.decompositionCostMinutes, 0);
  if (!estimatedMinutes || !decompositionCostMinutes) {
    throw new OrchestrationError('必须提供 estimatedMinutes（预计总耗时）和 decompositionCostMinutes（拆解成本），单位分钟。', 'INVALID_PLAN');
  }
  if (estimatedMinutes < decompositionCostMinutes * 3) {
    throw new OrchestrationError(
      `任务不值得扇出：预计耗时 ${estimatedMinutes} 分钟 < 拆解成本 ${decompositionCostMinutes} 分钟 × 3。请直接执行，或提供更准确的耗时估计。`,
      'THRESHOLD_NOT_MET'
    );
  }

  const rawTasks = Array.isArray(input.subtasks) ? input.subtasks : [];
  if (rawTasks.length < MIN_SUBTASKS) {
    throw new OrchestrationError(`至少需要 ${MIN_SUBTASKS} 个独立子任务；单个子任务不需要编排。`, 'NOT_ENOUGH_SUBTASKS');
  }
  if (rawTasks.length > MAX_SUBTASKS) {
    throw new OrchestrationError(`子任务最多 ${MAX_SUBTASKS} 个，请合并相近任务。`, 'TOO_MANY_SUBTASKS');
  }

  const tasks = rawTasks.map((raw, index) => {
    const id = String(raw?.id ?? `t${index + 1}`).trim().slice(0, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new OrchestrationError(`子任务 ID 不合法：${id || '(空)'}`, 'INVALID_TASK_ID');
    }
    const title = clip(String(raw?.title ?? '').trim(), 120);
    const brief = clip(String(raw?.brief ?? '').trim(), 4000);
    const expectedOutput = clip(String(raw?.expectedOutput ?? '').trim(), 1200);
    if (!title || !brief || !expectedOutput) {
      throw new OrchestrationError(`子任务 ${id} 必须包含 title、brief 和 expectedOutput。`, 'INVALID_TASK');
    }
    const readFiles = normalizeStringList(raw?.readFiles, 20, 300).map(normalizeRelativePath).filter(Boolean);
    const writeFiles = normalizeStringList(raw?.writeFiles, 12, 300).map(normalizeRelativePath).filter(Boolean);
    for (const file of [...readFiles, ...writeFiles]) {
      try {
        resolveWithinWorkspace(workspace, file);
      } catch {
        throw new OrchestrationError(`子任务 ${id} 的路径超出工作区：${file}`, 'PATH_OUTSIDE_WORKSPACE');
      }
    }
    return {
      id,
      title,
      brief,
      constraints: normalizeStringList(raw?.constraints, 12, 500),
      knownInfo: clip(String(raw?.knownInfo ?? '').trim(), 3000),
      expectedOutput,
      dependsOn: normalizeStringList(raw?.dependsOn, 8, 32),
      readFiles: [...new Set(readFiles)],
      writeFiles: [...new Set(writeFiles)],
      estimatedMinutes: positiveNumber(raw?.estimatedMinutes, 0)
    };
  });

  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new OrchestrationError(`子任务 ID 重复：${task.id}`, 'DUPLICATE_TASK_ID');
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new OrchestrationError(`子任务 ${task.id} 依赖了不存在的任务：${dependency}`, 'UNKNOWN_DEPENDENCY');
      }
      if (dependency === task.id) {
        throw new OrchestrationError(`子任务 ${task.id} 不能依赖自己。`, 'SELF_DEPENDENCY');
      }
    }
  }
  assertNoCycles(tasks);

  const maxConcurrency = Math.max(1, Math.min(Number(input.maxConcurrency) || DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
  const plan = { goal, estimatedMinutes, decompositionCostMinutes, maxConcurrency, tasks };
  const dependsOn = dependencyReachability(plan);

  // 同一文件不能在被并行执行的子任务间同时写入；串行依赖可以保留。
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = tasks[i];
      const right = tasks[j];
      const overlap = left.writeFiles.filter((file) => right.writeFiles.includes(file));
      if (!overlap.length) continue;
      const ordered = dependsOn(left.id, right.id) || dependsOn(right.id, left.id);
      if (!ordered) {
        throw new OrchestrationError(
          `子任务 ${left.id} 和 ${right.id} 会并行修改同一文件：${overlap.join('、')}。请增加依赖关系改为串行，或合并这两个子任务。`,
          'PARALLEL_WRITE_CONFLICT',
          { tasks: [left.id, right.id], files: overlap }
        );
      }
    }
  }

  return plan;
}

function workerSystemPrompt(task, { allowAskUser = false, ptc = false } = {}) {
  const writable = task.writeFiles.length
    ? `你可以修改且只能修改这些文件：${task.writeFiles.join('、')}。禁止修改其他任何文件，禁止运行终端命令。`
    : '你是只读子 Agent，禁止修改任何文件或运行终端命令。';
  return [
    '你是由主 Agent 派发的独立子 Agent，只负责一个子任务。',
    '你没有完整对话历史，只能依据任务简报、约束、已知信息和工具读取结果工作。',
    writable,
    allowAskUser
      ? '如果任务简报缺少关键信息、无法从工作区确认，必须调用 ask_user 向用户提问；不要猜测。用户未回答时，把问题写入 open_questions 并把状态标为 partial。'
      : '如果任务简报缺少关键信息，不要猜测；把问题写入 open_questions 并把状态标为 partial。',
    ptc
      ? '当前开启 PTC 模式：只读检索请调用 ptc_run，用 await files.list({...}) / files.read({...}) / files.search({...}) 写一小段 async JavaScript 批量核实事实，再 return JSON 结果；同一子任务内 state 与会话内顶层变量可复用。写文件仍使用直连的 write_file/edit_file。不要臆造文件内容或证据。'
      : '使用 list_files、read_file、search_files 核实事实；不要臆造文件内容或证据。',
    '读取大文件时使用 start_line/end_line 按需读取，避免一次性拉取整份大文件。',
    '完成后只输出一个 JSON 对象，不要输出 Markdown 代码块或额外解释：',
    '{"status":"completed|partial|failed","result":"结论","evidence":["文件:行号 或 工具事实"],"confidence":0.0,"open_questions":["未解决的疑问"]}',
    'confidence 是 0 到 1 的数字；没有证据时不要给高置信度。'
  ].join('\n');
}

function workerUserPrompt(task, plan, upstreamResults) {
  const parts = [
    `# 总目标\n${plan.goal}`,
    `# 子任务\n[${task.id}] ${task.title}\n${task.brief}`,
    task.constraints.length ? `# 约束\n${task.constraints.map((item) => `- ${item}`).join('\n')}` : '',
    task.knownInfo ? `# 已知信息\n${task.knownInfo}` : '',
    task.readFiles.length ? `# 建议读取\n${task.readFiles.map((item) => `- ${item}`).join('\n')}` : '',
    task.writeFiles.length ? `# 允许修改\n${task.writeFiles.map((item) => `- ${item}`).join('\n')}` : '',
    `# 期望输出\n${task.expectedOutput}`,
    upstreamResults.length
      ? `# 上游子任务结果\n${upstreamResults.map((result) => [
          `## [${result.taskId}] ${result.title} — ${result.status}`,
          `结果：${clip(result.result, 1800)}`,
          result.evidence.length ? `证据：${result.evidence.slice(0, 4).join('；')}` : '',
          typeof result.confidence === 'number' ? `置信度：${Math.round(result.confidence * 100)}%` : ''
        ].filter(Boolean).join('\n')).join('\n\n')}`
      : ''
  ];
  return parts.filter(Boolean).join('\n\n');
}

function assertWriteScope(toolName, args, task) {
  if (!WRITE_TOOL_NAMES.has(toolName)) return;
  const target = normalizeRelativePath(args?.path);
  if (!target || !task.writeFiles.includes(target)) {
    throw new Error(`子 Agent 无权修改未分配的文件：${target || '(空路径)'}`);
  }
}

function addUsage(total, usage) {
  if (!usage) return total;
  total.prompt_tokens += Number(usage.prompt_tokens) || 0;
  total.completion_tokens += Number(usage.completion_tokens) || 0;
  total.total_tokens += Number(usage.total_tokens)
    || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  return total;
}

export async function runWorker(task, context) {
  const {
    plan,
    upstreamResults = [],
    model,
    settings,
    workspace,
    signal,
    emit,
    parentCallId,
    chatRunner,
    toolRunner,
    buildWorkerTools,
    workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS
  } = context;
  if (typeof chatRunner !== 'function') throw new Error('runWorker 需要注入 chatRunner');
  if (typeof toolRunner !== 'function') throw new Error('runWorker 需要注入 toolRunner');

  const startedAt = Date.now();
  const timeoutController = new AbortController();
  let timedOut = false;
  let timer = null;
  const startWorkerTimer = () => {
    clearTimeout(timer);
    timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, Math.max(100, workerTimeoutMs));
  };
  startWorkerTimer();
  const workerSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  const allowAskUser = Boolean(context.askUser);
  const ptcMode = settings?.toolMode === 'ptc';
  const messages = [
    { role: 'system', content: workerSystemPrompt(task, { allowAskUser, ptc: ptcMode }) },
    { role: 'user', content: workerUserPrompt(task, plan, upstreamResults) }
  ];
  const tools = typeof buildWorkerTools === 'function'
    ? buildWorkerTools({ settings, task, allowAskUser, ptc: ptcMode })
    : [];
  const allowedTools = new Set(tools.map((definition) => definition.function.name));
  // 每个子 Agent 使用独立 PTC 命名空间：并行 worker 不会共享 I-PTC 状态或互相排队。
  const ptcScope = `worker:${parentCallId || 'orchestration'}:${task.id}`;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let raw = '';
  let failure = '';
  let abortedByUser = false;

  emit?.('subagent_start', { parentCallId, description: `[${task.id}] ${task.title}` });
  try {
    for (let step = 0; step < MAX_WORKER_STEPS; step += 1) {
      const result = await chatRunner({
        model,
        messages,
        tools,
        temperature: 0.2,
        signal: workerSignal,
        logprobs: Boolean(settings?.debugLogprobs)
      });
      const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      addUsage(usage, result.usage);
      messages.push({
        role: 'assistant',
        content: result.content || '',
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments }
          }))
        } : {})
      });
      const ptcTraceIds = new Map();
      for (const call of toolCalls) {
        if (call.name === 'ptc_run') ptcTraceIds.set(call.id, newPtcTraceId());
      }
      if (settings?.debugLogprobs) {
        try {
          recordModelDebug({
            sessionId: context.session?.id || '',
            runId: context.runId || '',
            agent: 'worker',
            taskId: task.id,
            step: step + 1,
            model: model?.modelId || model?.name || '',
            traceIds: [...ptcTraceIds.values()],
            content: result.content,
            toolCalls,
            logprobs: result.logprobs || [],
            logprobsUnavailable: Boolean(result.logprobsUnavailable),
            usage: result.usage,
            finishReason: result.finishReason
          });
        } catch {
          // 调试日志失败不影响子 Agent。
        }
      }
      if (!toolCalls.length) {
        raw = result.content || '';
        break;
      }
      for (const call of toolCalls) {
        let output;
        try {
          if (call.name === 'ask_user') {
            if (!context.askUser) throw new Error('当前子 Agent 不能向用户提问');
            const args = call.arguments ? JSON.parse(call.arguments) : {};
            const question = String(args.question || '').trim().slice(0, 1000);
            if (!question) throw new Error('缺少澄清问题');
            const options = (Array.isArray(args.options) ? args.options : [])
              .map((option) => typeof option === 'string' ? option : option?.label)
              .map((option) => String(option ?? '').trim().slice(0, 200))
              .filter(Boolean)
              .slice(0, 4);
            // 人工回答时间不计入子 Agent 的超时预算，避免用户还没看清问题就被熔断。
            context.onHitlWaitStart?.();
            clearTimeout(timer);
            let response;
            try {
              response = await context.askUser({
                question,
                options,
                allowFreeText: args.allow_free_text !== false,
                task
              });
            } finally {
              context.onHitlWaitEnd?.();
            }
            startWorkerTimer();
            if (response.aborted) {
              abortedByUser = true;
              throw new Error('用户取消了提问');
            }
            output = response.answered
              ? `用户回答：${response.answer || '(空)'}`
              : '用户未在等待时间内回答。请基于现有信息给出 partial 结果，并把未确认的问题写入 open_questions，不要猜测。';
          } else {
            if (!allowedTools.has(call.name)) {
              throw new Error(`子 Agent 不允许调用工具 ${call.name}`);
            }
            const args = call.arguments ? JSON.parse(call.arguments) : {};
            assertWriteScope(call.name, args, task);
            output = await toolRunner(call.name, args, {
              workspace,
              settings,
              signal: workerSignal,
              remote: Boolean(context.remote),
              session: context.session,
              model,
              skills: context.skills,
              knowledge: context.knowledge,
              knowledgeTopK: context.knowledgeTopK,
              fileHistory: context.fileHistory,
              runId: context.runId,
              ptcTraceId: ptcTraceIds.get(call.id) || '',
              ptcScope,
              workspaceQuotaBytes: context.workspaceQuotaBytes,
              deviceStorageRoot: context.deviceStorageRoot,
              deviceStorageQuotaBytes: context.deviceStorageQuotaBytes,
              emit: () => {}
            });
            if (output && typeof output === 'object' && output.text) output = output.text;
          }
        } catch (error) {
          if (abortedByUser) throw error;
          output = `工具失败：${error?.message || String(error)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          tool_name: call.name,
          content: clip(output, MAX_TOOL_OUTPUT)
        });
      }
    }
    if (!raw) {
      const last = [...messages].reverse().find((message) => message.role === 'assistant' && message.content);
      raw = last?.content || '';
    }
    // 结构化返回是硬要求：模型忘记 JSON 时补一次格式修复，不额外调用工具。
    if (raw && !parseStructuredResult(raw) && !timedOut && !signal?.aborted) {
      try {
        const repair = await chatRunner({
          model,
          messages: [
            {
              role: 'system',
              content: '你只负责把子 Agent 的回答改写成 JSON，不添加新事实。只输出 JSON，不要 Markdown 代码块。'
            },
            {
              role: 'user',
              content: [
                '请把下面的回答改写成规定结构，只输出 JSON：',
                '{"status":"completed|partial|failed","result":"结论","evidence":["证据"],"confidence":0.0,"open_questions":["疑问"]}',
                '',
                clip(raw, 6000)
              ].join('\n')
            }
          ],
          tools: [],
          temperature: 0,
          signal: workerSignal
        });
        addUsage(usage, repair.usage);
        if (repair.content) raw = repair.content;
      } catch {
        // 格式修复失败时保留原始回答，由上层标记为需要复核。
      }
    }
  } catch (error) {
    failure = error?.message || String(error);
  } finally {
    clearTimeout(timer);
    await disposePtcScope(ptcScope).catch(() => {});
    emit?.('subagent_done', { parentCallId, description: `[${task.id}] ${task.title}` });
  }

  const durationMs = Date.now() - startedAt;
  if (!usage.prompt_tokens && !usage.completion_tokens) {
    usage.prompt_tokens = estimateTokens(messages.map((message) => message.content || '').join('\n'));
    usage.completion_tokens = estimateTokens(raw);
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }

  if (abortedByUser) {
    return {
      taskId: task.id,
      title: task.title,
      status: 'aborted',
      result: '用户取消了子 Agent 的提问，子任务已停止。',
      evidence: [],
      confidence: 0,
      open_questions: ['子任务因用户取消提问而停止。'],
      writes: task.writeFiles,
      durationMs,
      usage,
      structured: false,
      error: 'USER_CANCELLED'
    };
  }
  if (timedOut) {
    return {
      taskId: task.id,
      title: task.title,
      status: 'timeout',
      result: `子 Agent 超过 ${Math.round(workerTimeoutMs / 1000)} 秒未完成，已中止。`,
      evidence: [],
      confidence: 0,
      open_questions: ['该子任务未在超时时间内完成，需要主 Agent 重新派发或直接处理。'],
      writes: task.writeFiles,
      durationMs,
      usage,
      structured: false,
      error: 'TIMEOUT'
    };
  }
  if (signal?.aborted) {
    return {
      taskId: task.id,
      title: task.title,
      status: 'aborted',
      result: '任务已取消。',
      evidence: [],
      confidence: 0,
      open_questions: [],
      writes: task.writeFiles,
      durationMs,
      usage,
      structured: false,
      error: 'ABORTED'
    };
  }
  if (failure && !raw) {
    return {
      taskId: task.id,
      title: task.title,
      status: 'failed',
      result: clip(`子 Agent 执行失败：${failure}`, 3000),
      evidence: [],
      confidence: 0,
      open_questions: ['子 Agent 执行失败，需要主 Agent 重新派发或直接处理。'],
      writes: task.writeFiles,
      durationMs,
      usage,
      structured: false,
      error: failure
    };
  }
  return normalizeWorkerResult(task, raw, { durationMs, usage, error: failure });
}

export function detectResultConflicts(plan, results) {
  const conflicts = [];
  const byId = new Map(results.map((result) => [result.taskId, result]));
  const dependsOn = dependencyReachability(plan);

  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const left = results[i];
      const right = results[j];
      const overlap = (left.writes || []).filter((file) => (right.writes || []).includes(file));
      if (!overlap.length) continue;
      if (!['completed', 'partial'].includes(left.status) || !['completed', 'partial'].includes(right.status)) continue;
      const sequential = dependsOn(left.taskId, right.taskId) || dependsOn(right.taskId, left.taskId);
      conflicts.push({
        type: sequential ? 'sequential_file_overlap' : 'unexpected_parallel_overlap',
        severity: sequential ? 'medium' : 'high',
        tasks: [left.taskId, right.taskId],
        files: overlap,
        message: sequential
          ? `子任务 ${left.taskId} 与 ${right.taskId} 先后修改了同一文件（${overlap.join('、')}），请核对最终版本是否可合并。`
          : `子任务 ${left.taskId} 与 ${right.taskId} 都声明修改了同一文件（${overlap.join('、')}），需要立即仲裁。`
      });
    }
  }

  for (const result of results) {
    if (['failed', 'timeout', 'aborted', 'skipped'].includes(result.status)) {
      conflicts.push({
        type: 'coverage_gap',
        severity: result.status === 'skipped' ? 'medium' : 'high',
        tasks: [result.taskId],
        files: [],
        message: `子任务 ${result.taskId} 未成功完成（${result.status}），相关结论存在缺口。`
      });
      continue;
    }
    if (result.status === 'completed' && !result.evidence.length) {
      conflicts.push({
        type: 'missing_evidence',
        severity: 'medium',
        tasks: [result.taskId],
        files: [],
        message: `子任务 ${result.taskId} 声称完成但没有提供证据，请复核。`
      });
    }
    if (result.confidence < 0.45) {
      conflicts.push({
        type: 'low_confidence',
        severity: 'medium',
        tasks: [result.taskId],
        files: [],
        message: `子任务 ${result.taskId} 的置信度只有 ${Math.round(result.confidence * 100)}%，结论需要主 Agent 复核。`
      });
    }
  }

  const unresolved = results.filter((result) => result.open_questions?.length);
  if (unresolved.length) {
    conflicts.push({
      type: 'open_questions',
      severity: 'low',
      tasks: unresolved.map((result) => result.taskId),
      files: [],
      message: `${unresolved.length} 个子任务仍有未解决的疑问，汇总时需要说明不确定性。`
    });
  }

  return {
    conflicts,
    needsArbitration: conflicts.some((conflict) => conflict.severity === 'high' || conflict.severity === 'medium')
  };
}

function skippedResult(task, reason, message) {
  return {
    taskId: task.id,
    title: task.title,
    status: 'skipped',
    result: message,
    evidence: [],
    confidence: 0,
    open_questions: [message],
    writes: task.writeFiles,
    durationMs: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    structured: false,
    skipReason: reason,
    error: reason
  };
}

export async function runOrchestration(options) {
  const {
    plan: rawPlan,
    model,
    workspace,
    settings,
    signal,
    emit,
    parentCallId,
    baselineContextChars = 0,
    workerRunner = (context) => runWorker(context.task, context),
    globalTimeoutMs = DEFAULT_GLOBAL_TIMEOUT_MS
  } = options;
  const plan = validateOrchestrationPlan(rawPlan, { workspace });
  const startedAt = Date.now();
  const hasWrites = plan.tasks.some((task) => task.writeFiles.length);
  if (hasWrites && typeof options.requestPlanApproval !== 'function') {
    throw new OrchestrationError('写入型并行计划必须先经过计划审批，不能直接执行。', 'PLAN_APPROVAL_REQUIRED');
  }
  if (typeof options.requestPlanApproval === 'function') {
    const approvalPlan = {
      goal: plan.goal,
      steps: plan.tasks.map((task) => ({
        title: `[${task.id}] ${task.title}`,
        detail: [
          task.brief,
          task.dependsOn.length ? `依赖：${task.dependsOn.join('、')}` : '',
          task.writeFiles.length ? `将修改：${task.writeFiles.join('、')}` : '只读子任务'
        ].filter(Boolean).join('\n'),
        files: [...task.readFiles, ...task.writeFiles]
      })),
      risks: hasWrites ? ['并行子 Agent 会修改上面列出的文件，请确认写入范围'] : [],
      estimatedMinutes: plan.estimatedMinutes
    };
    const decision = await options.requestPlanApproval({ plan: approvalPlan });
    if (!decision.approved) {
      const reason = decision.aborted
        ? '计划审批已取消。'
        : decision.timeout
          ? '计划审批超时，未派发任何子 Agent。'
          : `用户未批准该并行计划。${decision.feedback ? `修改意见：${decision.feedback}` : ''}\n请调整子任务或依赖关系后重新提交，不要直接执行。`;
      return {
        text: `## 并行编排未执行\n${reason}`,
        meta: {
          action: 'orchestration_rejected',
          tasks: plan.tasks.length,
          completed: 0,
          concurrency: plan.maxConcurrency,
          conflicts: 0,
          needsArbitration: true,
          durationMs: Date.now() - startedAt,
          workerTokens: 0,
          baselineTokens: 0,
          tokenSavedPercent: 0
        },
        results: [],
        conflicts: [],
        metrics: {
          tasks: plan.tasks.length,
          completed: 0,
          concurrency: plan.maxConcurrency,
          wallMs: Date.now() - startedAt,
          serialWorkerMs: 0,
          parallelSavedMs: 0,
          workerTokens: 0,
          baselineTokens: 0,
          tokenSaved: 0,
          tokenSavedPercent: 0
        }
      };
    }
  }
  const deadline = Date.now() + Math.max(1000, globalTimeoutMs);
  let humanWaitMs = 0;
  let hitlActive = 0;
  let hitlStartedAt = 0;
  const onHitlWaitStart = () => {
    if (hitlActive === 0) hitlStartedAt = Date.now();
    hitlActive += 1;
  };
  const onHitlWaitEnd = () => {
    if (hitlActive <= 0) return;
    hitlActive -= 1;
    if (hitlActive === 0) humanWaitMs += Date.now() - hitlStartedAt;
  };
  const tasks = plan.tasks;
  const pending = new Set(tasks.map((task) => task.id));
  const results = new Map();
  const skipped = new Map();
  const running = new Map();
  const failureBudget = Math.max(2, Math.ceil(tasks.length / 2));
  let consecutiveFailures = 0;
  let circuitOpen = false;

  const skipTask = (task, reason, message) => {
    if (results.has(task.id) || skipped.has(task.id)) return;
    skipped.set(task.id, { reason, message });
    pending.delete(task.id);
  };

  while (pending.size || running.size) {
    for (const task of tasks) {
      if (!pending.has(task.id)) continue;
      const failedDependency = task.dependsOn.some((id) => {
        const result = results.get(id);
        const skip = skipped.get(id);
        return skip || (result && ['failed', 'timeout', 'aborted', 'skipped'].includes(result.status));
      });
      if (failedDependency) {
        skipTask(task, 'DEPENDENCY_FAILED', `依赖的子任务未成功完成，${task.id} 未执行。`);
      }
    }

    if (signal?.aborted) {
      for (const task of tasks) skipTask(task, 'ABORTED', '任务已取消，子任务未执行。');
      break;
    }
    if (Date.now() - humanWaitMs > deadline) {
      for (const task of tasks) skipTask(task, 'GLOBAL_TIMEOUT', '编排总时长超过上限，子任务未执行。');
      break;
    }
    if (circuitOpen) {
      for (const task of tasks) skipTask(task, 'CIRCUIT_OPEN', '连续子 Agent 失败触发熔断，剩余子任务未执行。');
      break;
    }

    while (running.size < plan.maxConcurrency) {
      const next = tasks.find((task) => pending.has(task.id)
        && !running.has(task.id)
        && task.dependsOn.every((id) => {
          const result = results.get(id);
          return result && (result.status === 'completed' || result.status === 'partial');
        }));
      if (!next) break;
      pending.delete(next.id);
      const upstreamResults = next.dependsOn
        .map((id) => results.get(id))
        .filter(Boolean);
      const promise = Promise.resolve()
        .then(() => workerRunner({
          ...options,
          task: next,
          plan,
          upstreamResults,
          model,
          settings,
          workspace,
          signal,
          emit,
          parentCallId,
          onHitlWaitStart,
          onHitlWaitEnd
        }))
        .catch((error) => ({
          taskId: next.id,
          title: next.title,
          status: 'failed',
          result: `子 Agent 执行异常：${error?.message || String(error)}`,
          evidence: [],
          confidence: 0,
          open_questions: ['子 Agent 执行异常，需要主 Agent 重新派发或直接处理。'],
          writes: next.writeFiles,
          durationMs: 0,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          structured: false,
          error: error?.message || String(error)
        }))
        .then((result) => {
          results.set(next.id, result);
          if (['failed', 'timeout', 'aborted'].includes(result.status)) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= failureBudget) circuitOpen = true;
          } else {
            consecutiveFailures = 0;
          }
        });
      running.set(next.id, promise.finally(() => running.delete(next.id)));
    }

    if (!running.size) {
      for (const task of tasks) {
        skipTask(task, 'UNREACHABLE', '依赖关系无法满足，子任务未执行。');
      }
      break;
    }
    await Promise.race(running.values());
  }

  // 提前退出（取消/总超时/熔断）时，已启动的 worker 可能还在收尾；
  // 先等它们落定，避免把已完成结果误写成 skipped，也避免后台任务继续跑。
  if (running.size) {
    await Promise.allSettled([...running.values()]);
  }

  const finalResults = tasks.map((task) => {
    if (results.has(task.id)) return results.get(task.id);
    const skip = skipped.get(task.id) || { reason: 'UNKNOWN', message: '子任务未执行。' };
    return skippedResult(task, skip.reason, skip.message);
  });

  const analysis = detectResultConflicts(plan, finalResults);
  const wallMs = Date.now() - startedAt;
  const serialWorkerMs = finalResults.reduce((total, result) => total + (result.durationMs || 0), 0);
  const workerTokens = finalResults.reduce((total, result) => total + (result.usage?.total_tokens || 0), 0);
  const workerUsage = finalResults.reduce((total, result) => addUsage(total, result.usage), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });
  const baselineTokens = baselineContextChars > 0
    ? Math.ceil(baselineContextChars / 3) * tasks.length
    : 0;
  const tokenSaved = baselineTokens > 0 && workerTokens > 0 ? Math.max(0, baselineTokens - workerTokens) : 0;
  const tokenSavedPercent = baselineTokens > 0 && workerTokens > 0
    ? Math.round((tokenSaved / baselineTokens) * 1000) / 10
    : 0;
  const completed = finalResults.filter((result) => ['completed', 'partial'].includes(result.status)).length;
  const metrics = {
    tasks: tasks.length,
    completed,
    concurrency: plan.maxConcurrency,
    wallMs,
    serialWorkerMs,
    parallelSavedMs: Math.max(0, serialWorkerMs - wallMs),
    workerTokens,
    workerUsage,
    baselineTokens,
    tokenSaved,
    tokenSavedPercent
  };

  const text = formatOrchestrationReport({
    plan,
    results: finalResults,
    conflicts: analysis.conflicts,
    needsArbitration: analysis.needsArbitration,
    metrics
  });

  return {
    text,
    meta: {
      action: 'orchestrated',
      tasks: tasks.length,
      completed,
      concurrency: plan.maxConcurrency,
      conflicts: analysis.conflicts.length,
      needsArbitration: analysis.needsArbitration,
      durationMs: wallMs,
      workerTokens,
      usage: workerUsage,
      baselineTokens,
      tokenSavedPercent
    },
    results: finalResults,
    conflicts: analysis.conflicts,
    metrics
  };
}

function formatOrchestrationReport({ plan, results, conflicts, needsArbitration, metrics }) {
  const statusLabel = {
    completed: '完成',
    partial: '部分完成',
    failed: '失败',
    timeout: '超时',
    aborted: '已取消',
    skipped: '未执行'
  };
  const conflictLabel = { high: '高', medium: '中', low: '低' };
  const taskLines = results.map((result) => [
    `### [${result.taskId}] ${result.title} — ${statusLabel[result.status] || result.status}（置信度 ${Math.round((result.confidence || 0) * 100)}%，${Math.round((result.durationMs || 0) / 1000)}s）`,
    `结果：${clip(result.result, 1200)}`,
    result.evidence.length ? `证据：${result.evidence.slice(0, 5).map((item) => clip(item, 220)).join('；')}` : '证据：无',
    result.open_questions.length ? `未解决疑问：${result.open_questions.slice(0, 4).map((item) => clip(item, 220)).join('；')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  const conflictLines = conflicts.length
    ? conflicts.map((conflict) => `- [${conflictLabel[conflict.severity] || conflict.severity}] ${conflict.message}`).join('\n')
    : '未发现需要仲裁的冲突。';

  const savings = [
    `- 子 Agent tokens：${metrics.workerTokens}`,
    metrics.baselineTokens && metrics.workerTokens
      ? `- 按完整对话历史估算的串行基线：${metrics.baselineTokens} tokens，实际节省约 ${metrics.tokenSaved} tokens（${metrics.tokenSavedPercent}%）`
      : '- 没有可用的 token 用量或历史基线，本次无法估算上下文 token 节省。',
    `- 串行执行子任务耗时：${(metrics.serialWorkerMs / 1000).toFixed(1)}s；实际墙钟：${(metrics.wallMs / 1000).toFixed(1)}s；并行节省约 ${(metrics.parallelSavedMs / 1000).toFixed(1)}s`
  ].join('\n');

  return [
    '## 并行编排结果',
    `目标：${clip(plan.goal, 300)}`,
    `完成情况：${metrics.completed}/${metrics.tasks} 个子任务成功；并行度 ${metrics.concurrency}。`,
    `阈值校验：预计耗时 ${plan.estimatedMinutes} 分钟 ≥ 拆解成本 ${plan.decompositionCostMinutes} 分钟 × 3。`,
    '',
    '### 子任务结构化结果',
    taskLines,
    '',
    '### 冲突检测与仲裁',
    conflictLines,
    needsArbitration
      ? '需要主 Agent 二次裁决：请不要直接拼接结果，先说明冲突、裁决依据和最终采用版本。'
      : '无需二次裁决，但汇总时仍需说明证据和不确定性。',
    '',
    '### 资源使用',
    savings,
    '',
    '主 Agent 现在只需基于以上结构化结果做最终裁决和汇总；不要重复执行已完成的子任务。若冲突需要新的修改，请重新派发只针对冲突文件的子任务。'
  ].join('\n');
}
