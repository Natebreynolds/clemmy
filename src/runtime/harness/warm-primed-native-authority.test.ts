/**
 * BEHAVIOUR proof for warm-primed native execution authority.
 *
 * Replaces the earlier source-text assertions, which the reviewer correctly
 * rejected: they matched strings in the indexed catalog rather than checking
 * whether a primed native operation is actually CALLABLE.
 *
 * The contract under test is the seam between two files. Priming stages indexed
 * local definitions for the warm planning card, but the direct `work_call` path
 * resolves execution authority from THIS source's durable `capability_discovered`
 * row (readDurableAuthorizedLocalPlanningDefinition). While priming only staged
 * in memory, the card advertised a native operation the model could not call, so
 * the turn detoured into plan_task — and that plan cannot open a graph resolution
 * over the chat turn's already-armed non-graph host authority, so an ordinary
 * reversible edit dead-ended. Live C12 source 135730 blocked exactly that way
 * ("graph resolution cannot replace non-graph call authority") while the same
 * edit succeeded cold at 135997.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/warm-primed-native-authority.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-warm-primed-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-warm-primed\n', 'utf8');

const local = await import('./local-planning-capability.js');
const indexed = await import('./indexed-capability-catalog.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const eventlog = await import('./eventlog.js');

after(() => {
  indexed._setVerifiedWriteResolverForTests(null);
  local._setConfiguredLocalPlanningToolObserverForTests(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

const OPERATION = 'workflow_update';

/** A warm turn: the objective names an operation a prior turn already learned. */
function acceptWarmSource(text: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'warm primed native authority' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** Present `definition` to the indexed catalog as an already-learned local write. */
function installLearnedWrite(definition: unknown): void {
  indexed._setVerifiedWriteResolverForTests(async () => [{
    record: {
      version: 1,
      capabilityRef: (definition as { capabilityRef: string }).capabilityRef,
      bindingKind: 'local_envelope',
      identifier: OPERATION,
    },
    hostBinding: { capabilityId: (definition as { capabilityRef: string }).capabilityRef },
    currentLocalDefinition: definition,
  }] as never);
}

/** The durable authority rows priming actually published for this source. */
function publishedRows(
  identity: { sessionId: string; sourceUserSeq: number },
  capabilityRef: string,
): Array<Record<string, unknown>> {
  return eventlog
    .listEvents(identity.sessionId, { types: ['capability_discovered'] })
    .filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq)
    .flatMap((event) => (Array.isArray(event.data.capabilities) ? event.data.capabilities : []))
    .filter((row: { capabilityRef?: string }) => row.capabilityRef === capabilityRef);
}

async function observeCurrent(): Promise<{ capabilityRef: string } & Record<string, unknown>> {
  const observed = await local.observeCurrentLocalPlanningDefinition({
    name: OPERATION,
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) throw new Error('unreachable');
  return observed.definition as never;
}

test('a warm-primed native operation is DIRECTLY CALLABLE with no same-source discovery', async () => {
  const definition = await observeCurrent();
  installLearnedWrite(definition);
  const identity = acceptWarmSource(`Change the description of my workflow via ${OPERATION}.`);

  // Before priming there is no authority for this source — the operation is not
  // yet callable, which is what makes the assertion after priming meaningful.
  const before = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...identity,
    capabilityRef: definition.capabilityRef,
  });
  assert.equal(before.ok, false, 'a source with no priming must hold no execution authority');

  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);

  // THE BEHAVIOUR: priming alone — no tool_search, no plan_task — must leave the
  // operation resolvable by the direct call path.
  const after = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...identity,
    capabilityRef: definition.capabilityRef,
  });
  assert.equal(after.ok, true, `warm priming must publish callable authority: ${JSON.stringify(after)}`);
  if (!after.ok) throw new Error('unreachable');
  assert.equal(after.definition.capabilityRef, definition.capabilityRef);
  assert.equal(after.definition.name, OPERATION);
});

