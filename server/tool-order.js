// Stable ordering of tool definitions: sort by the byte order of function.name,
// ensuring the tool schema bytes are exactly identical on every request, so the prefix does not diverge at the tool definitions.
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
