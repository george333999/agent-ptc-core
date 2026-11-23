// PTC 程序化工具调用的窄接口规格。
// 这里只声明参数形状与静态校验元数据，真正的参数校验在 tools.js 中执行。
// 刻意保持“只读、窄范围、强类型”：不暴露 shell、文件系统通用访问或任意网络能力。

export const PTC_TOOL_SPECS = {
  'files.list': {
    native: 'list_files',
    args: {
      path: { type: 'string', maxLength: 500 },
      depth: { type: 'integer', min: 0, max: 5 }
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
  // 批量并发读取：一次 PTC 调用内部用 Promise.all 并发读多个文件，
  // 总耗时接近最慢的一次而不是求和；单个文件失败不影响其他文件。
  'files.readMany': {
    native: 'read_file',
    args: {
      paths: {
        type: 'array',
        required: true,
        maxItems: 20,
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
      caseSensitive: { type: 'boolean' }
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

// 显式排序，保证每次构建命名空间时的键/方法顺序完全一致。
export const PTC_NAMESPACE_METHODS = Object.freeze(
  Object.fromEntries(
    Object.keys(PTC_NAMESPACE_METHODS_RAW)
      .sort()
      .map((namespace) => [namespace, Object.freeze([...PTC_NAMESPACE_METHODS_RAW[namespace]].sort())])
  )
);

// PTC 模式下列入“程序化只读”的工具：它们不再以原生 schema 暴露，
// 其他工具（写文件、命令、MCP、子 Agent、计划审批等）保留直连调用。
export const PTC_PROGRAMMATIC_TOOLS = new Set(
  PTC_TOOL_NAMES.map((name) => PTC_TOOL_SPECS[name].native)
);

export const PTC_RESERVED_BINDINGS = new Set([
  'files', 'knowledge', 'skills', 'ptc', 'state', 'console', 'log',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'undefined', 'NaN', 'Infinity'
]);
