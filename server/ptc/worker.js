import { parentPort } from 'node:worker_threads';
import vm from 'node:vm';
import { parsePtcSource } from './ast-validator.js';

// 每个 PTC 命名空间运行在独立 worker 中：
// - worker_to_threads 提供进程内隔离、资源上限和可强制终止的墙钟超时
// - vm 上下文移除 Node/网络/文件系统全局，只保留窄工具桥
// - 同一个 worker 内的 vm 上下文长期存活，实现 I-PTC 的变量/函数/state 复用

let context = null;
let pendingTools = new Map();
let nextToolCallId = 1;

const BOOTSTRAP = `
(function () {
  'use strict';
  globalThis.__ptcState = {};
  globalThis.__ptcVars = {};
  globalThis.__ptcLogs = [];
  const bridge = globalThis.__ptcBridge;

  const toText = (value) => {
    if (typeof value === 'string') return value.slice(0, 2000);
    try {
      const json = JSON.stringify(value);
      return (json === undefined ? String(value) : json).slice(0, 2000);
    } catch {
      return String(value).slice(0, 2000);
    }
  };

  const callTool = async (name, args) => {
    const raw = await bridge(name, JSON.stringify(args === undefined ? {} : args));
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      const error = new Error('工具返回了无法解析的结果');
      error.code = 'PTC_BAD_RESPONSE';
      throw error;
    }
    if (!payload || payload.ok !== true) {
      const info = payload && payload.error ? payload.error : {};
      const error = new Error(info.message || '工具调用失败');
      error.code = info.code || 'PTC_TOOL_ERROR';
      error.tool = name;
      throw error;
    }
    return payload.value;
  };

  const defineNamespace = (name, methods) => {
    const namespace = {};
    for (const method of methods) {
      namespace[method] = (args) => callTool(name + '.' + method, args);
    }
    Object.freeze(namespace);
    globalThis[name] = namespace;
  };

  defineNamespace('files', ['list', 'read', 'readMany', 'search']);
  defineNamespace('knowledge', ['search']);
  defineNamespace('skills', ['read']);

  const log = (...args) => {
    if (globalThis.__ptcLogs.length >= 200) return;
    globalThis.__ptcLogs.push(args.map(toText).join(' '));
  };
  globalThis.log = log;
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log });

  globalThis.state = globalThis.__ptcState;
  globalThis.ptc = Object.freeze({
    version: '1.0',
    get traceId() { return globalThis.__ptcTraceId || ''; },
    get state() { return globalThis.__ptcState; }
  });

  globalThis.__ptcCapture = (values) => {
    if (!values || typeof values !== 'object') return;
    for (const key of Object.keys(values)) {
      if (!(key in globalThis.__ptcVars) && Object.keys(globalThis.__ptcVars).length >= 200) continue;
      const value = values[key];
      const type = typeof value;
      if (type === 'undefined' || type === 'symbol' || type === 'bigint') {
        delete globalThis.__ptcVars[key];
        continue;
      }
      // 直接保留引用，保证函数闭包、对象身份和循环引用在 I-PTC 中语义一致；
      // worker 有 128MB 内存上限，超限会被主线程终止并清理命名空间。
      globalThis.__ptcVars[key] = value;
    }
  };
})();
`;

function post(message) {
  try {
    parentPort.postMessage(message);
  } catch {
    // worker 正在退出时忽略。
  }
}

function bridge(toolName, payloadJson) {
  return new Promise((resolve) => {
    const callId = `tc_${nextToolCallId++}`;
    pendingTools.set(callId, resolve);
    post({ type: 'toolCall', callId, tool: String(toolName || ''), payload: String(payloadJson || '{}') });
  });
}

function createContext() {
  const sandbox = Object.create(null);
  context = vm.createContext(sandbox, {
    name: 'ptc-sandbox',
    codeGeneration: { strings: false, wasm: false }
  });
  context.__ptcBridge = bridge;
  vm.runInContext(BOOTSTRAP, context, { filename: 'ptc-bootstrap.js' });
}

function collectTopLevelNames(statements) {
  const names = new Set();
  for (const statement of statements || []) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.name) {
      names.add(statement.id.name);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations || []) {
        collectPatternNames(declarator.id, names);
      }
    }
  }
  return [...names];
}

