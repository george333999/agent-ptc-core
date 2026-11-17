import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_CODE_MAX_CHARS,
  PTC_MAX_CALLS,
  validatePtcCode
} from '../src/ptc/ast-validator.js';

function rejects(code, expectedCode, options = {}) {
  const result = validatePtcCode(code, options);
  assert.equal(result.ok, false, `应当拒绝：${code}`);
  const codes = result.errors.map((item) => item.code);
  assert.ok(codes.includes(expectedCode), `期望 ${expectedCode}，实际 ${codes.join(',')}`);
  return result;
}

test('PTC 校验：合法编排代码通过并统计调用', () => {
  const code = `
    // 批量读取并过滤
    const listing = await files.list({ path: '.', depth: 2 });
    const fileEntries = listing.entries.filter((entry) => entry.type === 'file');
    const result = [];
    for (const entry of fileEntries) {
      if (entry.path.endsWith('.js')) {
        const content = await files.read({ path: entry.path });
        result.push({ path: entry.path, lines: content.totalLines });
      }
    }
    state.lastScan = result.length;
    log('scanned', result.length);
    return result;
  `;
  const result = validatePtcCode(code);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.loops, 1);
});

test('PTC 校验：第 1 层拒绝语法错误、超大代码和无退出循环', () => {
  rejects('const = 1', 'PTC_SYNTAX');
  rejects(`return '${'x'.repeat(PTC_CODE_MAX_CHARS)}';`, 'PTC_CODE_TOO_LARGE');
  rejects('while (true) { await files.list({}); } return 1;', 'PTC_UNBOUNDED_LOOP');
  rejects('for (;;) { await files.list({}); }', 'PTC_UNBOUNDED_LOOP');
  // 有 break 的循环合法
  assert.equal(validatePtcCode('for (;;) { break; } return 1;').ok, true);
});