test('the published authority is THIS pass reobserved, not the indexed bytes', async () => {
  const definition = await observeCurrent();
  // Hand the catalog a stale historical row whose schema no longer matches the
  // configured tool. Priming must publish the CURRENT observation or nothing —
  // never the stale shape.
  installLearnedWrite({ ...definition, schemaFingerprint: 'stale-fingerprint-0000' });
  const identity = acceptWarmSource(`Use ${OPERATION} on my workflow.`);
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);

  // Assert on what priming PUBLISHED, not on the loader's post-revalidation
  // view — otherwise the check passes vacuously whenever nothing resolves.
  // THE NEGATIVE CASE: reobservation rejects the stale row outright, so NOTHING
  // is published and the operation is simply not offered. The failure mode this
  // forbids is publishing the stale shape as though it were current authority.
  const rows = publishedRows(identity, definition.capabilityRef);
  assert.equal(rows.length, 0, 'a definition that fails reobservation must publish no authority');
  for (const row of rows) {
    assert.notEqual(row.schemaFingerprint, 'stale-fingerprint-0000');
    assert.equal(row.schemaFingerprint, definition.schemaFingerprint);
  }

  // And it must not become callable by the direct path either.
  const resolved = await local.loadDurableAuthorizedLocalPlanningDefinition({
    ...identity,
    capabilityRef: definition.capabilityRef,
  });
  assert.equal(resolved.ok, false, 'a stale definition must never become execution permission');
});

test('a drifted configured tool is NOT offered as callable authority', async () => {
  const definition = await observeCurrent();
  installLearnedWrite(definition);
  // The configured tool changes shape between learning and this turn.
  local._setConfiguredLocalPlanningToolObserverForTests((name: string) => ({
    name,
    parameters: {
      type: 'object',
      properties: { drift_probe_only: { type: 'string' } },
      required: ['drift_probe_only'],
      additionalProperties: false,
    },
  }));
  const identity = acceptWarmSource(`Change my workflow with ${OPERATION}.`);
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);

  // A drifted tool must not be handed out as callable authority carrying the
  // pre-drift shape. Reobservation either drops it or republishes the new shape.
  const rows = publishedRows(identity, definition.capabilityRef);
  for (const row of rows) {
    assert.notEqual(
      row.schemaFingerprint,
      definition.schemaFingerprint,
      'a drifted tool must never be published under its pre-drift schema',
    );
  }
  local._setConfiguredLocalPlanningToolObserverForTests(null);
});

test('priming twice publishes ONE authority row — duplicate prevention holds', async () => {
  const definition = await observeCurrent();
  installLearnedWrite(definition);
  const identity = acceptWarmSource(`Please run ${OPERATION} for me.`);

  await semantic.primePrimaryModelPlanningCatalog(identity);
  await semantic.primePrimaryModelPlanningCatalog(identity);

  const rows = eventlog
    .listEvents(identity.sessionId, { types: ['capability_discovered'] })
    .filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq)
    .flatMap((event) => (Array.isArray(event.data.capabilities) ? event.data.capabilities : []))
    .filter((row: { capabilityRef?: string }) => row.capabilityRef === definition.capabilityRef);

  assert.equal(rows.length, 1, `re-priming must not republish authority: ${rows.length} rows`);
});

// ─── Remembered operations are candidate HINTS — the seed matrix ─────────────
//
// Reviewer (C14 ruling): "Destination-posture coverage can still omit
// workflow_update for an edit-step-only or create+edit-step seed, and an
// update-only seed can nominate workflow_run." Both were reproduced, and both
// came from keying on posture coverage. The family is `deliverableKind` +
// `purpose`: author_workflow covers create/update/edit_step, while
// dispatch_named_workflow (run) and delete_workflow are different jobs.

async function publishedForSeed(seedNames: readonly string[], objective = 'Change the description of my existing workflow.'): Promise<string[]> {
  const defs = [];
  for (const name of seedNames) {
    const observed = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(observed.ok, true, `cannot observe seed ${name}`);
    if (!observed.ok) throw new Error('unreachable');
    defs.push({ name, definition: observed.definition });
  }
  indexed._setVerifiedWriteResolverForTests(async () => defs.map((entry) => ({
    record: {
      version: 1,
      capabilityRef: entry.definition.capabilityRef,
      bindingKind: 'local_envelope',
      identifier: entry.name,
    },
    hostBinding: { capabilityId: entry.definition.capabilityRef },
    currentLocalDefinition: entry.definition,
  })) as never);
  const identity = acceptWarmSource(objective);
  // Priming MUST succeed. An earlier revision of this helper tolerated failure
  // and merely surfaced the reason, which let a real production defect pass as a
  // fixture limitation: a Space seed published its definitions and then failed
  // initial priming, blocking the loop before its first model call. Publication
  // alone does not qualify this behaviour.
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : `priming must succeed: ${primed.reason}`);
  return eventlog
    .listEvents(identity.sessionId, { types: ['capability_discovered'] })
    .filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq)
    .flatMap((event) => (Array.isArray(event.data.capabilities) ? event.data.capabilities : []))
    .map((row: { identifier?: string }) => String(row.identifier));
}

