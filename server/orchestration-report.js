// 并行编排结果的可读报告。与执行逻辑分离，避免 orchestrator 继续膨胀。
function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...（已截断，共 ${value.length} 字符）`;
}

export function formatOrchestrationReport({ plan, results, conflicts, needsArbitration, metrics }) {
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
    `- 串行执行子任务耗时：${(metrics.serialWorkerMs / 1000).toFixed(1)}s；实际墙钟：${(metrics.wallMs / 1000).toFixed(1)}s；并行节省约 ${(metrics.parallelSavedMs / 1000).toFixed(1)}s`,
    metrics.prewarmTokens
      ? `- Worker 前缀预热：${metrics.prewarmTokens} tokens，${(metrics.prewarmMs / 1000).toFixed(2)}s，供 ${metrics.tasks} 个 Worker 复用同一前缀`
      : '',
    metrics.firstCallHitRate !== null && metrics.firstCallHitRate !== undefined
      ? `- 首轮缓存命中率：${(metrics.firstCallHitRate * 100).toFixed(1)}%（共享前缀 + 每个 Worker 的专属尾部）`
      : '',
    metrics.uniqueTailTokens
      ? `- 专属尾部合计约 ${metrics.uniqueTailTokens} tokens；共享前缀哈希数 ${metrics.prefixHashCount || 1}（大于 1 说明前缀被意外分裂）`
      : '',
    metrics.p95WorkerMs
      ? `- 子任务耗时 p95：${(metrics.p95WorkerMs / 1000).toFixed(1)}s；单成功子任务估算成本：¥${Number(metrics.costPerSuccess || 0).toFixed(6)}`
      : ''
  ].filter(Boolean).join('\n');

  return [
    '## 并行编排结果',
    `目标：${clip(plan.goal, 300)}`,
    `完成情况：${metrics.completed}/${metrics.tasks} 个子任务成功；并行度 ${metrics.concurrency}。`,
    '派发模式：每个子任务由独立 Worker 执行，Worker 内不再嵌套编排；子任务之间只通过 DAG 依赖协作。',
    `阈值校验：关键路径 ${metrics.criticalPathTasks || '-'}/${metrics.tasks} 个节点，预计并行加速 ${metrics.expectedSpeedup || '-'}×；预计耗时 ${plan.estimatedMinutes} 分钟 ≥ 拆解成本 ${plan.decompositionCostMinutes} 分钟 × 1.5。`,
    metrics.economics
      ? `经济性评估：预计加速 ${metrics.economics.speedup}×，Worker 输入约为串行基线的 ${metrics.economics.tokenOverheadRatio} 倍，门禁${metrics.economicsGate === 'OK' ? '通过' : `告警（${metrics.economics.reason}）`}。`
      : '',
    metrics.approvalWaitMs || metrics.humanWaitMs
      ? `耗时拆分：计算 ${(metrics.computeMs / 1000).toFixed(1)}s，审批等待 ${((metrics.approvalWaitMs + metrics.humanWaitMs) / 1000).toFixed(1)}s。`
      : '',
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
    '主 Agent 现在只需基于以上结构化结果做最终裁决和汇总；不要重复执行已完成的子任务。Worker 结果已附文件/行号证据，直接引用即可；除非两份结果冲突或证据缺失，不要再用 ptc_run/read_file 复核同一文件。若冲突需要新的修改，请重新派发只针对冲突文件的子任务。'
  ].join('\n');
}
