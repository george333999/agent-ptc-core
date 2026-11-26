import { parse } from 'acorn';
import {
  PTC_NAMESPACE_METHODS,
  PTC_RESERVED_BINDINGS,
  PTC_TOOL_SPECS
} from './specs.js';

// PTC three-layer AST validation:
// Layer 1: syntax and structure (parse failure, size, depth, loop/call counts, constant-true loops)
// Layer 2: capabilities and safety (forbidden identifiers, prototype chain, dynamic members, dangerous syntax, scope references)
// Layer 3: data flow and resources (narrow tool methods, argument keys/types, path escape, call budget)
// Validation runs before sandbox execution, so obviously invalid or dangerous scripts never reach the worker.

export const PTC_CODE_MAX_CHARS = 40000;
export const PTC_MAX_NODES = 5000;
export const PTC_MAX_DEPTH = 48;
export const PTC_MAX_LINES = 1200;
export const PTC_MAX_CALLS = 100;
export const PTC_MAX_LOOPS = 50;
export const PTC_MAX_SITE_CALLS = 120;
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
  ['ClassDeclaration', 'class is not supported'],
  ['ClassExpression', 'class is not supported'],
  ['WithStatement', 'with is not supported'],
  ['LabeledStatement', 'labeled statements are not supported'],
  ['DebuggerStatement', 'debugger is not supported'],
  ['ImportDeclaration', 'import is not supported'],
  ['ExportNamedDeclaration', 'export is not supported'],
  ['ExportDefaultDeclaration', 'export is not supported'],
  ['ExportAllDeclaration', 'export is not supported'],
  ['ImportExpression', 'dynamic import is not supported'],
  ['MetaProperty', 'import.meta / new.target is not supported'],
  ['TaggedTemplateExpression', 'tagged templates are not supported'],
  ['YieldExpression', 'generator is not supported']
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

// Only standard built-in constructors without host capabilities are allowed; new on custom functions or host objects remains forbidden.
const SAFE_CONSTRUCTORS = new Set([
  'Set', 'Map', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'Array', 'Object', 'Promise'
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
    state.errors.push(diagnostic(2, 'PTC_RESERVED_NAME', `Cannot redeclare reserved name: ${name}`, node));
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
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `Cannot access internal name: ${name}`, node));
    return;
  }
  if (FORBIDDEN_IDENTIFIERS.has(name)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `Access to ${name} is forbidden`, node));
    return;
  }
  if (lookupName(scope, name)) return;
  if (SAFE_GLOBALS.has(name)) return;
  state.errors.push(diagnostic(2, 'PTC_UNKNOWN_IDENTIFIER', `Unknown identifier: ${name} (only declared variables or APIs provided by PTC are allowed)`, node));
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
          state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', 'Dynamic property names are not supported in destructuring', property));
        }
        validatePattern(property.value, scope, state);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements || []) validatePattern(element, scope, state);
      break;
    default:
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', `Unsupported destructuring target: ${pattern.type}`, pattern));
      break;
  }
}

