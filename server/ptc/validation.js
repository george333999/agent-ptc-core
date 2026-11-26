// Recoverable strategy and prompt text for PTC static validation failures.
// Kept as a standalone module to avoid growing agent.js; all pure functions for easy unit testing.

// PTC static validation failures are syntax mistakes the model can correct: give the specific error and valid alternatives, auto-correct twice, then stop.
export const MAX_PTC_VALIDATION_NUDGES = 2;

export function isPtcValidationFailure(toolCall) {
  if (!toolCall) return false;
  return /^\[PTC static validation failed\]/.test(String(toolCall.result || ''));
}

export function ptcValidationAction({ failed = false, nudges = 0, max = MAX_PTC_VALIDATION_NUDGES } = {}) {
  if (!failed) return 'none';
  return nudges < Math.max(0, Number(max) || 0) ? 'continue' : 'stop';
}

// Once cumulative failures reach the threshold, stop asking the model to "keep rewriting ptc_run" and switch to direct read-only tools,
// so PTC-only mode does not leave the model with no fallback and burn every step on the same validation error.
export const MAX_PTC_VALIDATION_FAILURES = 3;

export function ptcFallbackAction({ failures = 0, active = false, max = MAX_PTC_VALIDATION_FAILURES } = {}) {
  if (active) return 'active';
  return Number(failures) >= Math.max(1, Number(max) || 1) ? 'fallback' : 'continue';
}

export const PTC_FALLBACK_NUDGE = [
  'System reminder: ptc_run has repeatedly failed static validation, so direct read-only tool mode has been automatically enabled (read_file/search_files/list_files available).',
  'Do not use eval/Function to execute or verify page scripts; read the target fragment directly with read_file (supports start_line/end_line), search with search_files, then make precise edits with edit_file.',
  'In subsequent steps submit direct tool calls only; do not try to restore ptc_run.'
].join('\n');

function ptcValidationErrorLine(result) {
  const text = String(result || '').trim();
  const line = text.match(/- Line \d+[^\n]*/)?.[0];
  if (line) return line.slice(0, 300);
  const first = text.split('\n').slice(1).find((item) => item.trim());
  return String(first || text).slice(0, 300);
}

// Give directly actionable fixes for high-frequency error codes, so the model does not repeatedly hit the same pitfall.
export function ptcValidationHint(result) {
  const text = String(result || '');
  if (/PTC_DYNAMIC_MEMBER/.test(text)) {
    return 'Dynamic property fix: local arrays/objects may use items[i]; built-in objects such as files, JSON, and Math only accept static keys — access them through fixed fields.';
  }
  if (/PTC_FORBIDDEN_NEW/.test(text)) {
    return 'new fix: use new Set(...) / new Map(...) for collections/maps, prefer literals for arrays/objects, and never new custom constructors or host objects.';
  }
  if (/Access to eval is forbidden|PTC_FORBIDDEN_IDENTIFIER[\s\S]*\beval\b/.test(text)) {
    return 'eval fix: PTC forbids eval/Function, and they must not be used to execute or verify page scripts; read the target file fragment and edit it directly, leaving verification to run commands or manual checks. Use JSON.parse for JSON and split/replace for string handling.';
  }
  if (/PTC_UNKNOWN_IDENTIFIER/.test(text)) {
    return 'Identifier fix: use only declared variables and built-in APIs such as files / knowledge / skills / state / JSON / Math / Object / Array / Promise.';
  }
  if (/PTC_PATH|PTC_TOOL/.test(text)) {
    return 'Tool argument fix: paths must be relative paths inside the workspace; prefer files.readMany when reading multiple files.';
  }
  return '';
}

export function ptcValidationNudge(result) {
  const hint = ptcValidationHint(result);
  return [
    'System reminder: ptc_run failed static validation; task unfinished.',
    `Error: ${ptcValidationErrorLine(result)}`,
    hint,
    'Do not repeat unchanged or finish. Submit a new ptc_run:',
    'no eval/Function/class/import/this/process, dynamic access or absolute paths;',
    'regex literals allowed; new only Set/Map/Date/RegExp/Error/Array/Object/Promise;',
    'use var/let/const, plain functions, await, for...of, and read-only APIs; batch with files.readMany.'
  ].filter(Boolean).join('\n');
}

export function ptcValidationFinal(result) {
  return `PTC code failed static validation ${MAX_PTC_VALIDATION_NUDGES + 1} times in a row, and the automatic fallback still did not complete, so it has been stopped. Last error: ${ptcValidationErrorLine(result)}. Please retry the task with direct read-only tools (read_file/search_files), or adjust the code manually and retry.`;
}
