import { parentPort } from 'node:worker_threads';
import vm from 'node:vm';
import { parsePtcSource } from './ast-validator.js';

// Each PTC namespace runs in its own worker:
// - worker_threads provides in-process isolation, resource limits, and a forcibly terminable wall-clock timeout
// - the vm context removes Node/network/filesystem globals, keeping only the narrow tool bridge
// - the vm context inside the same worker lives long, enabling I-PTC variable/function/state reuse

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
      const error = new Error('Tool returned an unparseable result');
      error.code = 'PTC_BAD_RESPONSE';
      throw error;
    }
    if (!payload || payload.ok !== true) {
      const info = payload && payload.error ? payload.error : {};
      const error = new Error(info.message || 'Tool call failed');
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
      // Keep references directly so function closures, object identity, and circular references stay semantically consistent in I-PTC;
      // the worker has a 128MB memory limit; exceeding it is terminated by the main thread, which cleans up the namespace.
      globalThis.__ptcVars[key] = value;
    }
  };
})();
`;

function post(message) {
  try {
    parentPort.postMessage(message);
  } catch {
    // Ignore while the worker is exiting.
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
    // Provide a REPL-style implicit return when the last line is an expression.
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
  if (type === 'string') return value.length > 50000 ? `${value.slice(0, 50000)}…[truncated]` : value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint') return `BigInt(${value.toString()})`;
  if (type === 'function') return '[Function]';
  if (type === 'symbol') return String(value);
  if (depth >= 6) return '[depth truncated]';
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
    return '[unreadable]';
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
        message: String(error?.message || error || 'Execution failed'),
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