test('PTC 校验：第 2 层拒绝危险标识符与危险语法', () => {
  rejects('return process.env.HOME;', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('return globalThis;', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('return require("fs");', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('return eval("1+1");', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('const f = new Function("return 1"); return f();', 'PTC_FORBIDDEN_NEW');
  rejects('class A {} return 1;', 'PTC_FORBIDDEN_SYNTAX');
  rejects('return this;', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('return arguments;', 'PTC_FORBIDDEN_IDENTIFIER');
  rejects('return /abc/;', 'PTC_FORBIDDEN_SYNTAX');
});

test('PTC 校验：原型链与动态属性访问被拒绝', () => {
  rejects('return ({}).constructor;', 'PTC_FORBIDDEN_PROPERTY');
  rejects('return ({})["constructor"];', 'PTC_FORBIDDEN_PROPERTY');
  rejects('return ({}).__proto__;', 'PTC_FORBIDDEN_PROPERTY');
  rejects('const o = { a: 1 }; const k = "a"; return o[k];', 'PTC_DYNAMIC_MEMBER');
  rejects('return Math["constructor"];', 'PTC_FORBIDDEN_PROPERTY');
  rejects('return JSON.parse.constructor;', 'PTC_FORBIDDEN_PROPERTY');
  rejects('const o = { a: 1 }; const k = "a"; o[k] = 2; return o;', 'PTC_DYNAMIC_MEMBER');
});

test('PTC 校验：作用域与赋值目标受限', () => {
  rejects('return foo + 1;', 'PTC_UNKNOWN_IDENTIFIER');
  rejects('files.list = 1; return 1;', 'PTC_ASSIGN_TARGET');
  rejects('state = {}; return 1;', 'PTC_ASSIGN_UNKNOWN');
  rejects('const files = 1; return files;', 'PTC_RESERVED_NAME');
  rejects('let __secret = 1; return __secret;', 'PTC_RESERVED_NAME');
  rejects('x = 1; return x;', 'PTC_ASSIGN_UNKNOWN');
  // 合法：本地变量赋值和 state 字段赋值
  assert.equal(validatePtcCode('let x = 1; x += 1; state.count = x; return x;').ok, true);
  // 合法：本地对象/数组的静态字段修改
  assert.equal(validatePtcCode('const arr = [1]; arr[0] = 2; arr[0] += 1; return arr;').ok, true);
  rejects('const arr = [1]; const k = 0; arr[k] = 2; return arr;', 'PTC_DYNAMIC_MEMBER');
});

test('PTC 校验：第 3 层拒绝未知工具、未知参数与路径穿越', () => {
  rejects('return files.delete({ path: "a.txt" });', 'PTC_UNKNOWN_TOOL');
  rejects('return files.list({ bogus: 1 });', 'PTC_UNKNOWN_ARG');
  rejects('return files.read({ path: "../secret.txt" });', 'PTC_PATH_ESCAPE');
  rejects('return files.read({ path: "C:\\\\Windows\\\\win.ini" });', 'PTC_PATH_ESCAPE');
  rejects('return files.read({ path: "/etc/passwd" });', 'PTC_PATH_ESCAPE');
  rejects('return files.list({ depth: "two" });', 'PTC_ARG_TYPE');
  rejects('return files.search({ query: "x", target: "everything" });', 'PTC_ARG_TYPE');
});

test('PTC 校验：调用预算和 I-PTC 持久名称', () => {
  const many = `${Array.from({ length: PTC_MAX_CALLS + 1 }, () => 'await files.list({ path: "." });').join('\n')}\nreturn 1;`;
  rejects(many, 'PTC_TOOL_BUDGET');

  // 上一次执行留下的函数/变量允许直接引用
  const reused = validatePtcCode('return inc(2);', { allowedBindings: ['inc'] });
  assert.equal(reused.ok, true, JSON.stringify(reused.errors));
  const missing = validatePtcCode('return inc(2);');
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, 'PTC_UNKNOWN_CALL');
});

test('PTC 校验：受支持的常用语法', () => {
  const cases = [
    'const [a, b] = await Promise.all([files.read({ path: "a.txt" }), files.read({ path: "b.txt" })]); return [a.content, b.content];',
    'log("x", { a: 1 }); console.log("y"); return JSON.stringify({ ok: true });',
    'const m = Math.max(1, 2); const keys = Object.keys({ a: 1 }); return { m, keys };',
    'const rows = await files.search({ query: "TODO" }); return rows.matches.filter((row) => row.line > 2);',
    'const result = await files.read({ path: "a.txt" }); return result?.content ?? "";',
    'try { await files.read({ path: "a.txt" }); } catch (error) { return { code: error.code }; }'
  ];
  for (const code of cases) {
    const result = validatePtcCode(code);
    assert.equal(result.ok, true, `${code} => ${JSON.stringify(result.errors)}`);
  }
});

test('PTC 校验：AST 深度与节点数量边界', () => {
  const deep = `return ${'['.repeat(60)}1${']'.repeat(60)};`;
  const deepResult = validatePtcCode(deep);
  assert.equal(deepResult.ok, false);
  assert.ok(deepResult.errors.some((item) => item.code === 'PTC_AST_TOO_DEEP'));

  const many = `${Array.from({ length: 1200 }, (_, index) => `const v${index} = ${index};`).join('\n')}\nreturn 1;`;
  const manyResult = validatePtcCode(many);
  assert.equal(manyResult.ok, false);
  assert.ok(manyResult.errors.some((item) => item.code === 'PTC_AST_TOO_LARGE' || item.code === 'PTC_TOO_MANY_LINES'));
});

test('PTC 校验：更多路径穿越与参数边界', () => {
  for (const path of ['..\\\\secret.txt', './../../secret.txt', '/etc/passwd', '~/secret', 'C:/Windows/win.ini']) {
    rejects(`return files.read({ path: ${JSON.stringify(path)} });`, 'PTC_PATH_ESCAPE');
  }
  assert.equal(validatePtcCode('return files.list({ path: ".", depth: 0 });').ok, true);
  assert.equal(validatePtcCode('return files.list({ path: ".", depth: 5 });').ok, true);
  assert.equal(validatePtcCode('return files.read({ path: "a.txt", startLine: 0 });').ok, true);
  assert.equal(validatePtcCode('return files.search({ query: "x", caseSensitive: true });').ok, true);
  rejects('return files.search({ query: 123 });', 'PTC_ARG_TYPE');
  rejects('return files.list({ depth: 1.5 });', 'PTC_ARG_TYPE');
  rejects('return files.list({ path: undefined, extra: true });', 'PTC_UNKNOWN_ARG');
});
