// Deliverable contract: recognize the artifact kinds the user explicitly requested and decide whether the matching file has actually been produced.
// Used only for reminder/acceptance, not as a substitute for model execution; the goal is to avoid a user asking for Excel and receiving only a pile of scripts.

const DELIVERABLE_ACTIONS = /(?:生成|创建|新建|导出|输出|转换|转成|转为|整理成|做成|保存为|保存成|写入|写到|汇总为|合并为|写(?:一份|一个|个|份))/i;

const DELIVERABLE_KINDS = [
  { kind: 'xlsx', re: /\.xlsx\b|\bxlsx\b|\bexcel\b|电子表格|工作簿/i },
  { kind: 'pptx', re: /\.pptx\b|\bpptx\b|\bppt\b|演示文稿|幻灯片/i },
  { kind: 'docx', re: /\.docx\b|\bdocx\b|\bword\b|word\s*文档/i },
  { kind: 'pdf', re: /\.pdf\b|\bpdf\b/i },
  { kind: 'csv', re: /\.csv\b|\bcsv\b/i },
  { kind: 'html', re: /\.html?\b|\bhtml\b|网页/i }
];

export function requiredDeliverableKinds(text) {
  const value = String(text || '');
  if (!value) return [];
  const kinds = new Set();
  // Only inspect the target fragment after an action word: avoids treating the input xlsx in "read a.xlsx and convert to csv" as a deliverable.
  for (const match of value.matchAll(new RegExp(DELIVERABLE_ACTIONS.source, 'gi'))) {
    const start = (match.index || 0) + match[0].length;
    const windowText = value.slice(start, start + 40);
    for (const item of DELIVERABLE_KINDS) {
      if (item.re.test(windowText)) kinds.add(item.kind);
    }
  }
  return [...kinds];
}

// Decide whether the user explicitly requires the result to be written to a workspace file.
// Used only to append a reminder when the model forgets to write to disk; normal conversations are unaffected.
export function requiresWorkspaceDeliverable(text) {
  const value = String(text || '');
  if (!value) return false;
  if (requiredDeliverableKinds(value).length) return true;
  if (/outputs\//i.test(value)) return true;
  return /(?:写入|写到|保存到|输出到|生成|导出)[^\n]{0,80}(?:\.md|\.txt|\.csv|\.xlsx|\.docx|\.pptx|报告|文档|表格|文件)/i.test(value);
}

// Extract the output path explicitly requested in the user message so the reminder can force the model to use it.
export function extractDeliverablePath(text) {
  const value = String(text || '');
  if (!value) return '';
  const outputMatch = value.match(/outputs\/[\w.\-\u4e00-\u9fa5/]+/i);
  if (outputMatch) return outputMatch[0].replace(/[，。；、：)）\]]+$/u, '');
  const fileMatch = value.match(/[\w.\-\u4e00-\u9fa5]+\.(?:md|txt|csv|xlsx|docx|pptx|pdf|html?)/i);
  return fileMatch ? fileMatch[0] : '';
}

export function deliverableExtensions(kinds) {
  return (Array.isArray(kinds) ? kinds : []).flatMap((kind) => (kind === 'html' ? ['.html', '.htm'] : [`.${kind}`]));
}
