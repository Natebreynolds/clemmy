/**
 * Run: npx tsx --test src/execution/continuation-fanout.test.ts
 *
 * E5 + E6 behavior: the durable continuation capsule and hard handoff, and
 * the typed work disposition with its durable fan-out adapter (40, 120, and
 * 514 canonical items), including real cross-process restart.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-e5e6-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  checkpointCapsule, loadCapsule, completedItemIds,
  recordHandoffState, loadHandoffState, repairHandoff,
} = await import('./continuation-capsule.js');
const {
  admitWorkDisposition, dispositionToDurableWork, manifestWindows, reducerReady,
  WORKER_WINDOW_ITEMS,
} = await import('./work-disposition.js');
type WorkDisposition = import('./work-disposition.js').WorkDisposition;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function manifestOf(count: number, prefix = 'acct') {
  return {
    manifestId: `mf-${count}`,
    contractVersion: 'v1',
    canonicalItems: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      inputRef: `ref:${prefix}-${index + 1}`,
    })),
    phases: [
      { id: 'read', dependsOn: [] as string[], runnerClass: 'worker' },
      { id: 'enrich', dependsOn: ['read'], runnerClass: 'worker' },
    ],
    reducer: { id: 'reduce', requiredPhases: ['read', 'enrich'], outputContract: 'report@1' },
  };
}

function dispositionOf(count: number, over: Partial<WorkDisposition> = {}): WorkDisposition {
  return {
    kind: 'durable_manifest',
    objective: 'work through the accounts and report the patterns',
    successCriteria: ['every account has a terminal', 'one report'],
    missingRequiredInputs: [],
    effectCeiling: 'read',
    manifest: manifestOf(count),
    estimatedActivations: Math.max(1, Math.ceil(count / WORKER_WINDOW_ITEMS)),
    ...over,
  };
}

// ─── E5: the continuation capsule ────────────────────────────────────────────

test('E5: a capsule survives a REAL process restart and names completed work structurally', () => {
  const capsule = checkpointCapsule({
    logicalTaskId: 'task-restart',
    sessionId: 'sess-1',
    acceptedSource: 'sess-1:7',
    activationId: 'act-1',
    objective: 'go through the 40 accounts',
    successCriteria: ['40/40 with receipts'],
    constraints: ['exclude existing customers'],
    decisions: ['use the shared sheet'],
    scopeRefs: { account: 'person@example.com', timezone: 'America/Los_Angeles' },
    capabilityRefs: { procedureArtifactId: 'pa_x', schemaFingerprint: 'fp-1' },
    manifest: {
      manifestId: 'mf-40',
      contractVersion: 'v1',
      items: [
        { itemId: 'acct-1', status: 'completed', receiptRef: 'r1', artifactRef: 'a1' },
        { itemId: 'acct-2', status: 'completed', receiptRef: 'r2', artifactRef: 'a2' },
        { itemId: 'acct-3', status: 'completed', receiptRef: 'r3', artifactRef: 'a3' },
        { itemId: 'acct-4', status: 'pending' },
      ],
      reducerId: 'reduce',
      reducerStatus: 'pending',
    },
    effectRefs: [],
    deliverableRefs: [],
    nextSafeActions: ['start at acct-4'],
  });
  assert.equal(completedItemIds(capsule).length, 3);

  // A REAL child process, fresh module registry, same durable home.
  const script = [
    `process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};`,
    `const { loadCapsule, completedItemIds } = await import(${JSON.stringify(path.join(HERE, 'continuation-capsule.ts'))});`,
    "const loaded = loadCapsule('task-restart');",
    'console.log(JSON.stringify({',
    '  objective: loaded?.objective,',
    '  constraints: loaded?.constraints,',
    '  completed: completedItemIds(loaded),',
    '  next: loaded?.nextSafeActions,',
    '  account: loaded?.scopeRefs.account,',
    '  procedure: loaded?.capabilityRefs.procedureArtifactId,',
    '}));',
  ].join('\n');
  const scriptFile = path.join(TMP_HOME, 'restart-probe.mts');
  writeFileSync(scriptFile, script, 'utf-8');
  const output = execFileSync('npx', ['tsx', scriptFile], {
    cwd: path.join(HERE, '..', '..'), encoding: 'utf-8',
  });
  const restored = JSON.parse(output.trim().split('\n').pop()!) as Record<string, unknown>;
  assert.equal(restored.objective, 'go through the 40 accounts');
  assert.deepEqual(restored.completed, ['acct-1', 'acct-2', 'acct-3'],
    'a restarted process could not tell which items were already done');
  assert.deepEqual(restored.constraints, ['exclude existing customers']);
  assert.equal(restored.account, 'person@example.com');
  assert.equal(restored.procedure, 'pa_x');
});

test('E5: capsule size stays bounded as item count grows — refs only, never payloads', () => {
  const sizeFor = (count: number): number => {
    const capsule = checkpointCapsule({
      logicalTaskId: `bounded-${count}`,
      sessionId: 's', acceptedSource: 's:1', activationId: 'a',
      objective: 'o', successCriteria: [], constraints: [], decisions: [],
      scopeRefs: {}, capabilityRefs: {},
      manifest: {
        manifestId: 'm', contractVersion: 'v1',
        items: Array.from({ length: count }, (_, index) => ({
          itemId: `i-${index}`, status: 'completed' as const, receiptRef: `r${index}`, artifactRef: `a${index}`,
        })),
      },
      effectRefs: [], deliverableRefs: [], nextSafeActions: [],
    });
    return JSON.stringify(capsule).length;
  };
  const small = sizeFor(10);
  const large = sizeFor(1_000);
  // Linear in ITEM COUNT (ids + refs) but tiny per item: a 100x item count
  // must not carry payload-sized growth.
  assert.ok(large / small < 130, `capsule grew ${(large / small).toFixed(1)}x for 100x items`);
  assert.ok(large / 1_000 < 140, `per-item capsule cost is ${(large / 1_000).toFixed(0)} bytes`);
});

test('E5.2: the handoff state machine repairs deterministically to ONE owner', () => {
  const base = {
    logicalTaskId: 'task-handoff', acceptedAttemptId: 'attempt-9',
    sessionId: 'sess-1', sourceUserSeq: 7,
  };
  assert.equal(repairHandoff(undefined).action, 'start_fresh');
  for (const [state, action] of [
    ['requested', 'checkpoint_then_admit'],
    ['foreground_commit_fenced', 'checkpoint_then_admit'],
    ['capsule_checkpointed', 'resume_admission'],
    ['background_admitted', 'rejoin_existing'],
    ['background_owner_active', 'rejoin_existing'],
    ['foreground_released', 'rejoin_existing'],
  ] as const) {
    recordHandoffState({ ...base, state });
    const loaded = loadHandoffState('attempt-9');
    assert.equal(loaded?.state, state);
    assert.equal(repairHandoff(loaded).action, action, `${state} repaired wrongly`);
  }
  // A double-click on the same accepted attempt REJOINS rather than forking.
  recordHandoffState({ ...base, state: 'background_owner_active', backgroundTaskId: 'bg-1' });
  assert.equal(repairHandoff(loadHandoffState('attempt-9')).action, 'rejoin_existing');
});

// ─── E6: typed disposition and the durable fan-out adapter ───────────────────

test('E6.1: the runtime admits a typed plan — real item identities, asked-once inputs, explicit controls win', () => {
  const admitted = admitWorkDisposition(dispositionOf(40));
  assert.equal(admitted.ok, true, JSON.stringify(admitted));

  // Estimated counts are not a manifest.
  const placeholders = admitWorkDisposition(dispositionOf(3, {
    manifest: {
      manifestId: 'm', contractVersion: 'v1',
      canonicalItems: [{ id: 'item 1' }, { id: 'item 2' }, { id: 'item 3' }],
      phases: [{ id: 'read', dependsOn: [], runnerClass: 'worker' }],
      reducer: { id: 'reduce', requiredPhases: ['read'], outputContract: 'report@1' },
    },
  }));
  assert.equal(placeholders.ok, false);

  // Missing load-bearing inputs ask ONCE, before any unattended work.
  const asks = admitWorkDisposition(dispositionOf(40, { missingRequiredInputs: ['which sheet'] }));
  assert.equal(asks.ok, false);
  assert.equal((asks as Extract<typeof asks, { ok: false }>).kind, 'needs_input');

  // An explicit user control outranks inference in both directions.
  const forcedForeground = admitWorkDisposition(dispositionOf(10, { estimatedActivations: 1 }), { explicit: 'foreground' });
  assert.equal((forcedForeground as Extract<typeof forcedForeground, { ok: true }>).disposition.kind, 'bounded_foreground');
  const forcedBackground = admitWorkDisposition({
    ...dispositionOf(2), kind: 'direct', estimatedActivations: 1,
  }, { explicit: 'background' });
  assert.equal((forcedBackground as Extract<typeof forcedBackground, { ok: true }>).disposition.kind, 'durable_manifest');
});

test('E6.3: 40, 120, and 514 items all complete — the worker window routes, it never refuses or truncates', () => {
  for (const count of [40, 120, 514]) {
    const admitted = admitWorkDisposition(dispositionOf(count));
    assert.equal(admitted.ok, true, `${count}: ${JSON.stringify(admitted)}`);
    const ok = admitted as Extract<typeof admitted, { ok: true }>;
    assert.equal(ok.disposition.kind, 'durable_manifest', `${count}: not durable`);
    assert.equal(ok.windows, manifestWindows(count));

    const plan = dispositionToDurableWork(ok.disposition);
    assert.ok(plan, `${count}: no durable plan`);
    const scheduled = plan!.windows.flatMap((window) => window.itemIds);
    assert.equal(scheduled.length, count, `${count}: ${scheduled.length} items scheduled — truncation or refusal`);
    assert.equal(new Set(scheduled).size, count, `${count}: duplicate item scheduling`);
    for (const window of plan!.windows) {
      assert.ok(window.itemIds.length <= WORKER_WINDOW_ITEMS, `${count}: a window exceeded the worker schema`);
    }
    // The reducer waits for EVERY canonical item x required phase, then runs
    // once. Readiness is the plan's own ledger, so a caller cannot assert it.
    const settled = scheduled.flatMap((itemId) => plan!.requiredPhases.map((phaseId) => ({ itemId, phaseId })));
    assert.equal(reducerReady({ plan: plan!, completed: settled.slice(0, settled.length - 1) }).ready, false,
      `${count}: the reducer was ready with a partial item set`);
    assert.equal(reducerReady({ plan: plan!, completed: settled }).ready, true);
    const forged = settled.map((entry, index) => ({ ...entry, itemId: `forged-${index}` }));
    const forgedVerdict = reducerReady({ plan: plan!, completed: forged });
    assert.equal(forgedVerdict.ready, false,
      `${count}: settlements for ids belonging to no item satisfied the reducer`);
    assert.equal(forgedVerdict.unknown.length, forged.length,
      `${count}: forged settlements were not reported as unknown`);
  }
});

test('E6.4: a mid-run correction re-admits the SAME logical task; only the affected cone invalidates', () => {
  const before = admitWorkDisposition(dispositionOf(40));
  assert.equal(before.ok, true);
  // "exclude existing customers" removes items — same manifest id, new
  // contract version, and the capsule keeps the completed work that survives.
  const corrected = admitWorkDisposition(dispositionOf(28, {
    manifest: { ...manifestOf(28), manifestId: 'mf-40', contractVersion: 'v2' },
  }));
  assert.equal(corrected.ok, true);
  const ok = corrected as Extract<typeof corrected, { ok: true }>;
  assert.equal(ok.disposition.manifest?.manifestId, 'mf-40', 'a correction forked a sibling task');
  assert.equal(ok.disposition.manifest?.contractVersion, 'v2');

  const capsule = checkpointCapsule({
    logicalTaskId: 'task-correction',
    sessionId: 's', acceptedSource: 's:1', activationId: 'a2',
    objective: 'accounts, excluding existing customers',
    successCriteria: [], constraints: ['exclude existing customers'], decisions: [],
    scopeRefs: {}, capabilityRefs: {},
    manifest: {
      manifestId: 'mf-40', contractVersion: 'v2',
      items: ok.disposition.manifest!.canonicalItems.map((item, index) => ({
        itemId: item.id,
        status: index < 5 ? 'completed' as const : 'pending' as const,
        ...(index < 5 ? { receiptRef: `r${index}` } : {}),
      })),
    },
    effectRefs: [], deliverableRefs: [], nextSafeActions: ['continue from item 6'],
  });
  assert.equal(completedItemIds(capsule).length, 5, 'the correction discarded surviving completed work');
  assert.equal(loadCapsule('task-correction')?.manifest?.contractVersion, 'v2');
});
