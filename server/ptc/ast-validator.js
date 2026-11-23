import { parse } from 'acorn';
import {
  PTC_NAMESPACE_METHODS,
  PTC_RESERVED_BINDINGS,
  PTC_TOOL_SPECS
} from './specs.js';

// PTC 三层 AST 校验：
// 第 1 层：语法与结构（解析失败、规模、深度、循环/调用数量、常量真循环）
// 第 2 层：能力与安全（禁止标识符、原型链、动态成员、危险语法、作用域引用）
// 第 3 层：数据流与资源（窄工具方法、参数键/类型、路径穿越、调用预算）
// 校验在沙盒执行之前完成，明显无效或危险的脚本不会进入 worker。

export const PTC_CODE_MAX_CHARS = 40000;
export const PTC_MAX_NODES = 5000;
export const PTC_MAX_DEPTH = 48;
export const PTC_MAX_LINES = 1200;
export const PTC_MAX_CALLS = 60;
export const PTC_MAX_LOOPS = 50;
export const PTC_MAX_SITE_CALLS = 80;
export const PTC_MAX_ERRORS = 12;

const FORBIDDEN_IDENTIFIERS = new Set([
  'process', 'global', 'globalThis', 'require', 'module', 'exports',
  '__dirname', '__filename', 'Buffer', 'eval', 'Function', 'Reflect', 'Proxy',
  'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'setTimeout', 'setInterval',
  'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'navigator', 'location', 'history',
  'document', 'window', 'self', 'parent', 'top', 'frames', 'localStorage',
  'sessionStorage', 'indexedDB', 'Deno', 'Bun', 'arguments'
]);

const FORBIDDEN_NODE_TYPES = new Map([
  ['ClassDeclaration', '不支持 class'],
  ['ClassExpression', '不支持 class'],
  ['WithStatement', '不支持 with'],
  ['LabeledStatement', '不支持标签语句'],
  ['DebuggerStatement', '不支持 debugger'],
  ['ImportDeclaration', '不支持 import'],
  ['ExportNamedDeclaration', '不支持 export'],
  ['ExportDefaultDeclaration', '不支持 export'],
  ['ExportAllDeclaration', '不支持 export'],
  ['ImportExpression', '不支持动态 import'],
  ['MetaProperty', '不支持 import.meta / new.target'],
  ['TaggedTemplateExpression', '不支持标签模板'],
  ['YieldExpression', '不支持 generator']
]);

const FORBIDDEN_PROPERTIES = new Set([
  'constructor', '__proto__', 'prototype', 'caller', 'callee',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
]);

const SAFE_GLOBAL_MEMBERS = {
  JSON: new Set(['stringify', 'parse']),
  Math: new Set([
    'abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'max', 'min', 'pow',
    'sqrt', 'cbrt', 'exp', 'log', 'log2', 'log10', 'random', 'imul', 'hypot',
    'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT1_2', 'SQRT2'
  ]),
  Object: new Set(['keys', 'values', 'entries', 'fromEntries', 'assign', 'freeze']),
  Array: new Set(['isArray', 'from']),
  Promise: new Set(['all', 'allSettled', 'race', 'resolve']),
  Number: new Set(['isFinite', 'isInteger', 'isNaN', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode']),
  console: new Set(['log', 'info', 'warn', 'error'])
};

const SAFE_GLOBALS = new Set([
  ...Object.keys(SAFE_GLOBAL_MEMBERS),
  'files', 'knowledge', 'skills', 'ptc', 'state', 'log',
  'undefined', 'NaN', 'Infinity',
  'parseInt', 'parseFloat', 'isFinite', 'isNaN',
  'String', 'Number', 'Boolean', 'Array'
]);

const SAFE_CALLABLE_GLOBALS = new Set([
  'parseInt', 'parseFloat', 'isFinite', 'isNaN',
  'String', 'Number', 'Boolean', 'Array', 'log'
]);

// 只放行不含宿主能力的标准内置构造器；new 自定义函数或宿主对象仍然禁止。
const SAFE_CONSTRUCTORS = new Set([
  'Set', 'Map', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError'
]);

const UNSAFE_CALLEE_GLOBALS = new Set(['JSON', 'Math', 'Object', 'Promise', 'console', 'files', 'knowledge', 'skills', 'ptc', 'state']);

const LOOP_TYPES = new Set(['ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  locations: true
};

function isNode(value) {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string');
}

function childNodes(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type' || key === 'raw' || key === 'regex') continue;
    if (isNode(value)) {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) out.push(item);
      }
    }
  }
  return out;
}

