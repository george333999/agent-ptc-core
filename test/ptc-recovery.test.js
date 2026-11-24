import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePtcCode } from '../server/ptc/ast-validator.js';
import {
  MAX_PTC_VALIDATION_FAILURES,
  MAX_PTC_VALIDATION_NUDGES,
  PTC_FALLBACK_NUDGE,
  isPtcValidationFailure,
  ptcFallbackAction,
  ptcValidationAction,
  ptcValidationFinal,
  ptcValidationHint,
  ptcValidationNudge
} from '../server/ptc/validation.js';

test('PTC 静态校验失败可自动纠错 2 次，第 3 次停止', () => {
  const failure = {
    status: 'completed',
    result: [
      '【PTC 静态校验未通过】第 2 层 · tr_x',
      '- 第 4 行 [PTC_FORBIDDEN_IDENTIFIER] 禁止调用 eval',
      '',
      '可用只读 API：files.list、files.read、files.search'
    ].join('\n')
  };
  assert.equal(isPtcValidationFailure(failure), true);
  assert.equal(isPtcValidationFailure({ result: '【PTC 执行失败】PTC_TOOL_BUDGET' }), false);
  assert.equal(isPtcValidationFailure({ result: 'PTC 执行完成' }), false);
  assert.equal(isPtcValidationFailure(null), false);

  assert.equal(MAX_PTC_VALIDATION_NUDGES, 2);
  assert.equal(ptcValidationAction({ failed: false, nudges: 0 }), 'none');
  assert.equal(ptcValidationAction({ failed: true, nudges: 0 }), 'continue');
  assert.equal(ptcValidationAction({ failed: true, nudges: MAX_PTC_VALIDATION_NUDGES - 1 }), 'continue');
  assert.equal(ptcValidationAction({ failed: true, nudges: MAX_PTC_VALIDATION_NUDGES }), 'stop');
  assert.equal(ptcValidationAction({ failed: true, nudges: MAX_PTC_VALIDATION_NUDGES + 1 }), 'stop');
  assert.equal(ptcValidationAction({ failed: true, nudges: 0, max: 0 }), 'stop');
  assert.equal(ptcValidationAction({ failed: true, nudges: 0, max: -1 }), 'stop');
  assert.equal(ptcValidationAction({ failed: true, nudges: 1, max: '2' }), 'continue');
  assert.equal(ptcValidationAction({ failed: true, nudges: 2, max: '2' }), 'stop');
  assert.equal(ptcValidationAction({}), 'none');

  const nudge = ptcValidationNudge(failure.result);
  assert.match(nudge, /第 4 行/);
  assert.match(nudge, /eval/);
  assert.match(nudge, /Function/);
  assert.match(nudge, /不要原样重试/);
  assert.match(nudge, /files\.readMany/);

  const final = ptcValidationFinal(failure.result);
  assert.match(final, /连续 3 次未通过静态校验/);
  assert.match(final, /第 4 行/);
  assert.match(final, /自动降级/);
  assert.match(final, /read_file\/search_files/);

  assert.equal(MAX_PTC_VALIDATION_FAILURES, 3);
  assert.equal(ptcFallbackAction({ failures: 0 }), 'continue');
  assert.equal(ptcFallbackAction({ failures: 2 }), 'continue');
  assert.equal(ptcFallbackAction({ failures: 3 }), 'fallback');
  assert.equal(ptcFallbackAction({ failures: 4 }), 'fallback');
  assert.equal(ptcFallbackAction({ failures: 99, active: true }), 'active');
  assert.equal(ptcFallbackAction({ failures: 3, max: 5 }), 'continue');
  assert.equal(ptcFallbackAction({ failures: 5, max: 5 }), 'fallback');
  assert.match(PTC_FALLBACK_NUDGE, /read_file/);
  assert.match(PTC_FALLBACK_NUDGE, /eval/);

  const longResult = `【PTC 静态校验未通过】\n- 第 9 行 ${'x'.repeat(1000)}`;
  assert.ok(ptcValidationNudge(longResult).length < 700);
});

test('PTC 局部变量允许动态下标，内置对象仍要求静态键', () => {
  const localIndex = [
    'const lines = ["a", "b"];',
    'let out = "";',
    'for (let i = 0; i < lines.length; i++) { out += lines[i]; }',
    'return { out };'
  ].join('\n');
  assert.equal(validatePtcCode(localIndex).ok, true);

  const localNested = [
    'const items = [{ amount: 1 }, { amount: 2 }];',
    'let sum = 0;',
    'for (const item of items) { sum += item.amount; }',
    'return { sum };'
  ].join('\n');
  assert.equal(validatePtcCode(localNested).ok, true);

  const dynamicNamespace = [
    'const key = "read";',
    'const r = await files[key]({ path: "a.js" });',
    'return { r };'
  ].join('\n');
  const namespaceResult = validatePtcCode(dynamicNamespace);
  assert.equal(namespaceResult.ok, false);
  assert.ok(namespaceResult.errors.some((item) => item.code === 'PTC_DYNAMIC_MEMBER'));

  const dynamicBuiltin = 'const key = "stringify";\nreturn { s: JSON[key]({}) };';
  assert.equal(validatePtcCode(dynamicBuiltin).ok, false);
});

test('PTC 纠错提示按错误码给出可执行的改法', () => {
  const dynamic = '【PTC 静态校验未通过】\n- 第 15 行 [PTC_DYNAMIC_MEMBER] 不允许对内建对象动态取值';
  assert.match(ptcValidationHint(dynamic), /items\[i\]/);
  assert.match(ptcValidationNudge(dynamic), /items\[i\]/);

  const forbiddenNew = '【PTC 静态校验未通过】\n- 第 3 行 [PTC_FORBIDDEN_NEW] 禁止使用 new';
  assert.match(ptcValidationHint(forbiddenNew), /new Set/);
  assert.match(ptcValidationNudge(forbiddenNew), /new Map/);

  const unknown = '【PTC 静态校验未通过】\n- 第 2 行 [PTC_UNKNOWN_IDENTIFIER] 未知标识符';
  assert.match(ptcValidationHint(unknown), /files/);

  const pathError = '【PTC 静态校验未通过】\n- 第 5 行 [PTC_PATH] 路径越界';
  assert.match(ptcValidationHint(pathError), /相对路径/);

  assert.equal(ptcValidationHint('【PTC 静态校验未通过】\n- 第 1 行 [PTC_SYNTAX] 语法错误'), '');
});
