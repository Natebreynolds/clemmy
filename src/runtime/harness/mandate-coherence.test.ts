/**
 * Stage 2 pins: no guardrail may mandate a tool the turn cannot follow.
 *
 * Live failure class (Aug 2026): the fan-out refusal mandated run_tool_program
 * while the discovery governor refused its schema (the model brute-forced
 * parameter names — {"code":..}, {}, {"script":"return 1;"}); the nudge
 * recommended run_worker where it returned "unknown tool". A mandate is now a
 * value constructible only from proof (callable-surface oracle), with the
 * legacy env heuristic preserved verbatim until each lane registers its
 * schema projection (transition arm, retired by the per-lane wiring pin).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'mandate-coherence-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const {
  _clearLocalSchemaProviderForTests,
  registerLocalSchemaProvider,
} = await import('./callable-surface.js');
const { buildFanoutRecoveryMessage, mandateFor } = await import('./tool-guardrail.js');

test.beforeEach(() => {
  _clearLocalSchemaProviderForTests();
  delete process.env.CLEMMY_CODE_MODE;
});

test('PHANTOM-MANDATE pin: oracle wired, tool absent → the refusal names NO tool', () => {
  registerLocalSchemaProvider(() => new Map([
    // A registered surface that does NOT contain run_tool_program — the exact
    // shape of the live incident (code-mode env said yes, environment said no).
    ['some_other_tool', { type: 'object', required: [], properties: {} }],
  ]));
  const mandate = mandateFor('run_tool_program');
  assert.equal(mandate, null, 'a registered oracle without the tool must refuse the mandate');

  const message = buildFanoutRecoveryMessage({
    toolName: 'composio_execute_tool',
    slug: 'SLACK_FIND_USER_BY_EMAIL_ADDRESS',
    args: { arguments: { email: 'x@scorpion.co' } },
    distinct: 7,
    fanoutBlockAt: 6,
    mandate: null,
  });
  assert.doesNotMatch(message, /run_tool_program|run_worker/, 'no phantom prescriptions');
  assert.match(message, /REFUSED/, 'the behavioral constraint survives');
  assert.match(message, /ONE batched call|tell the user/i, 'a viable next action is still named');
});

test('oracle-proven mandate renders the contract inline — the refusal contains the answer', () => {
  registerLocalSchemaProvider(() => new Map([
    ['run_tool_program', { type: 'object', required: ['program'], properties: { program: { type: 'string' } } }],
  ]));
  const mandate = mandateFor('run_tool_program');
  assert.ok(mandate && mandate.source === 'oracle');
  assert.deepEqual(mandate.requiredFields, ['program']);

  const message = buildFanoutRecoveryMessage({
    toolName: 'composio_execute_tool',
    slug: 'SLACK_FIND_USER_BY_EMAIL_ADDRESS',
    args: { arguments: { email: 'x@scorpion.co' } },
    distinct: 7,
    fanoutBlockAt: 6,
    mandate,
  });
  assert.match(message, /run_tool_program/);
  assert.match(message, /required: program/, 'schema rides the refusal so zero discovery is needed to comply');
});

test('TRANSITION pin: unwired oracle preserves the exact legacy availability semantics', () => {
  // No provider registered — pre-wiring lanes.
  assert.ok(mandateFor('run_tool_program'), 'code mode defaults on → legacy mandate stands');
  assert.equal(mandateFor('run_tool_program')?.source, 'legacy_env');
  assert.ok(mandateFor('run_worker'), 'the nudge tool keeps its historical (unchecked) availability');

  process.env.CLEMMY_CODE_MODE = 'off';
  assert.equal(mandateFor('run_tool_program'), null, 'the 2026-07-12 strand-hunt property: code mode off → no refusal-with-phantom');
});

test('unknown names are never mandatable, wired or not', () => {
  assert.equal(mandateFor('definitely_not_a_tool'), null);
  registerLocalSchemaProvider(() => new Map());
  assert.equal(mandateFor('definitely_not_a_tool'), null);
});

test('CONNECTION pin: the env-flag proxy is gone; consumption sites ride mandateFor', () => {
  const guardrailSource = readFileSync(path.join(HERE, 'tool-guardrail.ts'), 'utf8');
  assert.doesNotMatch(
    guardrailSource,
    /function codeModeRecoveryAvailable/,
    'the inlined env-flag reachability proxy must stay deleted',
  );
  assert.match(guardrailSource, /const fanoutMandate = mandateFor\('run_tool_program'\)/, 'the block consumes a mandate');
  assert.match(guardrailSource, /const workerMandate = mandateFor\('run_worker'\)/, 'the nudge consumes a mandate');
  const turnControlSource = readFileSync(path.join(HERE, 'turn-control.ts'), 'utf8');
  assert.doesNotMatch(
    turnControlSource,
    /fan out with run_worker, or batch the reads with run_tool_program\)/,
    'turn-control must not hardcode prescribed tool names',
  );
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