function measureAst(ast) {
  let nodes = 0;
  let maxDepth = 0;
  let loops = 0;
  let awaits = 0;
  let callSites = 0;
  let functions = 0;
  const stack = [{ node: ast, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    nodes += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (node.type === 'CallExpression') callSites += 1;
    if (node.type === 'AwaitExpression') awaits += 1;
    if (LOOP_TYPES.has(node.type)) loops += 1;
    if (FUNCTION_TYPES.has(node.type)) functions += 1;
    for (const child of childNodes(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return { nodes, maxDepth, loops, awaits, callSites, functions };
}

function diagnostic(layer, code, message, node = null) {
  return {
    layer,
    code,
    message,
    line: node?.loc?.start?.line || 0,
    column: node?.loc?.start ? node.loc.start.column + 1 : 0
  };
}

function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const property of node.properties || []) {
        if (property.type === 'RestElement') patternNames(property.argument, out);
        else patternNames(property.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements || []) patternNames(element, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    default:
      break;
  }
  return out;
}

function isConstantTrue(node) {
  if (!node) return false;
  if (node.type === 'Literal') return Boolean(node.value);
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return node.argument?.type === 'Literal' && !node.argument.value;
  }
  return false;
}

function hasLoopExit(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'BreakStatement' || node.type === 'ReturnStatement' || node.type === 'ThrowStatement') return true;
  if (FUNCTION_TYPES.has(node.type)) return false;
  return childNodes(node).some((child) => hasLoopExit(child));
}

function forbiddenProperty(name) {
  return typeof name !== 'string'
    || FORBIDDEN_PROPERTIES.has(name)
    || name.startsWith('__');
}

function rootIdentifier(node) {
  let current = node;
  while (current && current.type === 'MemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current.name : '';
}

function createScope(parent, kind = 'block') {
  return { parent, kind, names: new Map() };
}

function declareName(scope, name, info, node, state) {
  if (!name) return;
  if (PTC_RESERVED_BINDINGS.has(name) || name.startsWith('__')) {
    state.errors.push(diagnostic(2, 'PTC_RESERVED_NAME', `不能重新声明保留名称：${name}`, node));
    return;
  }
  if (!scope.names.has(name)) scope.names.set(name, info);
}

function lookupName(scope, name) {
  let current = scope;
  while (current) {
    if (current.names.has(name)) return current.names.get(name);
    current = current.parent;
  }
  return null;
}

function predeclare(statements, scope, state) {
  for (const statement of statements || []) {
    if (!statement) continue;
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      declareName(scope, statement.id.name, { kind: 'function' }, statement.id, state);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations || []) {
        for (const name of patternNames(declarator.id)) {
          declareName(scope, name, { kind: statement.kind }, declarator.id, state);
        }
      }
    } else if (statement.type === 'ClassDeclaration' && statement.id) {
      declareName(scope, statement.id.name, { kind: 'class' }, statement.id, state);
    }
  }
}

function checkIdentifier(node, scope, state) {
  const name = node.name;
  if (typeof name !== 'string') return;
  if (name.startsWith('__')) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `不能访问内部名称：${name}`, node));
    return;
  }
  if (FORBIDDEN_IDENTIFIERS.has(name)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `禁止访问 ${name}`, node));
    return;
  }
  if (lookupName(scope, name)) return;
  if (SAFE_GLOBALS.has(name)) return;
  state.errors.push(diagnostic(2, 'PTC_UNKNOWN_IDENTIFIER', `未知标识符：${name}（只能使用声明的变量或 PTC 提供的 API）`, node));
}