for (const seed of [['workflow_create'], ['workflow_edit_step'], ['workflow_create', 'workflow_edit_step'], ['workflow_update']]) {
  test(`SEED [${seed.join(',')}] offers the whole authoring family and nothing that fires or destroys`, async () => {
    const published = await publishedForSeed(seed);
    for (const expected of ['workflow_create', 'workflow_update', 'workflow_edit_step']) {
      assert.ok(published.includes(expected), `${expected} must be offered: ${published.join(',')}`);
    }
    // workflow_run DISPATCHES a workflow. An edit request must never have it
    // nominated — the owner's rule is that workflows fire only when asked.
    assert.ok(!published.includes('workflow_run'), `run must never be nominated: ${published.join(',')}`);
    assert.ok(!published.includes('workflow_delete'), `delete must never be nominated: ${published.join(',')}`);
  });
}

test('SEED [space_save] offers only the author_workspace family', async () => {
  const published = await publishedForSeed(['space_save'], 'Update the HTML view of my existing Space.');
  assert.ok(published.includes('space_save'));
  assert.ok(published.includes('space_edit_view'), `the sibling editor must be offered: ${published.join(',')}`);
  // Different purposes are different jobs, even in the same deliverable family.
  assert.ok(!published.includes('space_set_data'), `update_workspace_dataset is a different purpose: ${published.join(',')}`);
  assert.ok(!published.includes('space_edit_runner'), `author_workspace_runner is a different purpose: ${published.join(',')}`);
});

// ─── Space descriptor round trip (C15 ruling: confirmed production defect) ────
//
// `destinationPostures` represents space_save's real upsert. But
// exactPlanningDescriptorSnapshot did a CLOSED key-set equality, so the extra
// key disqualified the whole descriptor, and replayedPlanningDescriptor dropped
// the field entirely. A Space seed therefore published its definitions and then
// failed initial priming; close/reopen with no index help failed again, blocking
// the production loop before its first model call.

test('a Space seed primes successfully and survives reopen with the upsert intact', async () => {
  const observed = await local.observeCurrentLocalPlanningDefinition({
    name: 'space_save', carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) throw new Error('unreachable');
  assert.deepEqual(
    [...(observed.definition.descriptor.destinationPostures ?? [])],
    ['create_new', 'named_existing'],
    'space_save must declare the upsert it documents',
  );
  installLearnedWrite(observed.definition);
  const identity = acceptWarmSource('Update the HTML view of my existing Space.');

  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : `Space priming must succeed: ${primed.reason}`);
  if (!primed.ok) throw new Error('unreachable');
  const firstCard = primed.planning.capabilities.map((entry) => entry.id);
  assert.ok(firstCard.length > 0, 'the model must be given a usable card, not an empty one');
  assert.ok(
    firstCard.includes('cap:local:space_save:reversible'),
    `the seeded Space operation must be model-visible: ${firstCard.join(',')}`,
  );

  // REOPEN with no index help — the exact close/reopen path that failed.
  indexed._setVerifiedWriteResolverForTests(async () => []);
  const reopened = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(reopened.ok, true, reopened.ok ? '' : `reopen must succeed: ${reopened.reason}`);
  if (!reopened.ok) throw new Error('unreachable');

  const reopenedCard = reopened.planning.capabilities;
  assert.deepEqual(
    reopenedCard.map((entry) => entry.id), firstCard,
    'reopen must be lossless — the same exact capability identities',
  );
  const save = reopenedCard.find((entry) => entry.id === 'cap:local:space_save:reversible');
  assert.deepEqual(
    [...(save?.destinationPostures ?? [])],
    ['create_new', 'named_existing'],
    'the upsert fact must survive the saved-card round trip',
  );
  assert.equal(
    save?.manifestDigest, observed.definition.descriptor.manifestDigest,
    'the exact descriptor digest must be preserved across reopen',
  );
});

test('a descriptor WITHOUT the optional key still round-trips (older cards)', async () => {
  const observed = await local.observeCurrentLocalPlanningDefinition({
    name: 'workflow_create', carrier: 'work_call',
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) throw new Error('unreachable');
  assert.equal(
    observed.definition.descriptor.destinationPostures, undefined,
    'workflow_create is not an upsert; the key must stay absent',
  );
  installLearnedWrite(observed.definition);
  const identity = acceptWarmSource('Change the description of my existing workflow.');
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  indexed._setVerifiedWriteResolverForTests(async () => []);
  const reopened = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(reopened.ok, true, reopened.ok ? '' : `older-shape reopen must succeed: ${reopened.reason}`);
});
