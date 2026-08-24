/**
 * Stage 2 pins: no guardrail may mandate a tool the turn cannot follow.
 *
 * Live failure class (Aug 2026): the fan-out refusal mandated a batching tool
 * while the discovery governor refused its schema (the model brute-forced
 * parameter names); the nudge recommended run_worker where it returned
 * "unknown tool". A mandate is a value constructible only from proof
 * (callable-surface oracle), with run_worker keeping its proven env-derived
 * availability. The fan-out BLOCK's recovery no longer needs a mandate at all:
 * since the run_tool_program surface was subtracted (2026-08-20), the
 * prescribed recovery is the model's own PARALLEL tool calls — a door that
 * exists on every lane, so it can never be a phantom.
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
});

test('PHANTOM-MANDATE pin: a projectable name absent from the registered surface mandates nothing', () => {
  registerLocalSchemaProvider(() => new Map([
    ['some_other_tool', { type: 'object', required: [], properties: {} }],
  ]));
  // The projectable class (local runtime tools): absent from the registered
  // surface → no mandate, no phantom.
  assert.equal(mandateFor('memory_search'), null, 'a registered oracle without the tool must refuse the mandate');
  // The subtracted program surface must never be mandatable again.
  assert.equal(mandateFor('run_tool_program'), null, 'the subtracted program door mandates nothing');
});

test('the fan-out refusal prescribes only the always-available doors', () => {
  const message = buildFanoutRecoveryMessage({
    toolName: 'composio_execute_tool',
    slug: 'SLACK_FIND_USER_BY_EMAIL_ADDRESS',
    args: { arguments: { email: 'x@scorpion.co' } },
    distinct: 7,
    fanoutBlockAt: 6,
    mandate: null,
  });
  assert.match(message, /REFUSED/, 'the behavioral constraint survives');
  assert.match(message, /PARALLEL tool calls/, 'the recovery is the model\'s own parallel calls — never a phantom');
  assert.doesNotMatch(message, /run_tool_program/, 'no steer may reference the subtracted door');
  assert.match(message, /tell the user/i, 'the check-in escape hatch is still named');
});

test('STRUCTURAL pin: run_worker keeps env-derived availability, wired or not', () => {
  // Registration state is irrelevant for the structural arm — run_worker is a
  // per-agent closure the projection can never contain.
  assert.ok(mandateFor('run_worker'), 'the nudge tool keeps its historical (unchecked) availability');
});

test('unknown names are never mandatable, wired or not', () => {
  assert.equal(mandateFor('definitely_not_a_tool'), null);
  registerLocalSchemaProvider(() => new Map());
  assert.equal(mandateFor('definitely_not_a_tool'), null);
});

test('CONNECTION pin: consumption sites prescribe only live doors', () => {
  const guardrailSource = readFileSync(path.join(HERE, 'tool-guardrail.ts'), 'utf8');
  assert.doesNotMatch(
    guardrailSource,
    /function codeModeRecoveryAvailable/,
    'the inlined env-flag reachability proxy must stay deleted',
  );
  assert.doesNotMatch(
    guardrailSource,
    /mandateFor\('run_tool_program'\)/,
    'the block must not consult the subtracted door',
  );
  assert.match(guardrailSource, /const workerMandate = mandateFor\('run_worker'\)/, 'the nudge consumes a mandate');
  const turnControlSource = readFileSync(path.join(HERE, 'turn-control.ts'), 'utf8');
  assert.doesNotMatch(
    turnControlSource,
    /batch the reads with run_tool_program/,
    'turn-control must not prescribe the subtracted tool',
  );
  assert.match(
    turnControlSource,
    /PARALLEL tool calls in one response/,
    'turn-control names the always-available recovery',
  );
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
