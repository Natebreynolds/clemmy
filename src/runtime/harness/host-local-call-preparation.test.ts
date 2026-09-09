import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-local-preparation-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const log = await import('./eventlog.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const local = await import('./local-planning-capability.js');
const preparation = await import('./host-local-call-preparation.js');
after(() => { local._setConfiguredLocalPlanningToolObserverForTests(null); log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

async function fixture() {
  const session = log.createSession({ kind: 'chat', userId: 'local-preparation-owner' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the local draft.', taskMode: { version: 1, kind: 'normal' } } });
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1 });
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  const observed = await local.observeCurrentLocalPlanningDefinition({ name: 'write_file', carrier: 'work_call' });
  assert.ok(observed.ok);
  if (!observed.ok) throw new Error(observed.reason);
  const call = { sessionId: session.id, sourceUserSeq: source.seq, operationId: 'write_file',
    capabilityRef: observed.definition.capabilityRef,
    args: { path: path.join(home, 'draft.txt'), content: 'Draft', mode: 'create', append: null } };
  return { agent: {}, planning: primed.planning, call };
}

test('preparation publishes the current configured definition without approving or dispatching a call', async () => {
  const f = await fixture();
  preparation.bindHostLocalCallPreparation(f.agent, { planning: f.planning, configuredNames: new Set(['write_file']) });
  assert.equal(local.nominateDisclosedLocalPlanningDefinition({ ...f.call, effect: 'local_write' }), null);
  assert.equal(await preparation.prepareHostLocalCall(f.agent, f.call), true);
  assert.ok(local.nominateDisclosedLocalPlanningDefinition({ ...f.call, effect: 'local_write' }));
  log.closeEventLog();
  assert.ok((await local.loadDurableAuthorizedLocalPlanningDefinition(f.call)).ok, 'fresh definition survives reopen');
  for (const table of ['physical_dispatches', 'logical_call_settlements', 'pending_approvals', 'host_call_capability_bindings']) {
    assert.equal((log.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
      .get(f.call.sessionId) as { n: number }).n, 0, `${table}: publication is not execution authority`);
  }
});

test('preparation requires an exact agent, source, configured name and matching argument variant', async () => {
  const f = await fixture();
  preparation.bindHostLocalCallPreparation(f.agent, { planning: f.planning, configuredNames: new Set(['write_file', 'composio:UNTRUSTED']) });
  assert.equal(await preparation.prepareHostLocalCall({}, f.call), false);
  for (const call of [
    { ...f.call, sessionId: 'another-session' },
    { ...f.call, sourceUserSeq: f.call.sourceUserSeq + 1 },
    { ...f.call, operationId: 'workflow_delete' },
    { ...f.call, operationId: 'composio:UNTRUSTED' },
    { ...f.call, capabilityRef: 'cap:local:invented:create' },
    { ...f.call, args: { ...f.call.args, mode: 'overwrite' } },
  ]) assert.equal(await preparation.prepareHostLocalCall(f.agent, call), false, JSON.stringify(call));
  assert.equal(log.listEvents(f.call.sessionId, { types: ['capability_discovered'] }).length, 0);
});

test('denied and removed tools stay unavailable; a forged planning context cannot disclose', async () => {
  const f = await fixture();
  preparation.bindHostLocalCallPreparation(f.agent, { planning: f.planning,
    configuredNames: new Set(['write_file']), deniedNames: new Set(['write_file']) });
  assert.equal(await preparation.prepareHostLocalCall(f.agent, f.call), false);
  preparation.bindHostLocalCallPreparation(f.agent, { planning: { ...f.planning, authority: { ...f.planning.authority } },
    configuredNames: new Set(['write_file']) });
  assert.equal(await preparation.prepareHostLocalCall(f.agent, f.call), false);
  preparation.bindHostLocalCallPreparation(f.agent, { planning: f.planning, configuredNames: new Set(['write_file']) });
  local._setConfiguredLocalPlanningToolObserverForTests(() => null);
  try { assert.equal(await preparation.prepareHostLocalCall(f.agent, f.call), false); }
  finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
  assert.equal(log.listEvents(f.call.sessionId, { types: ['capability_discovered'] }).length, 0);
});

test('the real orchestrator binds its own reachable native surface and keeps exclusions', async () => {
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  for (const excluded of [false, true]) {
    const f = await fixture();
    const agent = await buildOrchestratorAgent({ sessionId: f.call.sessionId, sourceUserSeq: f.call.sourceUserSeq,
      userInput: 'Create the local draft.', acceptedRoute: 'act', allowToolJit: true,
      hostFreshPlanning: f.planning, ...(excluded ? { excludeToolNames: ['write_file'] } : {}) });
    assert.equal(await preparation.prepareHostLocalCall(agent, f.call), !excluded);
  }
});

test('a frozen graph cannot acquire another native capability through call preparation', async () => {
  const f = await fixture();
  preparation.bindHostLocalCallPreparation(f.agent, { planning: f.planning, configuredNames: new Set(['write_file']) });
  log.appendTurnGraphEventOnce({ sessionId: f.call.sessionId, sourceUserSeq: f.call.sourceUserSeq,
    turn: 1, data: { version: 1, sourceUserSeq: f.call.sourceUserSeq } });
  assert.equal(await preparation.prepareHostLocalCall(f.agent, f.call), false);
  assert.equal(log.listEvents(f.call.sessionId, { types: ['capability_discovered'] }).length, 0);
});
