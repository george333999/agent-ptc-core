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

test('PTC static validation failures auto-correct twice and stop on the third', () => {
  const failure = {
    status: 'completed',
    result: [
      '[PTC static validation failed] layer 2 · tr_x',
      '- Line 4 [PTC_FORBIDDEN_IDENTIFIER] Calling eval is forbidden',
      '',
      'Available read-only APIs: files.list, files.read, files.search'
    ].join('\n')
  };
  assert.equal(isPtcValidationFailure(failure), true);
  assert.equal(isPtcValidationFailure({ result: '[PTC execution failed]PTC_TOOL_BUDGET' }), false);
  assert.equal(isPtcValidationFailure({ result: 'PTC execution complete' }), false);
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
  assert.match(nudge, /Line 4/);
  assert.match(nudge, /eval/);
  assert.match(nudge, /Function/);
  assert.match(nudge, /Do not repeat unchanged/);
  assert.match(nudge, /files\.readMany/);

  const final = ptcValidationFinal(failure.result);
  assert.match(final, /failed static validation 3 times in a row/);
  assert.match(final, /Line 4/);
  assert.match(final, /automatic fallback/);
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

  const longResult = `[PTC static validation failed]\n- Line 9 ${'x'.repeat(1000)}`;
  assert.ok(ptcValidationNudge(longResult).length < 700);
});

test('PTC local variables allow dynamic indexes while built-in objects still require static keys', () => {
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

test('PTC correction hints give actionable fixes by error code', () => {
  const dynamic = '[PTC static validation failed]\n- Line 15 [PTC_DYNAMIC_MEMBER] Dynamic access on built-in objects is not allowed';
  assert.match(ptcValidationHint(dynamic), /items\[i\]/);
  assert.match(ptcValidationNudge(dynamic), /items\[i\]/);

  const forbiddenNew = '[PTC static validation failed]\n- Line 3 [PTC_FORBIDDEN_NEW] new is forbidden';
  assert.match(ptcValidationHint(forbiddenNew), /new Set/);
  assert.match(ptcValidationNudge(forbiddenNew), /new Map/);

  const unknown = '[PTC static validation failed]\n- Line 2 [PTC_UNKNOWN_IDENTIFIER] Unknown identifier';
  assert.match(ptcValidationHint(unknown), /files/);

  const pathError = '[PTC static validation failed]\n- Line 5 [PTC_PATH] path escape';
  assert.match(ptcValidationHint(pathError), /relative paths/);

  assert.equal(ptcValidationHint('[PTC static validation failed]\n- Line 1 [PTC_SYNTAX] Syntax error'), '');
});
