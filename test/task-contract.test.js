import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_ITEM_MAX,
  CONTRACT_LIST_MAX,
  SOCRATIC_QUESTIONS,
  buildSocraticBrief,
  contractForOrchestration,
  normalizeContract,
  renderAssumptions,
  renderDefinitionOfDone,
  shouldUseSocraticBrief
} from '../server/task-contract.js';

test('Self-check questions are complete with stable text and no volatile content such as time', () => {
  assert.equal(SOCRATIC_QUESTIONS.length, 5);
  const first = buildSocraticBrief();
  const second = buildSocraticBrief();
  assert.equal(first, second);
  for (const question of SOCRATIC_QUESTIONS) {
    assert.ok(first.includes(question), `Missing question: ${question}`);
  }
  assert.match(first, /do not call extra tools for the self-check/);
  assert.match(first, /definitionOfDone/);
  assert.ok(first.length < 1200, `Self-check block should stay compact; actual ${first.length} characters`);
});

test('Self-check is enabled only for complex Agent tasks; Chat, simple tasks, and explicit opt-out stay disabled', () => {
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: true }), true);
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: false }), false);
  assert.equal(shouldUseSocraticBrief({ mode: 'chat', complexTask: true }), false);
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: true, settings: { socraticBrief: false } }), false);
});

test('Contract normalization: drops empties, deduplicates, and clips item length and count', () => {
  const contract = normalizeContract({
    definitionOfDone: ['  a  b  ', '', 'A B', 'x'.repeat(CONTRACT_ITEM_MAX + 50), null],
    assumptions: 'single-string'
  });
  assert.equal(contract.definitionOfDone.length, 2);
  assert.equal(contract.definitionOfDone[0], 'a b');
  assert.equal(contract.definitionOfDone[1], 'x'.repeat(CONTRACT_ITEM_MAX));
  assert.deepEqual(contract.assumptions, ['single-string']);
});

test('Contract boundaries: empty input, non-arrays, and excess items never throw', () => {
  assert.deepEqual(normalizeContract(), { definitionOfDone: [], assumptions: [] });
  assert.deepEqual(normalizeContract({ definitionOfDone: 42, assumptions: null }), {
    definitionOfDone: ['42'],
    assumptions: []
  });
  const many = Array.from({ length: 20 }, (_, index) => `item-${index}`);
  const contract = normalizeContract({ definitionOfDone: many, assumptions: many });
  assert.equal(contract.definitionOfDone.length, CONTRACT_LIST_MAX);
  assert.equal(contract.assumptions.length, CONTRACT_LIST_MAX);
});

test('Orchestration contract: deterministic fallback when completion criteria are missing, existing criteria preserved', () => {
  const derived = contractForOrchestration({});
  assert.equal(derived.definitionOfDone.length, 1);
  assert.match(derived.definitionOfDone[0], /expectedOutput/);
  const explicit = contractForOrchestration({ definitionOfDone: ['The artifact file exists and passes validation'] });
  assert.deepEqual(explicit.definitionOfDone, ['The artifact file exists and passes validation']);
});

test('Worker sections: completion criteria and assumptions are clipped to budget; empty content produces no empty section', () => {
  assert.equal(renderDefinitionOfDone([]), '');
  assert.equal(renderAssumptions(undefined), '');
  const done = renderDefinitionOfDone(['condition one', 'condition two'], { maxChars: 400 });
  assert.match(done, /^# Definition of Done/);
  assert.match(done, /condition one/);
  const clipped = renderDefinitionOfDone(
    Array.from({ length: 6 }, (_, index) => `criterion ${index} ${'a very long description '.repeat(20)}`),
    { maxChars: 120 }
  );
  assert.ok(clipped.length <= 120);
  assert.ok(clipped.endsWith('…'));
  const assumptions = renderAssumptions(['assumption A'], { maxChars: 100 });
  assert.match(assumptions, /^# Key Assumptions/);
});
