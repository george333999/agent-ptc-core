// Human-readable report of parallel orchestration results. Separated from execution logic so the orchestrator does not keep growing.
function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... (truncated, ${value.length} chars total)`;
}

export function formatOrchestrationReport({ plan, results, conflicts, needsArbitration, metrics }) {
  const statusLabel = {
    completed: 'completed',
    partial: 'partially completed',
    failed: 'failed',
    timeout: 'timed out',
    aborted: 'cancelled',
    skipped: 'not executed'
  };
  const conflictLabel = { high: 'high', medium: 'medium', low: 'low' };
  const taskLines = results.map((result) => [
    `### [${result.taskId}] ${result.title} — ${statusLabel[result.status] || result.status} (confidence ${Math.round((result.confidence || 0) * 100)}%, ${Math.round((result.durationMs || 0) / 1000)}s)`,
    `Result: ${clip(result.result, 1200)}`,
    result.evidence.length ? `Evidence: ${result.evidence.slice(0, 5).map((item) => clip(item, 220)).join('; ')}` : 'Evidence: none',
    result.open_questions.length ? `Open questions: ${result.open_questions.slice(0, 4).map((item) => clip(item, 220)).join('; ')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  const conflictLines = conflicts.length
    ? conflicts.map((conflict) => `- [${conflictLabel[conflict.severity] || conflict.severity}] ${conflict.message}`).join('\n')
    : 'No conflicts requiring arbitration found.';

  const savings = [
    `- Sub-agent tokens: ${metrics.workerTokens}`,
    metrics.baselineTokens && metrics.workerTokens
      ? `- Serial baseline estimated from full conversation history: ${metrics.baselineTokens} tokens, actual savings about ${metrics.tokenSaved} tokens (${metrics.tokenSavedPercent}%)`
      : '- No usable token usage or history baseline; context token savings cannot be estimated for this run.',
    `- Serial execution time of subtasks: ${(metrics.serialWorkerMs / 1000).toFixed(1)}s; actual wall-clock time: ${(metrics.wallMs / 1000).toFixed(1)}s; parallel savings about ${(metrics.parallelSavedMs / 1000).toFixed(1)}s`,
    metrics.prewarmTokens
      ? `- Worker prefix prewarm: ${metrics.prewarmTokens} tokens, ${(metrics.prewarmMs / 1000).toFixed(2)}s, reused by ${metrics.tasks} Workers sharing the same prefix`
      : '',
    metrics.firstCallHitRate !== null && metrics.firstCallHitRate !== undefined
      ? `- First-round cache hit rate: ${(metrics.firstCallHitRate * 100).toFixed(1)}% (shared prefix + each Worker's exclusive tail)`
      : '',
    metrics.uniqueTailTokens
      ? `- Exclusive tails total about ${metrics.uniqueTailTokens} tokens; shared prefix hash count ${metrics.prefixHashCount || 1} (greater than 1 means the prefix was unexpectedly split)`
      : '',
    metrics.p95WorkerMs
      ? `- Subtask duration p95: ${(metrics.p95WorkerMs / 1000).toFixed(1)}s; estimated cost per successful subtask: ¥${Number(metrics.costPerSuccess || 0).toFixed(6)}`
      : ''
  ].filter(Boolean).join('\n');

  return [
    '## Parallel orchestration results',
    `Goal: ${clip(plan.goal, 300)}`,
    `Completion: ${metrics.completed}/${metrics.tasks} subtasks succeeded; concurrency ${metrics.concurrency}.`,
    'Dispatch mode: each subtask runs in its own Worker; Workers do not nest orchestration; subtasks cooperate only through DAG dependencies.',
    `Threshold check: critical path ${metrics.criticalPathTasks || '-'}/${metrics.tasks} nodes, expected parallel speedup ${metrics.expectedSpeedup || '-'}×; estimated duration ${plan.estimatedMinutes} minutes ≥ decomposition cost ${plan.decompositionCostMinutes} minutes × 1.5.`,
    metrics.economics
      ? `Economics: expected speedup ${metrics.economics.speedup}×, Worker input about ${metrics.economics.tokenOverheadRatio}× the serial baseline, gate ${metrics.economicsGate === 'OK' ? 'passed' : `warning (${metrics.economics.reason})`}.`
      : '',
    metrics.approvalWaitMs || metrics.humanWaitMs
      ? `Time breakdown: compute ${(metrics.computeMs / 1000).toFixed(1)}s, approval wait ${((metrics.approvalWaitMs + metrics.humanWaitMs) / 1000).toFixed(1)}s.`
      : '',
    '',
    '### Structured subtask results',
    taskLines,
    '',
    '### Conflict detection and arbitration',
    conflictLines,
    needsArbitration
      ? 'Main Agent arbitration required: do not concatenate results directly; first state the conflict, the arbitration basis and the final adopted version.'
      : 'No secondary arbitration needed, but evidence and uncertainty must still be stated when summarizing.',
    '',
    '### Resource usage',
    savings,
    '',
    'The main Agent now only needs to make the final decision and summary based on the structured results above; do not re-execute completed subtasks. Worker results already include file/line evidence, so cite them directly; unless two results conflict or evidence is missing, do not re-check the same file with ptc_run/read_file. If a conflict requires new changes, re-dispatch subtasks targeting only the conflicting files.'
  ].join('\n');
}
