// Worker prompt and permissions.
// Key constraint: the system prompt contains only DAG-level information and must stay byte-stable across an entire DAG;
// volatile content such as task ID, title, brief, constraints, and upstream results all go into the user message (after the prefix).

import { renderAssumptions, renderDefinitionOfDone } from './task-contract.js';

export const READ_TOOL_NAMES = new Set(['list_files', 'read_file', 'search_files', 'read_tool_result']);
export const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

// Note: the system prompt must be independent of allowAskUser/hasWrites.
// Otherwise different DAGs on the same machine would generate prefixes with different bytes, directly losing cross-DAG provider prefix cache hits.
// "Whether asking/writing is allowed" is an execution-time permission, enforced by workerAllowedTools and assertWriteScope.
export function buildWorkerSystemPrompt({ ptc = false } = {}) {
  return [
    'You are an independent sub-agent dispatched by the main agent and are responsible for only one subtask.',
    'You have no full conversation history and may work only from the task brief, constraints, known information, and tool read results in the user message.',
    'The main agent is responsible for defining the target task, the definition of done, and key assumptions; do not perform Socratic self-questioning, do not redefine the goal, expand scope, or rewrite the definition of done. If the brief lacks a definition of done or key information and this cannot be confirmed from the workspace, write to open_questions and mark partial.',
    'Permissions follow the "Allowed modifications" in the task brief: you may modify only the files listed there; when no files are listed you are a read-only sub-agent. Do not modify unlisted files and do not run terminal commands.',
    'The ask_user tool in the tool list is truly available only when this subtask is allowed to ask questions; when the task brief lacks key information and this cannot be confirmed from the workspace, prefer calling ask_user instead of guessing. If the call is rejected or unavailable, write the questions to open_questions and set the status to partial.',
    ptc
      ? 'PTC mode is currently enabled: for read-only retrieval, call ptc_run and write a short async JavaScript snippet with await files.list({...}) / files.read({...}) / files.readMany({...}) / files.search({...}) to batch-verify facts, then return a JSON result; state and session-level top-level variables can be reused within the same subtask. Use for...of for array iteration; do not use dynamic indexes such as res[i]. Keep PTC code concise (preferably no more than 40 lines), write no comments, and read only necessary fields. When files are dense, first narrow the range with files.search/files.list, then read with files.readMany in batches of ≤50 paths (multiple batch reads are allowed); do not read large files (over 800 lines or 40KB) in full—search first and then read by line, and do not probe line by line with endLine+1; do counting, deduplication, sorting, and field trimming in code, and do not return raw full text (results over 24000 characters will be truncated). Still use the directly connected write_file/edit_file to write files. When a result is distilled, read it back with read_tool_result; do not re-execute the same code. Do not fabricate file contents or evidence.'
      : 'Use list_files, read_file, and search_files to verify facts; when a tool result is distilled, read it back on demand with read_tool_result. Do not fabricate file contents or evidence.',
    'When reading large files, use start_line/end_line to read on demand and avoid pulling an entire large file at once.',
    'Cache-friendly: write task ID, current time, random numbers, runtime variables, and absolute paths only inside tool arguments or ptc_run code; do not put them in this prompt or in repeatedly sent prefixes.',
    'When finished, output only one JSON object; do not output Markdown code blocks or extra explanations. result must not exceed 800 tokens, and evidence must have at most 6 entries with each no longer than 200 characters:',
    '{"status":"completed|partial|failed","result":"conclusion","evidence":["file:line or tool fact"],"confidence":0.0,"open_questions":["unresolved questions"]}',
    'confidence is a number from 0 to 1; do not give high confidence without evidence. When the user message already includes prefetched content, answer based on the prefetched content first; call tools only when key lines are missing, cross-validation is needed, or the prefetch was truncated. When tool results are sufficient to answer, output the JSON immediately without extra verification or restatement.'
  ].join('\n');
}

// Hard budget for each Worker-specific tail: the prefix is shared, and the shorter the tail, the higher the first-round cache hit rate.
// All these defaults can be overridden via settings.tokenOpt.
export const DEFAULT_WORKER_TAIL_CHARS = 4000;
export const DEFAULT_WORKER_UPSTREAM_CHARS = 1000;
export const DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS = 2000;
export const MIN_WORKER_PROMPT_CHARS = 2000;

