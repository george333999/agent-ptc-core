// 交付物契约：识别用户明确要求的产物类型，并判断是否已真正产出对应文件。
// 只用于“提醒/验收”，不替代模型执行；目标是避免用户要 Excel 却只拿到一堆脚本。

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
  // 只看动作词之后的目标片段：避免把“读取 a.xlsx 转成 csv”里的输入 xlsx 当成交付物。
  for (const match of value.matchAll(new RegExp(DELIVERABLE_ACTIONS.source, 'gi'))) {
    const start = (match.index || 0) + match[0].length;
    const windowText = value.slice(start, start + 40);
    for (const item of DELIVERABLE_KINDS) {
      if (item.re.test(windowText)) kinds.add(item.kind);
    }
  }
  return [...kinds];
}

// 判断用户是否明确要求把结果写入工作区文件。
// 只用于在模型忘记落盘时追加提醒，不改变正常对话。
export function requiresWorkspaceDeliverable(text) {
  const value = String(text || '');
  if (!value) return false;
  if (requiredDeliverableKinds(value).length) return true;
  if (/outputs\//i.test(value)) return true;
  return /(?:写入|写到|保存到|输出到|生成|导出)[^\n]{0,80}(?:\.md|\.txt|\.csv|\.xlsx|\.docx|\.pptx|报告|文档|表格|文件)/i.test(value);
}

// 从用户消息中提取明确要求的输出路径，供提醒里强制模型使用。
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
