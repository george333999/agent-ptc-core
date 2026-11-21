// 工具定义的稳定排序：按 function.name 的字节序排列，
// 保证每次请求的 tool schema 字节完全一致，避免前缀从工具定义处开始分叉。
export function compareToolDefinitions(a, b) {
  const left = String(a?.function?.name || '');
  const right = String(b?.function?.name || '');
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sortToolDefinitions(definitions) {
  return (Array.isArray(definitions) ? [...definitions] : []).sort(compareToolDefinitions);
}