function hardClip(text, limit) {
  const value = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function buildUpstreamSection(results, { perResultChars, totalChars }) {
  if (!results.length || perResultChars <= 0 || totalChars <= 0) return '';
  const lines = [];
  let used = 0;
  for (const result of results) {
    const block = [
      `## [${result.taskId}] ${result.title} — ${result.status}`,
      `Result: ${hardClip(result.result, perResultChars)}`,
      result.evidence?.length ? `Evidence: ${hardClip(result.evidence.slice(0, 4).join('; '), 400)}` : '',
      typeof result.confidence === 'number' ? `Confidence: ${Math.round(result.confidence * 100)}%` : ''
    ].filter(Boolean).join('\n');
    const cost = block.length + 2;
    if (used + cost > totalChars) {
      if (used >= totalChars * 0.6) break;
      const remaining = Math.max(0, totalChars - used - 2);
      if (remaining < 120) break;
      lines.push(hardClip(block, remaining));
      used = totalChars;
      break;
    }
    lines.push(block);
    used += cost;
  }
  return lines.length ? `# Upstream subtask results\n${lines.join('\n\n')}` : '';
}

export function buildWorkerUserPrompt(task, plan, upstreamResults = [], options = {}) {
  const constraints = (Array.isArray(task?.constraints) ? task.constraints : []).slice(0, 8);
  const readFiles = (Array.isArray(task?.readFiles) ? task.readFiles : []).slice(0, 16);
  const writeFiles = (Array.isArray(task?.writeFiles) ? task.writeFiles : []).slice(0, 16);
  const results = Array.isArray(upstreamResults) ? upstreamResults : [];
  const maxChars = Math.max(600, Math.floor(Number(options.maxChars) || DEFAULT_WORKER_TAIL_CHARS));
  const upstreamPer = Math.max(0, Math.floor(Number(options.upstreamChars ?? DEFAULT_WORKER_UPSTREAM_CHARS)));
  const upstreamTotal = Math.max(0, Math.floor(Number(options.upstreamTotalChars ?? DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS)));

  // Priority from high to low: the task itself and write permission must be kept; the rest are added greedily within the remaining budget.
  const permissionLine = writeFiles.length
    ? `# Allowed modifications\n${writeFiles.map((item) => `- ${item}`).join('\n')}`
    : '# Permissions\nThis subtask is read-only: do not call write_file/edit_file/delete_file; writes will be rejected.';
  const askLine = options.allowAskUser === false
    ? '# Questions\nThis subtask cannot call ask_user; if information is insufficient, write to open_questions and mark partial.'
    : '';
  const doneSection = renderDefinitionOfDone(plan?.definitionOfDone)
    || (plan?.goal
      ? '# Definition of Done\nNo global definition of done provided: use the "Expected output" as the acceptance criterion; if information is insufficient, mark partial and write to open_questions.'
      : '');
  const sections = [
    [
      `# Overall goal\n${hardClip(plan?.goal, 300)}`,
      `# Subtask\n[${task?.id}] ${task?.title}\n${hardClip(task?.brief, 1200)}`,
      `# Expected output\n${hardClip(task?.expectedOutput, 500)}`
    ].join('\n\n'),
    doneSection,
    permissionLine,
    askLine,
    readFiles.length ? `# Suggested reads\n${readFiles.map((item) => `- ${item}`).join('\n')}` : '',
    constraints.length ? `# Constraints\n${constraints.map((item) => `- ${hardClip(item, 240)}`).join('\n')}` : '',
    task?.knownInfo ? `# Known information\n${hardClip(task.knownInfo, 800)}` : '',
    renderAssumptions(plan?.assumptions),
    buildUpstreamSection(results, { perResultChars: upstreamPer, totalChars: upstreamTotal })
  ].filter(Boolean);

  const chunks = [];
  let used = 0;
  for (const section of sections) {
    const cost = (chunks.length ? 2 : 0) + section.length;
    if (used + cost <= maxChars) {
      chunks.push(section);
      used += cost;
      continue;
    }
    // When the budget is insufficient, clip only the current section; if the remaining space after clipping is too small, stop appending.
    const remaining = maxChars - used - (chunks.length ? 2 : 0);
    if (remaining < 160) break;
    chunks.push(hardClip(section, remaining));
    used = maxChars;
  }
  // Extreme case (the task description itself is too long): ensure the total length does not exceed the budget.
  return hardClip(chunks.join('\n\n'), maxChars);
}

// The tools a subtask is actually allowed to call (execution-time permissions, kept consistent with the schema).
// In PTC mode, read-only tools are no longer exposed directly and must go through ptc_run.
export function workerAllowedTools(task, { allowAskUser = false, ptc = false } = {}) {
  const names = new Set(ptc ? [] : READ_TOOL_NAMES);
  // read_tool_result is the direct tool for reading back on-demand distilled results and must also be available in PTC mode.
  names.add('read_tool_result');
  if ((task?.writeFiles || []).length) {
    for (const name of WRITE_TOOL_NAMES) names.add(name);
  }
  if (allowAskUser) names.add('ask_user');
  if (ptc) names.add('ptc_run');
  return names;
}

// DAG-level fixed tool set: all Workers within the same DAG share the same schema bytes.
// When an individual Worker lacks write permission, execution-time enforcement is still handled by workerAllowedTools, without affecting the security boundary.
// Canonical tool set: determined only by toolMode, completely independent of whether this DAG has writes or allows questions.
// Purpose: let all Worker requests on the same machine share exactly the same tools bytes, so cross-DAG provider prefix cache hits can be achieved.
// The permission boundary is still at execution time: workerAllowedTools decides "what can be called", and assertWriteScope validates write paths.
// The hasWrites / allowAskUser parameters are kept only for compatibility with old calls and do not participate in schema filtering.
export function filterWorkerTools(definitions, { ptc = false } = {}) {
  // In PTC mode, read-only tools are called through ptc_run, and only the read-back entry read_tool_result is kept in the schema;
  // otherwise every step of each Worker would pay the prefill cost for unused native read-only schemas.
  const names = new Set(ptc ? ['read_tool_result'] : READ_TOOL_NAMES);
  for (const name of WRITE_TOOL_NAMES) names.add(name);
  names.add('ask_user');
  if (ptc) names.add('ptc_run');
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => names.has(definition?.function?.name));
}
