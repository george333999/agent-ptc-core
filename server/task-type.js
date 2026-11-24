import crypto from 'node:crypto';

// taskType：用于把“同类任务”聚合成同一个进度桶，供 R_est 中位数与基线统计使用。
// 口径：mode + 前 3 个不同工具类别 + attachmentKind + entryTag 的稳定哈希。
// 第 3 个不同类别首次出现时冻结；冻结前返回 'pending'（不参与 Phase 2 的 R 校准）。

export const CATEGORY_VERSION = 1;

// 工具类别映射必须显式版本化：类别归属变化后历史 taskType 需要重算。
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

// 附件类型只取一个稳定值：按固定优先级取第一个命中项，与文件顺序无关。
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
    // 指标里使用的 taskType：未满 3 类时明确标 pending，避免伪“同类”。
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