function validatePattern(pattern, scope, state) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      break;
    case 'RestElement':
      validatePattern(pattern.argument, scope, state);
      break;
    case 'AssignmentPattern':
      validatePattern(pattern.left, scope, state);
      validateNode(pattern.right, scope, state);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties || []) {
        if (property.type === 'RestElement') {
          validatePattern(property.argument, scope, state);
          continue;
        }
        if (property.computed) {
          state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', '解构不支持动态属性名', property));
        }
        validatePattern(property.value, scope, state);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements || []) validatePattern(element, scope, state);
      break;
    default:
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', `不支持的解构目标：${pattern.type}`, pattern));
      break;
  }
}

function checkApiArgumentValue(spec, value, node, state, key) {
  if (!spec) return;
  if (value.type === 'Literal') {
    if (spec.type === 'string' && typeof value.value !== 'string') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} 必须是字符串`, value));
      return;
    }
    if (spec.type === 'integer' && !Number.isInteger(value.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} 必须是整数`, value));
      return;
    }
    if (spec.type === 'boolean' && typeof value.value !== 'boolean') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} 必须是布尔值`, value));
      return;
    }
    if (spec.type === 'enum' && !spec.values.includes(value.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} 只能是 ${spec.values.join(' / ')}`, value));
      return;
    }
    if (spec.path && typeof value.value === 'string') {
      const raw = value.value.trim();
      const segments = raw.replace(/\\/g, '/').split('/');
      const absolute = /^(?:[A-Za-z]:\/|\/|~\/)/.test(raw) || /^[A-Za-z]:\\/.test(value.value);
      if (absolute || segments.includes('..')) {
        state.errors.push(diagnostic(3, 'PTC_PATH_ESCAPE', `路径必须位于工作区内，不能使用绝对路径或 ..：${raw.slice(0, 120)}`, value));
      }
    }
  } else if (value.type === 'UnaryExpression' && value.operator === '-' && value.argument?.type === 'Literal') {
    if (spec.type === 'integer' && !Number.isInteger(-value.argument.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} 必须是整数`, value));
    }
  }
}

function checkApiArgs(apiName, node, state) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (!spec) return;
  if (node.arguments.length > 1) {
    state.errors.push(diagnostic(3, 'PTC_TOO_MANY_ARGS', `${apiName} 只接受一个选项对象参数`, node));
    return;
  }
  if (!node.arguments.length) return;
  const arg = node.arguments[0];
  if (arg.type === 'Identifier' && arg.name === 'undefined') return;
  if (arg.type === 'SpreadElement') {
    state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${apiName} 不支持展开参数`, arg));
    return;
  }
  if (arg.type !== 'ObjectExpression') return;
  for (const property of arg.properties || []) {
    if (property.type === 'SpreadElement') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${apiName} 参数对象不支持展开`, property));
      continue;
    }
    let key = '';
    if (!property.computed && property.key?.type === 'Identifier') key = property.key.name;
    else if (property.key?.type === 'Literal' && typeof property.key.value === 'string') key = property.key.value;
    if (!key) {
      state.errors.push(diagnostic(3, 'PTC_UNKNOWN_ARG', `${apiName} 的参数名必须是静态标识符`, property));
      continue;
    }
    if (!spec.args[key]) {
      state.errors.push(diagnostic(3, 'PTC_UNKNOWN_ARG', `${apiName} 不支持参数 ${key}`, property));
      continue;
    }
    checkApiArgumentValue(spec.args[key], property.value, property, state, key);
  }
}

function identifyApiCall(callee) {
  if (!callee || callee.type !== 'MemberExpression') return '';
  if (callee.object?.type !== 'Identifier') return '';
  const namespace = callee.object.name;
  if (!PTC_NAMESPACE_METHODS[namespace]) return '';
  let method = '';
  if (!callee.computed && callee.property?.type === 'Identifier') method = callee.property.name;
  else if (callee.computed && callee.property?.type === 'Literal' && typeof callee.property.value === 'string') method = callee.property.value;
  return method ? `${namespace}.${method}` : '';
}

function validateMember(node, scope, state) {
  validateNode(node.object, scope, state);
  if (node.computed) {
    const property = node.property;
    const literal = property && property.type === 'Literal'
      && (typeof property.value === 'string' || typeof property.value === 'number');
    if (literal) {
      if (typeof property.value === 'string' && forbiddenProperty(property.value)) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_PROPERTY', `禁止访问属性 ${property.value}`, property));
        return;
      }
      checkMemberTarget(node.object, String(property.value), node, state);
      return;
    }
    // 局部变量允许动态下标（如 items[i]、lines[index]）；命名空间与内置全局仍要求静态键，
    // 避免 files[key] / JSON[key] 这类动态调用绕过方法白名单。
    const root = rootIdentifier(node.object);
    const local = root
      && lookupName(scope, root)
      && !PTC_NAMESPACE_METHODS[root]
      && !SAFE_GLOBAL_MEMBERS[root]
      && root !== 'ptc';
    if (local) {
      validateNode(property, scope, state);
      return;
    }
    state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', '不允许对内建对象动态取值；局部变量可用下标，files/JSON 等请使用静态键', property || node));
    return;
  }
  const name = node.property?.name || '';
  if (forbiddenProperty(name)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_PROPERTY', `禁止访问属性 ${name || '?'}`, node.property || node));
    return;
  }
  checkMemberTarget(node.object, name, node, state);
}

function checkMemberTarget(object, propertyName, node, state) {
  if (object?.type !== 'Identifier') return;
  const root = object.name;
  if (PTC_NAMESPACE_METHODS[root]) {
    const methods = PTC_NAMESPACE_METHODS[root];
    if (!methods.includes(propertyName)) {
      state.errors.push(diagnostic(2, 'PTC_UNKNOWN_TOOL', `${root} 不支持方法 ${propertyName}；可用：${methods.join('/')}`, node.property || node));
    }
    return;
  }
  if (SAFE_GLOBAL_MEMBERS[root]) {
    if (!SAFE_GLOBAL_MEMBERS[root].has(propertyName)) {
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_MEMBER', `${root}.${propertyName} 不在允许列表中`, node.property || node));
    }
    return;
  }
  if (root === 'ptc' && !['traceId', 'version', 'state'].includes(propertyName)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_MEMBER', `ptc.${propertyName} 不可用`, node.property || node));
  }
}

function validateFunction(node, scope, state) {
  if (node.generator) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', '不支持 generator 函数', node));
    return;
  }
  const fnScope = createScope(scope, 'function');
  if (node.type === 'FunctionDeclaration' && node.id) {
    declareName(fnScope, node.id.name, { kind: 'function' }, node.id, state);
  }
  if (node.type === 'FunctionExpression' && node.id) {
    declareName(fnScope, node.id.name, { kind: 'function' }, node.id, state);
  }
  for (const param of node.params || []) {
    for (const name of patternNames(param)) {
      declareName(fnScope, name, { kind: 'param' }, param, state);
    }
  }
  for (const param of node.params || []) validatePattern(param, fnScope, state);
  const previous = state.inSyncFunction;
  // 顶层代码最终会被包进 async 函数，所以顶层 await 合法；同步函数内部不允许 await。
  state.inSyncFunction = !node.async;
  if (node.body?.type === 'BlockStatement') {
    predeclare(node.body.body, fnScope, state);
    for (const statement of node.body.body) validateNode(statement, fnScope, state);
  } else if (node.body) {
    validateNode(node.body, fnScope, state);
  }
  state.inSyncFunction = previous;
}

function validateAssignment(node, scope, state) {
  const left = node.left;
  if (left?.type === 'Identifier') {
    if (!lookupName(scope, left.name)) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_UNKNOWN', `不能给未声明的变量赋值：${left.name}`, left));
    } else if (PTC_RESERVED_BINDINGS.has(left.name) || left.name.startsWith('__')) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', `不能给保留名称赋值：${left.name}`, left));
    }
  } else if (left?.type === 'MemberExpression') {
    const root = rootIdentifier(left);
    // 允许修改 state 字段和本地对象的静态字段；禁止修改工具命名空间或安全全局。
    if (root !== 'state' && !lookupName(scope, root)) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', '只能给本地变量、本地对象字段或 state 对象的字段赋值', left));
    }
    validateMember(left, scope, state);
  } else {
    state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', '不支持的赋值目标', left || node));
  }
  validateNode(node.right, scope, state);
}

function validateUpdate(node, scope, state) {
  const argument = node.argument;
  if (argument?.type === 'Identifier') {
    if (!lookupName(scope, argument.name)) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_UNKNOWN', `不能修改未声明的变量：${argument.name}`, argument));
    }
    return;
  }
  if (argument?.type === 'MemberExpression') {
    const root = rootIdentifier(argument);
    if (root === 'state' || lookupName(scope, root)) {
      validateMember(argument, scope, state);
      return;
    }
  }
  state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', '自增/自减只能作用于本地变量、本地对象字段或 state 字段', argument || node));
}

function validateLoop(node, scope, state) {
  if (node.type === 'ForStatement') {
    const loopScope = createScope(scope, 'block');
    if (node.init?.type === 'VariableDeclaration') {
      predeclare([node.init], loopScope, state);
      validateNode(node.init, loopScope, state);
    } else if (node.init) {
      validateNode(node.init, scope, state);
    }
    if (node.test) validateNode(node.test, loopScope, state);
    if (node.update) validateNode(node.update, loopScope, state);
    if (!node.test || isConstantTrue(node.test)) {
      if (!hasLoopExit(node.body)) {
        state.errors.push(diagnostic(1, 'PTC_UNBOUNDED_LOOP', '检测到没有退出条件的循环；请使用明确的循环上限或 break', node));
      }
    }
    validateNode(node.body, loopScope, state);
    return;
  }
  if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    if (node.await) {
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', '不支持 for await', node));
    }
    const loopScope = createScope(scope, 'block');
    if (node.left?.type === 'VariableDeclaration') {
      predeclare([node.left], loopScope, state);
      validateNode(node.left, loopScope, state);
    } else {
      validateNode(node.left, scope, state);
    }
    validateNode(node.right, scope, state);
    validateNode(node.body, loopScope, state);
    return;
  }
  if (isConstantTrue(node.test) && !hasLoopExit(node.body)) {
    state.errors.push(diagnostic(1, 'PTC_UNBOUNDED_LOOP', '检测到没有退出条件的循环；请使用明确的循环上限或 break', node));
  }
  if (node.test) validateNode(node.test, scope, state);
  validateNode(node.body, scope, state);
}

function validateNode(node, scope, state) {
  if (!node || typeof node.type !== 'string') return;
  if (state.errors.length >= PTC_MAX_ERRORS) return;
  if (FORBIDDEN_NODE_TYPES.has(node.type)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', FORBIDDEN_NODE_TYPES.get(node.type), node));
    return;
  }
  switch (node.type) {
    case 'Program': {
      predeclare(node.body, scope, state);
      for (const statement of node.body) validateNode(statement, scope, state);
      return;
    }
    case 'BlockStatement': {
      const blockScope = createScope(scope, 'block');
      predeclare(node.body, blockScope, state);
      for (const statement of node.body) validateNode(statement, blockScope, state);
      return;
    }
    case 'VariableDeclaration': {
      for (const declarator of node.declarations || []) {
        validatePattern(declarator.id, scope, state);
        if (declarator.init) validateNode(declarator.init, scope, state);
      }
      return;
    }
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      validateFunction(node, scope, state);
      return;
    case 'Identifier':
      checkIdentifier(node, scope, state);
      return;
    case 'MemberExpression':
      validateMember(node, scope, state);
      return;
    case 'CallExpression': {
      const callee = node.callee;
      if (callee?.type === 'Identifier') {
        if (FORBIDDEN_IDENTIFIERS.has(callee.name) || callee.name.startsWith('__')) {
          state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `禁止调用 ${callee.name}`, callee));
        } else if (UNSAFE_CALLEE_GLOBALS.has(callee.name)) {
          state.errors.push(diagnostic(2, 'PTC_NOT_CALLABLE', `${callee.name} 不是可调用函数`, callee));
        } else if (!lookupName(scope, callee.name) && !SAFE_CALLABLE_GLOBALS.has(callee.name)) {
          state.errors.push(diagnostic(2, 'PTC_UNKNOWN_CALL', `不能调用未知函数：${callee.name}`, callee));
        }
      } else if (callee?.type === 'MemberExpression') {
        validateMember(callee, scope, state);
      } else {
        validateNode(callee, scope, state);
      }
      const apiName = identifyApiCall(callee);
      if (apiName) {
        if (!PTC_TOOL_SPECS[apiName]) {
          state.errors.push(diagnostic(2, 'PTC_UNKNOWN_TOOL', `未知 PTC 工具：${apiName}`, callee));
        } else {
          state.toolCalls.push(apiName);
          checkApiArgs(apiName, node, state);
        }
      }
      for (const argument of node.arguments || []) validateNode(argument, scope, state);
      return;
    }
    case 'NewExpression': {
      const callee = node.callee;
      // 内置构造器（Set/Map/Date 等）在沙箱中可用，放行可避免模型反复踩同一个坑；
      // 被同名局部变量遮蔽时仍按禁止处理，防止绕过限制。
      const allowed = callee?.type === 'Identifier'
        && SAFE_CONSTRUCTORS.has(callee.name)
        && !lookupName(scope, callee.name);
      if (!allowed) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_NEW', '禁止使用 new；只允许 new Set/Map/Date/RegExp/Error 等内置构造器', node));
        return;
      }
      for (const argument of node.arguments || []) validateNode(argument, scope, state);
      return;
    }
    case 'ThisExpression':
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', '禁止使用 this', node));
      return;
    case 'AwaitExpression':
      if (state.inSyncFunction) {
        state.errors.push(diagnostic(2, 'PTC_AWAIT_OUTSIDE_ASYNC', '同步函数内部不能使用 await', node));
      }
      validateNode(node.argument, scope, state);
      return;
    case 'AssignmentExpression':
      validateAssignment(node, scope, state);
      return;
    case 'UpdateExpression':
      validateUpdate(node, scope, state);
      return;
    case 'Literal': {
      if (node.regex) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', '不支持正则字面量', node));
      }
      if (node.bigint !== undefined) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', '不支持 BigInt 字面量', node));
      }
      return;
    }
    case 'TemplateLiteral': {
      for (const expression of node.expressions || []) validateNode(expression, scope, state);
      return;
    }
    case 'ObjectExpression': {
      for (const property of node.properties || []) {
        if (property.type === 'SpreadElement') {
          validateNode(property.argument, scope, state);
          continue;
        }
        if (property.computed) {
          const key = property.key;
          if (key?.type !== 'Literal' || typeof key.value !== 'string') {
            state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', '对象字面量不支持动态键', property));
          }
        }
        validateNode(property.value, scope, state);
      }
      return;
    }
    case 'ArrayExpression': {
      for (const element of node.elements || []) validateNode(element, scope, state);
      return;
    }
    case 'SpreadElement':
      validateNode(node.argument, scope, state);
      return;
    case 'ChainExpression':
      validateNode(node.expression, scope, state);
      return;
    case 'ConditionalExpression':
      validateNode(node.test, scope, state);
      validateNode(node.consequent, scope, state);
      validateNode(node.alternate, scope, state);
      return;
    case 'IfStatement':
      validateNode(node.test, scope, state);
      validateNode(node.consequent, scope, state);
      validateNode(node.alternate, scope, state);
      return;
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      validateLoop(node, scope, state);
      return;
    case 'CatchClause': {
      const catchScope = createScope(scope, 'block');
      if (node.param) {
        for (const name of patternNames(node.param)) {
          declareName(catchScope, name, { kind: 'param' }, node.param, state);
        }
        validatePattern(node.param, catchScope, state);
      }
      validateNode(node.body, catchScope, state);
      return;
    }
    case 'SwitchStatement': {
      validateNode(node.discriminant, scope, state);
      const switchScope = createScope(scope, 'block');
      for (const item of node.cases || []) predeclare(item.consequent, switchScope, state);
      for (const item of node.cases || []) {
        if (item.test) validateNode(item.test, switchScope, state);
        for (const statement of item.consequent || []) validateNode(statement, switchScope, state);
      }
      return;
    }
    case 'BreakStatement':
    case 'ContinueStatement':
      if (node.label) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', '不支持标签跳转', node));
      }
      return;
    default:
      for (const child of childNodes(node)) validateNode(child, scope, state);
  }
}

export function parsePtcSource(code) {
  return parse(String(code || ''), PARSE_OPTIONS);
}

/**
 * 执行前的三层静态校验。
 * @returns {{ok:boolean, errors:Array, metrics:Object, layer:number}}
 */
export function validatePtcCode(code, options = {}) {
  const source = String(code ?? '');
  const errors = [];
  const maxChars = Number(options.maxChars) || PTC_CODE_MAX_CHARS;
  if (!source.trim()) {
    return {
      ok: false,
      errors: [diagnostic(1, 'PTC_EMPTY', 'PTC 代码不能为空')],
      metrics: { nodes: 0, maxDepth: 0, loops: 0, awaits: 0, callSites: 0, functions: 0, chars: 0 },
      layer: 1
    };
  }
  if (source.length > maxChars) {
    return {
      ok: false,
      errors: [diagnostic(1, 'PTC_CODE_TOO_LARGE', `代码长度 ${source.length} 超过上限 ${maxChars} 字符`)],
      metrics: { nodes: 0, maxDepth: 0, loops: 0, awaits: 0, callSites: 0, functions: 0, chars: source.length },
      layer: 1
    };
  }
  let ast;
  try {
    ast = parsePtcSource(source);
  } catch (error) {
    const loc = error?.loc || {};
    return {
      ok: false,
      errors: [{
        layer: 1,
        code: 'PTC_SYNTAX',
        message: `语法错误：${error?.message || '无法解析'}`,
        line: loc.line || 0,
        column: loc.column !== undefined ? loc.column + 1 : 0
      }],
      metrics: { nodes: 0, maxDepth: 0, loops: 0, awaits: 0, callSites: 0, functions: 0, chars: source.length },
      layer: 1
    };
  }

  const metrics = measureAst(ast);
  metrics.chars = source.length;
  metrics.lines = source.split('\n').length;

  if (metrics.lines > PTC_MAX_LINES) {
    errors.push(diagnostic(1, 'PTC_TOO_MANY_LINES', `代码行数 ${metrics.lines} 超过上限 ${PTC_MAX_LINES}`));
  }
  if (metrics.nodes > PTC_MAX_NODES) {
    errors.push(diagnostic(1, 'PTC_AST_TOO_LARGE', `AST 节点数 ${metrics.nodes} 超过上限 ${PTC_MAX_NODES}`));
  }
  if (metrics.maxDepth > PTC_MAX_DEPTH) {
    errors.push(diagnostic(1, 'PTC_AST_TOO_DEEP', `AST 嵌套深度 ${metrics.maxDepth} 超过上限 ${PTC_MAX_DEPTH}`));
  }
  if (metrics.loops > PTC_MAX_LOOPS) {
    errors.push(diagnostic(1, 'PTC_TOO_MANY_LOOPS', `循环数量 ${metrics.loops} 超过上限 ${PTC_MAX_LOOPS}`));
  }
  if (metrics.callSites > PTC_MAX_SITE_CALLS) {
    errors.push(diagnostic(3, 'PTC_TOO_MANY_CALLS', `调用点数量 ${metrics.callSites} 超过上限 ${PTC_MAX_SITE_CALLS}`));
  }
  if (errors.length) {
    return { ok: false, errors: errors.slice(0, PTC_MAX_ERRORS), metrics, layer: errors[0].layer };
  }

  const state = {
    errors,
    toolCalls: [],
    inSyncFunction: false
  };
  const globalScope = createScope(null, 'program');
  // I-PTC：同一任务此前执行留下的顶层变量/函数在本次代码里可以直接引用。
  for (const name of options.allowedBindings || []) {
    if (typeof name !== 'string' || !name || globalScope.names.has(name)) continue;
    globalScope.names.set(name, { kind: 'persisted' });
  }
  validateNode(ast, globalScope, state);

  if (state.toolCalls.length > PTC_MAX_CALLS) {
    state.errors.push(diagnostic(
      3,
      'PTC_TOOL_BUDGET',
      `工具调用 ${state.toolCalls.length} 次超过单次执行上限 ${PTC_MAX_CALLS}；请合并循环或拆分任务`
    ));
  }
  metrics.toolCalls = state.toolCalls.length;
  metrics.toolNames = [...new Set(state.toolCalls)];

  const ok = state.errors.length === 0;
  return {
    ok,
    errors: state.errors.slice(0, PTC_MAX_ERRORS),
    metrics,
    layer: ok ? 0 : state.errors[0].layer,
    ast
  };
}