function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      break;
    case 'ObjectPattern':
      for (const property of node.properties || []) {
        if (property.type === 'RestElement') collectPatternNames(property.argument, out);
        else collectPatternNames(property.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements || []) collectPatternNames(element, out);
      break;
    case 'AssignmentPattern':
      collectPatternNames(node.left, out);
      break;
    case 'RestElement':
      collectPatternNames(node.argument, out);
      break;
    default:
      break;
  }
}

function buildWrapper(code, traceId) {
  const ast = parsePtcSource(code);
  const topNames = collectTopLevelNames(ast.body);
  const declared = new Set(topNames);
  const storedNames = vm.runInContext('Object.keys(__ptcVars)', context);
  const restoreNames = storedNames.filter((name) => !declared.has(name));

  const restore = restoreNames
    .map((name) => `let ${name} = __ptcVars[${JSON.stringify(name)}];`)
    .join('\n');
  const capture = topNames.length
    ? `\ntry { __ptcCapture({ ${topNames.join(', ')} }); } catch (__captureError) {}\n`
    : '';

  const insertions = [];
  const directReturns = ast.body.filter((statement) => statement.type === 'ReturnStatement');
  for (const statement of directReturns) {
    if (capture) insertions.push({ pos: statement.start, text: capture });
  }

  const hasDirectReturn = directReturns.length > 0;
  const last = ast.body[ast.body.length - 1];
  let transformed = code;
  if (!hasDirectReturn && last?.type === 'ExpressionStatement' && last.expression) {
    // 最后一行是表达式时提供 REPL 式隐式返回。
    insertions.push({
      pos: last.expression.start,
      text: `${capture}\nreturn (`
    });
    insertions.push({ pos: last.expression.end, text: ')' });
  } else if (capture) {
    insertions.push({ pos: code.length, text: capture });
  }

  insertions.sort((a, b) => b.pos - a.pos);
  for (const insertion of insertions) {
    transformed = transformed.slice(0, insertion.pos) + insertion.text + transformed.slice(insertion.pos);
  }

  return {
    source: `(async () => {\n${restore}\n${transformed}\n})()`,
    topNames,
    restoreNames
  };
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return value.length > 50000 ? `${value.slice(0, 50000)}…[截断]` : value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint') return `BigInt(${value.toString()})`;
  if (type === 'function') return '[Function]';
  if (type === 'symbol') return String(value);
  if (depth >= 6) return '[深度截断]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 500).map((item) => safeValue(item, depth + 1, seen));
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, code: value.code || '' };
    }
    const out = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= 200) {
        out.__truncated = true;
        break;
      }
      out[key] = safeValue(value[key], depth + 1, seen);
      count += 1;
    }
    return out;
  } catch {
    return '[无法读取]';
  } finally {
    seen.delete(value);
  }
}

async function handleRun(message) {
  const id = message.id;
  const traceId = String(message.traceId || '');
  try {
    if (!context) createContext();
    context.__ptcTraceId = traceId;
    const { source, topNames, restoreNames } = buildWrapper(String(message.code || ''), traceId);
    const script = new vm.Script(source, {
      filename: 'ptc-code.js',
      displayErrors: true
    });
    const value = await script.runInContext(context);
    const logs = vm.runInContext('__ptcLogs.splice(0, __ptcLogs.length)', context);
    const stateKeys = vm.runInContext('Object.keys(__ptcState)', context);
    const varKeys = vm.runInContext('Object.keys(__ptcVars)', context);
    post({
      type: 'runResult',
      id,
      ok: true,
      hasValue: value !== undefined,
      value: safeValue(value),
      logs: Array.isArray(logs) ? safeValue(logs) : [],
      stateKeys: Array.isArray(stateKeys) ? stateKeys.slice(0, 200) : [],
      varKeys: Array.isArray(varKeys) ? varKeys.slice(0, 200) : [],
      persisted: [...new Set([...topNames, ...restoreNames])].slice(0, 200)
    });
  } catch (error) {
    post({
      type: 'runResult',
      id,
      ok: false,
      error: {
        code: error?.code || 'PTC_RUNTIME_ERROR',
        message: String(error?.message || error || '执行失败'),
        name: String(error?.name || 'Error'),
        tool: String(error?.tool || '')
      }
    });
  }
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'toolResult') {
    const resolve = pendingTools.get(message.callId);
    if (resolve) {
      pendingTools.delete(message.callId);
      resolve(String(message.payload ?? '{}'));
    }
    return;
  }
  if (message.type === 'run') {
    handleRun(message);
    return;
  }
  if (message.type === 'reset') {
    context = null;
    return;
  }
  if (message.type === 'dispose') {
    context = null;
    process.exit(0);
  }
});
