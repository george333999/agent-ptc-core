// Narrow interface specs for Programmatic Tool Calling (PTC).
// Only parameter shapes and static validation metadata are declared here; the actual argument validation runs in tools.js.
// Deliberately kept "read-only, narrow, strongly typed": no shell, general filesystem access, or arbitrary network capability is exposed.

export const PTC_TOOL_SPECS = {
  'files.list': {
    native: 'list_files',
    args: {
      path: { type: 'string', maxLength: 500 },
      depth: { type: 'integer', min: 0, max: 5 },
      // File-dense directories are enumerated with pagination so the 400-entry per-call limit does not hide later files.
      offset: { type: 'integer', min: 0, max: 10000 },
      limit: { type: 'integer', min: 1, max: 400 }
    }
  },
  'files.read': {
    native: 'read_file',
    args: {
      path: { type: 'string', required: true, maxLength: 500, path: true },
      startLine: { type: 'integer', min: 1, max: 1000000 },
      endLine: { type: 'integer', min: 1, max: 1000000 }
    }
  },
  // Batch read: deduplicated files are read with bounded-concurrency async I/O,
  // so total time is close to the slowest batch rather than the sum; one failed file does not affect the others.
  // The limit of 50 lets file-dense tasks cover more files in one call and reduces model round-trips.
  'files.readMany': {
    native: 'read_file',
    args: {
      paths: {
        type: 'array',
        required: true,
        maxItems: 50,
        item: { type: 'string', maxLength: 500, path: true }
      },
      startLine: { type: 'integer', min: 1, max: 1000000 },
      endLine: { type: 'integer', min: 1, max: 1000000 }
    }
  },
  'files.search': {
    native: 'search_files',
    args: {
      query: { type: 'string', required: true, maxLength: 500 },
      path: { type: 'string', maxLength: 500, path: true },
      glob: { type: 'string', maxLength: 200 },
      target: { type: 'enum', values: ['content', 'filename'] },
      caseSensitive: { type: 'boolean' },
      regex: { type: 'boolean' }
    }
  },
  'knowledge.search': {
    native: 'knowledge_search',
    args: {
      query: { type: 'string', required: true, maxLength: 500 },
      topK: { type: 'integer', min: 1, max: 12 },
      docName: { type: 'string', maxLength: 200 },
      collection: { type: 'string', maxLength: 100 },
      fileType: { type: 'string', maxLength: 20 }
    }
  },
  'skills.read': {
    native: 'read_skill',
    args: {
      name: { type: 'string', required: true, maxLength: 200 }
    }
  }
};

export const PTC_TOOL_NAMES = Object.freeze(Object.keys(PTC_TOOL_SPECS).sort());

const PTC_NAMESPACE_METHODS_RAW = {
  files: ['list', 'read', 'readMany', 'search'],
  knowledge: ['search'],
  skills: ['read']
};

// Explicit sorting ensures the key/method order is identical every time a namespace is built.
export const PTC_NAMESPACE_METHODS = Object.freeze(
  Object.fromEntries(
    Object.keys(PTC_NAMESPACE_METHODS_RAW)
      .sort()
      .map((namespace) => [namespace, Object.freeze([...PTC_NAMESPACE_METHODS_RAW[namespace]].sort())])
  )
);

// Tools listed as "programmatic read-only" in PTC mode: they are no longer exposed with native schemas,
// while other tools (file writes, commands, MCP, sub-agents, plan approvals, etc.) keep direct calls.
export const PTC_PROGRAMMATIC_TOOLS = new Set(
  PTC_TOOL_NAMES.map((name) => PTC_TOOL_SPECS[name].native)
);

export const PTC_RESERVED_BINDINGS = new Set([
  'files', 'knowledge', 'skills', 'ptc', 'state', 'console', 'log',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'undefined', 'NaN', 'Infinity'
]);
