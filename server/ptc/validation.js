// PTC 静态校验失败的可恢复策略与提示文案。
// 独立成模块，避免 agent.js 继续膨胀；全部为纯函数，便于单测。

// PTC 静态校验失败属于模型可纠正的写法错误：先给具体错误和可用写法，自动纠错 2 次后再停。
export const MAX_PTC_VALIDATION_NUDGES = 2;

export function isPtcValidationFailure(toolCall) {
  if (!toolCall) return false;
  return /^【PTC 静态校验未通过】/.test(String(toolCall.result || ''));
}

export function ptcValidationAction({ failed = false, nudges = 0, max = MAX_PTC_VALIDATION_NUDGES } = {}) {
  if (!failed) return 'none';
  return nudges < Math.max(0, Number(max) || 0) ? 'continue' : 'stop';
}

// 累计失败达到阈值后不再让模型“继续重写 ptc_run”，而是切换到直连只读工具，
// 避免 PTC-only 模式下模型没有退路、把全部步数烧在同一个校验错误上。
export const MAX_PTC_VALIDATION_FAILURES = 3;

export function ptcFallbackAction({ failures = 0, active = false, max = MAX_PTC_VALIDATION_FAILURES } = {}) {
  if (active) return 'active';
  return Number(failures) >= Math.max(1, Number(max) || 1) ? 'fallback' : 'continue';
}

export const PTC_FALLBACK_NUDGE = [
  '系统提醒：ptc_run 已多次未通过静态校验，已自动切换为直连只读工具模式（read_file/search_files/list_files 可用）。',
  '不要再用 eval/Function 执行或验证页面脚本；直接用 read_file（支持 start_line/end_line）读取目标片段，用 search_files 做搜索，再用 edit_file 精确修改。',
  '后续步骤只提交直连工具调用，不要尝试恢复 ptc_run。'
].join('\n');

function ptcValidationErrorLine(result) {
  const text = String(result || '').trim();
  const line = text.match(/- 第 \d+ 行[^\n]*/)?.[0];
  if (line) return line.slice(0, 300);
  const first = text.split('\n').slice(1).find((item) => item.trim());
  return String(first || text).slice(0, 300);
}

// 针对高频错误码给出可直接照做的改法，避免模型反复踩同一个坑。
export function ptcValidationHint(result) {
  const text = String(result || '');
  if (/PTC_DYNAMIC_MEMBER/.test(text)) {
    return '动态属性改法：局部数组/对象可以用 items[i]；files、JSON、Math 等内置对象只能用静态键，按固定字段访问。';
  }
  if (/PTC_FORBIDDEN_NEW/.test(text)) {
    return 'new 改法：集合/映射用 new Set(...) / new Map(...)，数组/对象优先用字面量，禁止 new 自定义构造函数和宿主对象。';
  }
  if (/禁止访问 eval|PTC_FORBIDDEN_IDENTIFIER[\s\S]*\beval\b/.test(text)) {
    return 'eval 改法：PTC 禁止 eval/Function，也不要用它执行或验证页面脚本；读取目标文件片段后直接修改，验证交给运行命令或人工检查。JSON 用 JSON.parse，字符串处理用 split/replace。';
  }
  if (/PTC_UNKNOWN_IDENTIFIER/.test(text)) {
    return '标识符改法：只使用已声明的变量，以及 files / knowledge / skills / state / JSON / Math / Object / Array / Promise 等内置 API。';
  }
  if (/PTC_PATH|PTC_TOOL/.test(text)) {
    return '工具参数改法：路径必须是工作区内的相对路径，读取多个文件优先用 files.readMany。';
  }
  return '';
}

export function ptcValidationNudge(result) {
  const hint = ptcValidationHint(result);
  return [
    '系统提醒：上一次 ptc_run 的代码未通过 PTC 静态校验，任务尚未完成。',
    `最后一次错误：${ptcValidationErrorLine(result)}`,
    hint,
    '不要原样重试，也不要结束回答。请立即改写并重新提交一个新的 ptc_run：',
    '禁止使用 eval、Function、class、import、this、process、动态属性访问和绝对路径；',
    '可以使用正则字面量；new 只允许 Set/Map/Date/RegExp/Error/Array/Object/Promise 等标准内置构造器；',
    '只使用 var/let/const、普通函数、await、for...of，以及 files.list/read/readMany/search、knowledge.search、skills.read 等只读 API；批量读取优先用 files.readMany。'
  ].filter(Boolean).join('\n');
}

export function ptcValidationFinal(result) {
  return `PTC 代码连续 ${MAX_PTC_VALIDATION_NUDGES + 1} 次未通过静态校验，且自动降级后仍未完成，已停止。最后一次错误：${ptcValidationErrorLine(result)}。请改用直连只读工具（read_file/search_files）重新发起任务，或手动调整代码后重试。`;
}
