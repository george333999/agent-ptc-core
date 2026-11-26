import crypto from 'node:crypto';

// taskType: used to aggregate "similar tasks" into the same progress bucket, for the R_est median and baseline statistics.
// Definition: a stable hash of mode + the first 3 distinct tool categories + attachmentKind + entryTag.
// Freeze when the 3rd distinct category first appears; before freezing, return 'pending' (excluded from Phase 2 R calibration).

export const CATEGORY_VERSION = 1;

// The tool category mapping must be explicitly versioned: historical taskTypes need to be recomputed after category membership changes.
export const TOOL_CATEGORY = Object.freeze({
  list_files: 'read',
  read_file: 'read',
  search_files: 'read',
  read_tool_result: 'read',
  knowledge_search: 'read',
  read_skill: 'read',
  todo_write: 'read',
  task: 'read',
  orchestrate: 'read',
  propose_plan: 'read',
  ask_user: 'read',
  ptc_run: 'read',
  write_file: 'edit',
  edit_file: 'edit',
  delete_file: 'edit',
  ppt_optimize: 'edit',
  pdf_to_xlsx: 'edit',
  write_xlsx: 'edit',
  extract_text: 'edit',
  run_command: 'command',
  fetch_url: 'web',
  web_search: 'web'
});

export function toolCategory(name) {
  const value = String(name || '');
  if (!value) return '';
  if (TOOL_CATEGORY[value]) return TOOL_CATEGORY[value];
  if (value.startsWith('mcp__')) return 'mcp';
  return 'other';
}

const ATTACHMENT_KINDS = [
  ['.pdf', 'pdf'],
  ['.docx', 'document'],
  ['.doc', 'document'],
  ['.xlsx', 'sheet'],
  ['.xls', 'sheet'],
  ['.csv', 'sheet'],
  ['.pptx', 'slides'],
  ['.ppt', 'slides'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.webp', 'image'],
  ['.bmp', 'image'],
  ['.tif', 'image'],
  ['.tiff', 'image']
];

// Attachment type takes only one stable value: the first match by fixed priority, independent of file order.
export function attachmentKindFromFiles(files = []) {
  const list = (Array.isArray(files) ? files : []).map((file) => String(file || '').toLowerCase());
  for (const [extension, kind] of ATTACHMENT_KINDS) {
    if (list.some((file) => file.endsWith(extension))) return kind;
  }
  return 'none';
}

function hashTaskType(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);
}

export function pendingTaskType() {
  return 'pending';
}

export function createTaskTypeTracker({
  mode = 'agent',
  entryTag = 'web',
  attachmentKind = 'none'
} = {}) {
  const categories = new Set();
  let frozenValue = null;

  const compute = () => hashTaskType({
    v: CATEGORY_VERSION,
    mode,
    entryTag,
    attachmentKind,
    categories: [...categories].sort()
  });

  return {
    recordTool(name) {
      if (frozenValue) return frozenValue;
      const category = toolCategory(name);
      if (!category) return null;
      categories.add(category);
      if (categories.size >= 3) frozenValue = compute();
      return frozenValue;
    },
    // The taskType used in metrics: explicitly mark pending when fewer than 3 categories, to avoid a fake "same class".
    current() {
      return frozenValue || pendingTaskType();
    },
    frozen() {
      return frozenValue;
    },
    snapshot() {
      return {
        taskType: this.current(),
        frozen: Boolean(frozenValue),
        categories: [...categories].sort(),
        categoryVersion: CATEGORY_VERSION,
        mode,
        entryTag,
        attachmentKind
      };
    }
  };
}
