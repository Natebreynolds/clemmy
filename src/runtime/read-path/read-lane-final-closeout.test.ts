/**
 * Run: npx tsx --test src/runtime/read-path/read-lane-final-closeout.test.ts
 *
 * E0 red suite — read-lane authority/procedure/terminal findings 20-30 from
 * the final North-Star audit, pinned at REQUIRED behavior. Red at ac9ae24c.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-final-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const { sealReadLaneEnvelope, acquireLaneBinding, intersectWithMcpScope } = await import('./read-envelope.js');
const { runColdToWarmRead } = await import('./read-lane.js');
const { promoteFromVerifiedReceipt, resolveActiveProcedure, logicalKeyDigest } = await import('../../memory/procedure-receipts.js');
const { sealBudgetContract, createBudgetMeter } = await import('../budget-contract.js');
const { createSpanRecorder } = await import('../trace-envelope.js');
type ReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;
type ReadLanePorts = import('./read-lane.js').ReadLanePorts;
type ReadLaneEnvelope = import('./read-envelope.js').ReadLaneEnvelope;

const HERE = path.dirname(new URL(import.meta.url).pathname);

const IDENTIFIER = 'PROVIDERX_LIST_ITEMS';
const SCOPE_A = { tenant: 'tenant-A', workspace: 'ws-A', accountIdentity: 'a@example.com' };
const SCOPE_B = { tenant: 'tenant-B', workspace: 'ws-B', accountIdentity: 'b@example.com' };

function laneFor(over: Partial<Parameters<typeof sealReadLaneEnvelope>[0]['identity']> = {}): ReadLaneEnvelope {
  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: SCOPE_A.tenant, workspace: SCOPE_A.workspace,
      acceptedTurnId: 'turn-1', activationId: 'act-1',
      accountIdentity: SCOPE_A.accountIdentity,
      policyHash: 'policy-1', budgetVersion: 'v1', ...over,
    },
    capabilities: [{
      name: IDENTIFIER, schemaFingerprint: 'fp-live', effectClass: 'read',
      accountIdentity: SCOPE_A.accountIdentity,
    }],
    activeCapabilityNames: [IDENTIFIER],
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 10, maxToolCalls: 10, maxElapsedMs: 60_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  return (sealed as Extract<typeof sealed, { ok: true }>).lane;
}

function meter() {
  const sealed = sealBudgetContract({
    uncachedInputTokens: 100_000, outputTokens: 10_000, modelCalls: 5, toolCalls: 5,
    discoveryCalls: 2, validationRepairs: 0, retries: 1, artifactBytes: 1_000_000,
    artifactCount: 10, expansions: 0, effects: 0, elapsedMs: 60_000, concurrency: 1,
  });
  assert.equal(sealed.ok, true);
  return createBudgetMeter((sealed as Extract<typeof sealed, { ok: true }>).contract);
}

let receiptSeq = 0;
function mintReceipt(records: Map<string, ReceiptRecord>, over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  const record: ReceiptRecord = {
    receiptId: `rcpt_${(receiptSeq += 1)}`,
    at: '2026-08-04T00:00:00.000Z',
    provider: 'providerx', operation: 'list_items', effectClass: 'read',
    identifier: IDENTIFIER, schemaFingerprint: 'fp-live',
    scope: { ...SCOPE_A }, dispatchOutcome: 'succeeded', readEvidenceRef: 'ev-1',
    ...over,
  };
  records.set(record.receiptId, record);
  return record;
}

function portsWith(over: Partial<ReadLanePorts> & { records?: Map<string, ReceiptRecord> } = {}): ReadLanePorts {
  const records = over.records ?? new Map<string, ReceiptRecord>();
  return {
    async resolveIntent() {
      return { kind: 'read', provider: 'providerx', operation: 'list_items', slotValues: {} };
    },
    liveSchemaFingerprint: () => 'fp-live',
    accountConnected: () => true,
    async discover() {
      return { identifier: IDENTIFIER, schemaFingerprint: 'fp-live', templateArgs: { fixed: 'yes' }, kind: 'composio' };
    },
    async dispatch() {
      const record = mintReceipt(records);
      return { receiptId: record.receiptId };
    },
    receipts: { resolve: (id) => records.get(id) },
    async compose() { return 'Done.'; },
    ...over,
  };
}

async function run(ports: ReadLanePorts, over: { lane?: ReadLaneEnvelope; scope?: typeof SCOPE_A } = {}) {
  return runColdToWarmRead({
    lane: over.lane ?? laneFor(),
    input: 'list the items',
    scope: over.scope ?? { ...SCOPE_A },
    budget: meter(),
    spans: createSpanRecorder(() => 0),
    ports,
  });
}

// ─── Finding 20: a warm read must verify WHAT the receipt proves ─────────────

test('F20: a warm dispatch whose receipt proves a SEND on another provider refuses before compose — counters cannot claim zero effects', async () => {
  // Promote a legitimate read procedure first.
  const records = new Map<string, ReceiptRecord>();
  const good = mintReceipt(records);
  const promoted = await promoteFromVerifiedReceipt({
    scope: { ...SCOPE_A }, provider: 'providerx', operation: 'list_items', effectClass: 'read',
    kind: 'composio', identifier: IDENTIFIER, templateArgs: { fixed: 'yes' }, receiptId: good.receiptId,
  }, { resolve: (id) => records.get(id) });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));

  // The warm dispatch returns a receipt that is actually a SEND from a
  // different provider and tenant.
  const evil = mintReceipt(records, {
    provider: 'mailco', operation: 'send_mail', effectClass: 'send',
    identifier: 'MAILCO_SEND', scope: { ...SCOPE_B },
    readEvidenceRef: 'ev-evil',
  });
  const result = await run(portsWith({
    records,
    async dispatch() { return { receiptId: evil.receiptId }; },
  }));
  assert.notEqual(result.outcome, 'terminal',
    `a send receipt from another provider/tenant composed as a warm read: ${JSON.stringify(result)}`);
});

// ─── Finding 21: lane and scope must be one sealed authority ─────────────────

test('F21: a lane sealed for tenant A cannot run with an independent scope B or promote into B', async () => {
  const records = new Map<string, ReceiptRecord>();
  const result = await run(portsWith({
    records,
    async resolveIntent() {
      return { kind: 'read', provider: 'providerx', operation: 'scope_leak', slotValues: {} };
    },
    async discover() {
      return { identifier: IDENTIFIER, schemaFingerprint: 'fp-live', templateArgs: { fixed: 'yes' }, kind: 'composio' };
    },
    async dispatch() {
      // A real dispatch adapter stamps the caller's scope on the receipt.
      const record = mintReceipt(records, { operation: 'scope_leak', scope: { ...SCOPE_B } });
      return { receiptId: record.receiptId };
    },
  }), { lane: laneFor(), scope: { ...SCOPE_B } });
  assert.notEqual(result.outcome, 'terminal',
    'a lane sealed for tenant A dispatched and promoted under scope B — lane and scope must be one sealed contract');
  const bArtifact = resolveActiveProcedure({
    scope: { ...SCOPE_B }, provider: 'providerx', operation: 'scope_leak', effectClass: 'read',
  });
  assert.equal(bArtifact.outcome, 'miss', 'scope B received a promoted artifact from lane A\'s run');
});

// ─── Finding 22: unknown live schema is never warm permission ────────────────

test('F22: an undefined live schema fingerprint refuses warm dispatch — it may reacquire cold, never dispatch blind', async () => {
  const records = new Map<string, ReceiptRecord>();
  const good = mintReceipt(records);
  await promoteFromVerifiedReceipt({
    scope: { ...SCOPE_A }, provider: 'providerx', operation: 'list_items', effectClass: 'read',
    kind: 'composio', identifier: IDENTIFIER, templateArgs: { fixed: 'yes' }, receiptId: good.receiptId,
  }, { resolve: (id) => records.get(id) });

  let dispatchedWarm = 0;
  const result = await run(portsWith({
    records,
    liveSchemaFingerprint: () => undefined, // the catalog cannot vouch
    async dispatch() { dispatchedWarm += 1; const r = mintReceipt(records); return { receiptId: r.receiptId }; },
    async discover() {
      // Cold reacquisition is the lawful route and MAY dispatch once after it.
      return { identifier: IDENTIFIER, schemaFingerprint: 'fp-live', templateArgs: { fixed: 'yes' }, kind: 'composio' };
    },
  }));
  const warmWithoutSchema = result.outcome === 'terminal'
    && (result as Extract<typeof result, { outcome: 'terminal' }>).warm === true;
  assert.equal(warmWithoutSchema, false,
    `an unknown live schema was treated as warm-dispatch permission (dispatches=${dispatchedWarm})`);
});

// ─── Finding 23: promotion schema must match the acquisition schema ──────────

test('F23: a cold acquisition under schema A cannot promote from a receipt proving schema B', async () => {
  const records = new Map<string, ReceiptRecord>();
  const driftedReceipt = mintReceipt(records, { operation: 'drift_case', schemaFingerprint: 'fp-B' });
  const result = await run(portsWith({
    records,
    async resolveIntent() {
      return { kind: 'read', provider: 'providerx', operation: 'drift_case', slotValues: {} };
    },
    async discover() {
      return { identifier: IDENTIFIER, schemaFingerprint: 'fp-A', templateArgs: { fixed: 'yes' }, kind: 'composio' };
    },
    async dispatch() { return { receiptId: driftedReceipt.receiptId }; },
  }));
  // Either the run refuses, or at minimum NOTHING may be promoted under a
  // schema the acquisition never proved.
  const active = resolveActiveProcedure({
    scope: { ...SCOPE_A }, provider: 'providerx', operation: 'drift_case', effectClass: 'read',
    slotValues: {},
  });
  const promotedUnderDrift = active.outcome === 'bound' && active.artifact.schemaFingerprint === 'fp-B';
  assert.equal(promotedUnderDrift && result.outcome === 'terminal', false,
    'cold discovery under schema A promoted a procedure proven only under schema B');
});

// ─── Finding 24: concurrent binding acquisitions must converge ───────────────

test('F24: two acquisitions from one revision converge on BOTH bindings — neither is lost', () => {
  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: 't', workspace: 'w', acceptedTurnId: 'turn', activationId: 'act',
      accountIdentity: 'a@example.com', policyHash: 'p', budgetVersion: 'v1',
    },
    capabilities: [
      { name: 'CAP_ONE', schemaFingerprint: 'fp', effectClass: 'read', accountIdentity: 'a@example.com' },
      { name: 'CAP_TWO', schemaFingerprint: 'fp', effectClass: 'read', accountIdentity: 'a@example.com' },
      { name: 'CAP_THREE', schemaFingerprint: 'fp', effectClass: 'read', accountIdentity: 'a@example.com' },
    ],
    activeCapabilityNames: ['CAP_ONE'],
    budget: { maxUncachedTokens: 1, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 1 },
  });
  assert.equal(sealed.ok, true);
  const lane = (sealed as Extract<typeof sealed, { ok: true }>).lane;
  // The audited defect: both callers hold revision 1; each mints revision 2
  // independently and one binding is silently lost. The REQUIRED contract:
  // acquisition goes through a revision store with CAS so the second caller
  // retries from the winner and BOTH capabilities are bound.
  const first = acquireLaneBinding(lane, 'CAP_TWO');
  const second = acquireLaneBinding(lane, 'CAP_THREE'); // same base revision
  assert.equal(first.ok && second.ok, true);
  const merged = [
    ...(first as Extract<typeof first, { ok: true }>).lane.revision.bound,
    ...(second as Extract<typeof second, { ok: true }>).lane.revision.bound,
  ];
  const converged = merged.includes('CAP_TWO') && merged.includes('CAP_THREE')
    && ((first as Extract<typeof first, { ok: true }>).lane.revision.bound.includes('CAP_THREE')
      || (second as Extract<typeof second, { ok: true }>).lane.revision.bound.includes('CAP_TWO'));
  assert.equal(converged, true,
    'two same-base acquisitions each minted revision 2 and lost one another — binding needs a CAS revision store');
});

// ─── Finding 25: null MCP scope means deny ───────────────────────────────────

test('F25: a null MCP scope denies, matching the existing MCP authority contract — it never widens to everything', () => {
  const lane = laneFor();
  const composed = intersectWithMcpScope(lane, null);
  assert.equal(composed.size, 0,
    `null MCP authority widened to ${composed.size} capabilities — the MCP contract treats null as deny`);
});

// ─── Finding 26: dispatch membership is identity, not a name ─────────────────

test('F26: dispatch binds account, schema, effect ceiling, and revision — a name match alone cannot dispatch', async () => {
  const laneModule = readFileSync(path.join(HERE, 'read-envelope.ts'), 'utf-8');
  // REQUIRED: the membership check is a typed bound-dispatch contract, not a
  // string lookup. The current laneAdmitsDispatch(name) proves the defect.
  assert.match(laneModule, /BoundReadDispatch|accountIdentity[\s\S]{0,200}schemaFingerprint[\s\S]{0,400}laneAdmitsDispatch|boundDispatchFor/,
    'dispatch membership is a name-only check — no account/schema/effect/revision binding exists at the dispatch boundary');
});

// ─── Finding 27: tampered content-addressed artifacts ────────────────────────

test('F27: a tampered artifact whose provider/scope fields changed cannot resolve as bound — content identity is recomputed on load', async () => {
  const records = new Map<string, ReceiptRecord>();
  const good = mintReceipt(records);
  const promoted = await promoteFromVerifiedReceipt({
    scope: { ...SCOPE_A }, provider: 'providerx', operation: 'list_items', effectClass: 'read',
    kind: 'composio', identifier: IDENTIFIER, templateArgs: { fixed: 'yes' }, receiptId: good.receiptId,
  }, { resolve: (id) => records.get(id) });
  assert.equal(promoted.ok, true);
  const artifactId = (promoted as Extract<typeof promoted, { ok: true }>).artifact.artifactId;

  // Tamper: rewrite provider/operation INSIDE the stored artifact while
  // keeping the file at the same content-addressed name and pointer.
  const dir = path.join(TMP_HOME, 'memory', 'procedure-artifacts', 'machine-A');
  const file = path.join(dir, `${artifactId}.json`);
  const document = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  document.provider = 'mailco';
  document.operation = 'send_mail';
  writeFileSync(file, JSON.stringify(document, null, 2), 'utf-8');
  // Re-point the tampered content at the ORIGINAL logical key.
  const key = logicalKeyDigest({ scope: { ...SCOPE_A }, provider: 'providerx', operation: 'list_items', effectClass: 'read' });
  writeFileSync(
    path.join(dir, 'logical-keys', `${key}.json`),
    JSON.stringify({ activeArtifactId: artifactId, updatedAt: new Date().toISOString() }),
    'utf-8',
  );

  const resolved = resolveActiveProcedure({
    scope: { ...SCOPE_A }, provider: 'providerx', operation: 'list_items', effectClass: 'read',
    slotValues: {},
  });
  assert.notEqual(resolved.outcome, 'bound',
    'a tampered artifact whose logical fields no longer match its content address or the requested key resolved as bound');
});

// ─── Finding 28: promotion must be cross-process transactional ───────────────

test('F28: procedure promotion is a cross-process transaction, not an in-process promise mutex with separate crashable writes', () => {
  const source = readFileSync(path.join(HERE, '..', '..', 'memory', 'procedure-receipts.ts'), 'utf-8');
  assert.equal(/KEY_LOCKS|new Map<string, Promise/.test(source), false,
    'promotion still serializes through an in-process promise mutex — two daemons or a crash mid-sequence leave a torn promotion');
  assert.match(source, /BEGIN|transaction|sqlite|better-sqlite3/i,
    'no cross-process transactional store backs artifact promotion');
});

// ─── Finding 29: one terminal needs the terminal authority ───────────────────

test('F29: the lane produces a typed presentation INPUT for the existing terminal committer — compose() as terminal authority is gone', () => {
  const source = readFileSync(path.join(HERE, 'read-lane.ts'), 'utf-8');
  assert.equal(/compose\(evidence[^)]*\):\s*Promise<string>|compose\(input[^)]*\):\s*Promise<string>/.test(source)
    || /compose\(.*\).*Promise<string>/.test(source), false,
    'compose(): Promise<string> is still the lane\'s terminal authority — no accepted-source commit, dedupe, or delivery identity proves one terminal');
});

// ─── Finding 30: pending slots must be durable ───────────────────────────────

test('F30: a cold missing-slot acquisition persists a durable pending state the next answer structurally joins', async () => {
  const result = await run(portsWith({
    async discover() {
      return { identifier: IDENTIFIER, schemaFingerprint: 'fp-live', templateArgs: { when: '{{when}}' }, kind: 'composio' };
    },
  }));
  assert.equal(result.outcome, 'needs_slots');
  // REQUIRED: the pending acquisition is durable under CLEMENTINE_HOME so a
  // later bare answer ("tomorrow") joins it without rediscovery.
  const { readdirSync, existsSync } = await import('node:fs');
  const pendingDir = path.join(TMP_HOME, 'memory', 'pending-capability-turns');
  const persisted = existsSync(pendingDir) && readdirSync(pendingDir).length > 0;
  assert.equal(persisted, true,
    'the missing-slot acquisition left no durable pending state — "tomorrow" will rerun discovery and lose the operation binding');
});