function checkApiArgumentValue(spec, value, node, state, key) {
  if (!spec) return;
  if (value.type === 'Literal') {
    if (spec.type === 'string' && typeof value.value !== 'string') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} must be a string`, value));
      return;
    }
    if (spec.type === 'integer' && !Number.isInteger(value.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} must be an integer`, value));
      return;
    }
    if (spec.type === 'boolean' && typeof value.value !== 'boolean') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} must be a boolean`, value));
      return;
    }
    if (spec.type === 'enum' && !spec.values.includes(value.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} must be one of ${spec.values.join(' / ')}`, value));
      return;
    }
    if (spec.path && typeof value.value === 'string') {
      const raw = value.value.trim();
      const segments = raw.replace(/\\/g, '/').split('/');
      const absolute = /^(?:[A-Za-z]:\/|\/|~\/)/.test(raw) || /^[A-Za-z]:\\/.test(value.value);
      if (absolute || segments.includes('..')) {
        state.errors.push(diagnostic(3, 'PTC_PATH_ESCAPE', `Path must stay inside the workspace; absolute paths and .. are not allowed: ${raw.slice(0, 120)}`, value));
      }
    }
  } else if (value.type === 'UnaryExpression' && value.operator === '-' && value.argument?.type === 'Literal') {
    if (spec.type === 'integer' && !Number.isInteger(-value.argument.value)) {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${key} must be an integer`, value));
    }
  }
}

function checkApiArgs(apiName, node, state) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (!spec) return;
  if (node.arguments.length > 1) {
    state.errors.push(diagnostic(3, 'PTC_TOO_MANY_ARGS', `${apiName} accepts only a single options object argument`, node));
    return;
  }
  if (!node.arguments.length) return;
  const arg = node.arguments[0];
  if (arg.type === 'Identifier' && arg.name === 'undefined') return;
  if (arg.type === 'SpreadElement') {
    state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${apiName} does not support spread arguments`, arg));
    return;
  }
  if (arg.type !== 'ObjectExpression') return;
  for (const property of arg.properties || []) {
    if (property.type === 'SpreadElement') {
      state.errors.push(diagnostic(3, 'PTC_ARG_TYPE', `${apiName} options object does not support spread`, property));
      continue;
    }
    let key = '';
    if (!property.computed && property.key?.type === 'Identifier') key = property.key.name;
    else if (property.key?.type === 'Literal' && typeof property.key.value === 'string') key = property.key.value;
    if (!key) {
      state.errors.push(diagnostic(3, 'PTC_UNKNOWN_ARG', `${apiName} argument names must be static identifiers`, property));
      continue;
    }
    if (!spec.args[key]) {
      state.errors.push(diagnostic(3, 'PTC_UNKNOWN_ARG', `${apiName} does not support argument ${key}`, property));
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
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_PROPERTY', `Access to property ${property.value} is forbidden`, property));
        return;
      }
      checkMemberTarget(node.object, String(property.value), node, state);
      return;
    }
    // Local variables may use dynamic indexes (e.g., items[i], lines[index]); namespaces and built-in globals still require static keys,
    // so dynamic calls such as files[key] / JSON[key] cannot bypass the method allowlist.
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
    state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', 'Dynamic access on built-in objects is not allowed; local variables may use indexes, but use static keys for files/JSON and similar objects', property || node));
    return;
  }
  const name = node.property?.name || '';
  if (forbiddenProperty(name)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_PROPERTY', `Access to property ${name || '?'} is forbidden`, node.property || node));
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
      state.errors.push(diagnostic(2, 'PTC_UNKNOWN_TOOL', `${root} does not support method ${propertyName}; available: ${methods.join('/')}`, node.property || node));
    }
    return;
  }
  if (SAFE_GLOBAL_MEMBERS[root]) {
    if (!SAFE_GLOBAL_MEMBERS[root].has(propertyName)) {
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_MEMBER', `${root}.${propertyName} is not in the allowlist`, node.property || node));
    }
    return;
  }
  if (root === 'ptc' && !['traceId', 'version', 'state'].includes(propertyName)) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_MEMBER', `ptc.${propertyName} is not available`, node.property || node));
  }
}

function validateFunction(node, scope, state) {
  if (node.generator) {
    state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', 'Generator functions are not supported', node));
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
  // Top-level code is eventually wrapped in an async function, so top-level await is valid; await is not allowed inside a sync function.
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
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_UNKNOWN', `Cannot assign to undeclared variable: ${left.name}`, left));
    } else if (PTC_RESERVED_BINDINGS.has(left.name) || left.name.startsWith('__')) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', `Cannot assign to reserved name: ${left.name}`, left));
    }
  } else if (left?.type === 'MemberExpression') {
    const root = rootIdentifier(left);
    // Allow modifying state fields and static fields of local objects; modifying tool namespaces or safe globals is forbidden.
    if (root !== 'state' && !lookupName(scope, root)) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', 'Only local variables, local object fields, or fields of the state object may be assigned', left));
    }
    validateMember(left, scope, state);
  } else {
    state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', 'Unsupported assignment target', left || node));
  }
  validateNode(node.right, scope, state);
}

