// Main agent task contract: Socratic self-check, verifiable completion criteria, key assumptions.
// Position constraint: the self-check block is appended only to the tail of the current user message, never touching the system/tools prefix, to preserve provider prefix caching.
// Division constraint: only the main agent self-checks; sub-agents never ask themselves and only consume the delivered completion criteria and assumptions, avoiding duplicated reasoning cost.

export const SOCRATIC_QUESTIONS = Object.freeze([
  'What is the real goal? What counts as done (a verifiable end condition)?',
  'What is known, what is unknown, and which assumptions are made?',
  'Where is failure, timeout, or rework most likely?',
  'Which approach is best, and why not the main alternative?',
  'What is next, and what should be delegated to sub-agents?'
]);

export const CONTRACT_LIST_MAX = 6;
export const CONTRACT_ITEM_MAX = 240;

export function shouldUseSocraticBrief({ mode = 'chat', complexTask = false, settings = {} } = {}) {
  // Self-check only for complex Agent tasks: Chat is lightweight Q&A, and adding a self-check to simple tasks only increases first-packet latency and tokens.
  return mode === 'agent' && complexTask === true && settings?.socraticBrief !== false;
}

// Fixed text with no time, task ID, or other volatile content; it only enters the tail of the current user message.
export function buildSocraticBrief() {
  return [
    '[Task self-check · internal only, do not output the process]',
    'Answer these 5 questions before acting, and carry the conclusions into subsequent actions:',
    ...SOCRATIC_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    'Execution: for complex tasks, start with propose_plan (goal = real goal, steps[].detail = completion criteria, definitionOfDone = verifiable end conditions, assumptions = key assumptions, risks = trade-offs); when orchestration is needed, write definitionOfDone and assumptions into orchestrate, and each subtask brief must let a sub-agent execute independently.',
    'Constraints: do not call extra tools for the self-check, do not output the self-check process, and do not expand the task scope because of it.',
    'Clarification: when the task already names concrete files/directories and completion criteria can be inferred, do not re-confirm via ask_user; ask only when missing key information would change the artifact.'
  ].join('\n');
}

function normalizeList(value, { max = CONTRACT_LIST_MAX, itemMax = CONTRACT_ITEM_MAX } = {}) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, itemMax);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeContract(input = {}) {
  return {
    definitionOfDone: normalizeList(input?.definitionOfDone ?? input?.done),
    assumptions: normalizeList(input?.assumptions)
  };
}

export function deriveDefinitionOfDone() {
  return ['All subtasks return completed, and every subtask expectedOutput has been produced'];
}

// An orchestration plan must have executable completion criteria: use the deterministic fallback when the model provides none instead of leaving it empty.
export function contractForOrchestration(input = {}) {
  const contract = normalizeContract(input);
  return {
    definitionOfDone: contract.definitionOfDone.length
      ? contract.definitionOfDone
      : deriveDefinitionOfDone(),
    assumptions: contract.assumptions
  };
}

function hardClip(text, limit) {
  const value = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

export function renderDefinitionOfDone(list, { maxChars = 400 } = {}) {
  const items = normalizeList(list);
  if (!items.length) return '';
  return hardClip(`# Definition of Done\n${items.map((item) => `- ${item}`).join('\n')}`, maxChars);
}

export function renderAssumptions(list, { maxChars = 400 } = {}) {
  const items = normalizeList(list);
  if (!items.length) return '';
  return hardClip(`# Key Assumptions\n${items.map((item) => `- ${item}`).join('\n')}`, maxChars);
}