function validateUpdate(node, scope, state) {
  const argument = node.argument;
  if (argument?.type === 'Identifier') {
    if (!lookupName(scope, argument.name)) {
      state.errors.push(diagnostic(2, 'PTC_ASSIGN_UNKNOWN', `Cannot modify undeclared variable: ${argument.name}`, argument));
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
  state.errors.push(diagnostic(2, 'PTC_ASSIGN_TARGET', 'Increment/decrement may only target local variables, local object fields, or state fields', argument || node));
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
        state.errors.push(diagnostic(1, 'PTC_UNBOUNDED_LOOP', 'Loop without an exit condition detected; use an explicit loop bound or break', node));
      }
    }
    validateNode(node.body, loopScope, state);
    return;
  }
  if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    if (node.await) {
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', 'for await is not supported', node));
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
    state.errors.push(diagnostic(1, 'PTC_UNBOUNDED_LOOP', 'Loop without an exit condition detected; use an explicit loop bound or break', node));
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
          state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', `Calling ${callee.name} is forbidden`, callee));
        } else if (UNSAFE_CALLEE_GLOBALS.has(callee.name)) {
          state.errors.push(diagnostic(2, 'PTC_NOT_CALLABLE', `${callee.name} is not a callable function`, callee));
        } else if (!lookupName(scope, callee.name) && !SAFE_CALLABLE_GLOBALS.has(callee.name)) {
          state.errors.push(diagnostic(2, 'PTC_UNKNOWN_CALL', `Cannot call unknown function: ${callee.name}`, callee));
        }
      } else if (callee?.type === 'MemberExpression') {
        validateMember(callee, scope, state);
      } else {
        validateNode(callee, scope, state);
      }
      const apiName = identifyApiCall(callee);
      if (apiName) {
        if (!PTC_TOOL_SPECS[apiName]) {
          state.errors.push(diagnostic(2, 'PTC_UNKNOWN_TOOL', `Unknown PTC tool: ${apiName}`, callee));
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
      // Built-in constructors (Set/Map/Date, etc.) are available in the sandbox, so allowing them avoids the model repeatedly hitting the same pitfall;
      // when shadowed by a same-name local variable they are still treated as forbidden, preventing bypass of the restriction.
      const allowed = callee?.type === 'Identifier'
        && SAFE_CONSTRUCTORS.has(callee.name)
        && !lookupName(scope, callee.name);
      if (!allowed) {
        const attempted = callee?.type === 'Identifier'
          ? callee.name
          : (callee?.type === 'MemberExpression'
            ? `${callee.object?.name || '?'}.${callee.property?.name || '?'}`
            : 'this expression');
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_NEW', `new ${attempted} is forbidden; only built-in constructors such as new Set/Map/Date/RegExp/Error/Array/Object/Promise are allowed`, node));
        return;
      }
      for (const argument of node.arguments || []) validateNode(argument, scope, state);
      return;
    }
    case 'ThisExpression':
      state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_IDENTIFIER', 'this is not allowed', node));
      return;
    case 'AwaitExpression':
      if (state.inSyncFunction) {
        state.errors.push(diagnostic(2, 'PTC_AWAIT_OUTSIDE_ASYNC', 'await is not allowed inside a sync function', node));
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
      // Regex literals are just data and are safe inside the sandbox (catastrophic backtracking is bounded by the 8s wall-clock timeout).
      if (node.bigint !== undefined) {
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', 'BigInt literals are not supported', node));
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
            state.errors.push(diagnostic(2, 'PTC_DYNAMIC_MEMBER', 'Object literals do not support dynamic keys', property));
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
        state.errors.push(diagnostic(2, 'PTC_FORBIDDEN_SYNTAX', 'Labeled jumps are not supported', node));
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
 * Three-layer static validation before execution.
 * @returns {{ok:boolean, errors:Array, metrics:Object, layer:number}}
 */
export function validatePtcCode(code, options = {}) {
  const source = String(code ?? '');
  const errors = [];
  const maxChars = Number(options.maxChars) || PTC_CODE_MAX_CHARS;
  if (!source.trim()) {
    return {
      ok: false,
      errors: [diagnostic(1, 'PTC_EMPTY', 'PTC code must not be empty')],
      metrics: { nodes: 0, maxDepth: 0, loops: 0, awaits: 0, callSites: 0, functions: 0, chars: 0 },
      layer: 1
    };
  }
  if (source.length > maxChars) {
    return {
      ok: false,
      errors: [diagnostic(1, 'PTC_CODE_TOO_LARGE', `Code length ${source.length} exceeds the limit of ${maxChars} characters`)],
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
        message: `Syntax error: ${error?.message || 'unable to parse'}`,
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
    errors.push(diagnostic(1, 'PTC_TOO_MANY_LINES', `Line count ${metrics.lines} exceeds the limit of ${PTC_MAX_LINES}`));
  }
  if (metrics.nodes > PTC_MAX_NODES) {
    errors.push(diagnostic(1, 'PTC_AST_TOO_LARGE', `AST node count ${metrics.nodes} exceeds the limit of ${PTC_MAX_NODES}`));
  }
  if (metrics.maxDepth > PTC_MAX_DEPTH) {
    errors.push(diagnostic(1, 'PTC_AST_TOO_DEEP', `AST nesting depth ${metrics.maxDepth} exceeds the limit of ${PTC_MAX_DEPTH}`));
  }
  if (metrics.loops > PTC_MAX_LOOPS) {
    errors.push(diagnostic(1, 'PTC_TOO_MANY_LOOPS', `Loop count ${metrics.loops} exceeds the limit of ${PTC_MAX_LOOPS}`));
  }
  if (metrics.callSites > PTC_MAX_SITE_CALLS) {
    errors.push(diagnostic(3, 'PTC_TOO_MANY_CALLS', `Call site count ${metrics.callSites} exceeds the limit of ${PTC_MAX_SITE_CALLS}`));
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
  // I-PTC: top-level variables/functions left by a previous execution of the same task can be referenced directly in this code.
  for (const name of options.allowedBindings || []) {
    if (typeof name !== 'string' || !name || globalScope.names.has(name)) continue;
    globalScope.names.set(name, { kind: 'persisted' });
  }
  validateNode(ast, globalScope, state);

  if (state.toolCalls.length > PTC_MAX_CALLS) {
    state.errors.push(diagnostic(
      3,
      'PTC_TOOL_BUDGET',
      `Tool calls ${state.toolCalls.length} exceed the single-run limit of ${PTC_MAX_CALLS}; merge loops or split the task`
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
