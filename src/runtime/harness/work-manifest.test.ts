import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-work-manifest-'));
process.env.CLEMENTINE_HOME = testHome;

const eventlog = await import('./eventlog.js');
const {
  checkpointWorkItem,
  completedPreparedWorker,
  declareWorkManifest,
  checkpointPreparedWorker,
  prepareWorkerManifest,
  resolveWorkItemId,
  reviseWorkContract,
  summarizeWorkManifest,
} = await import('./work-manifest.js');

function session(id: string): string {
  eventlog.createSession({ id, kind: 'execution', title: id });
  return id;
}

test.after(() => {
  eventlog.closeEventLog();
});

test('canonical aliases keep account ids and spreadsheet rows in one 120-item universe', () => {
  const sid = session('manifest-aliases');
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: `account-${index + 1}`,
    label: `Firm ${index + 1}`,
    aliases: [`row-${index + 2}`],
  }));
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'outreach',
    contractVersion: 1,
    phases: [
      { id: 'research', label: 'Research' },
      { id: 'merge', label: 'Merge', dependsOn: ['research'] },
      { id: 'readback', label: 'Read back', dependsOn: ['merge'] },
    ],
    items,
  });
  for (let index = 0; index < 120; index += 1) {
    checkpointWorkItem({
      sessionId: sid,
      manifestId: 'outreach',
      contractVersion: 1,
      phase: 'research',
      itemId: `row-${index + 2}`,
      status: 'succeeded',
      evidence: [{ kind: 'source', ref: `https://example.test/${index + 1}` }],
    });
  }
  const summary = summarizeWorkManifest(sid, 'outreach');
  assert.ok(summary);
  assert.equal(summary.total, 120);
  assert.equal(summary.phases[0]?.succeeded, 120);
  assert.equal(summary.completed, 0, 'later phases are still visible as unfinished');
  assert.equal(summary.currentPhase, 'merge');
  assert.equal(resolveWorkItemId(sid, 'outreach', 'ROW-2'), 'account-1');
});

test('undeclared labels are surfaced as anomalies and never expand logical totals', () => {
  const sid = session('manifest-no-implicit-expansion');
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'accounts',
    contractVersion: '1',
    phases: [{ id: 'research' }],
    items: [{ id: 'sf-001' }, { id: 'sf-002' }],
  });
  eventlog.appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'work_item_checkpoint',
    data: {
      manifestId: 'accounts',
      contractVersion: '1',
      phase: 'research',
      itemId: 'row 99',
      status: 'succeeded',
      evidence: [{ kind: 'worker_result', ref: 'event:999' }],
    },
  });
  const summary = summarizeWorkManifest(sid, 'accounts');
  assert.ok(summary);
  assert.equal(summary.total, 2);
  assert.equal(summary.untrackedCheckpoints, 1);
  assert.match(summary.anomalies.join('\n'), /undeclared item/i);
});

test('only an explicit same-contract extension can grow the logical universe', () => {
  const sid = session('manifest-explicit-extension');
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'accounts',
    contractVersion: 1,
    phases: [{ id: 'research' }],
    items: [{ id: 'a' }],
  });
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'accounts',
    contractVersion: 1,
    phases: [{ id: 'research' }, { id: 'merge' }],
    items: [{ id: 'b' }],
  });
  let summary = summarizeWorkManifest(sid, 'accounts');
  assert.equal(summary?.total, 1);
  assert.equal(summary?.phases.length, 1);
  assert.match(summary?.anomalies.join('\n') ?? '', /without mode="extend"/i);

  declareWorkManifest({
    sessionId: sid,
    manifestId: 'accounts',
    contractVersion: 1,
    mode: 'extend',
    phases: [{ id: 'research' }, { id: 'merge', dependsOn: ['research'] }],
    items: [{ id: 'b' }],
  });
  summary = summarizeWorkManifest(sid, 'accounts');
  assert.equal(summary?.total, 2);
  assert.equal(summary?.phases.length, 2);

  reviseWorkContract({
    sessionId: sid,
    manifestId: 'accounts',
    fromVersion: 1,
    toVersion: 2,
    instruction: 'Use the revised source contract.',
    evidencePolicy: 'preserve',
  });
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'accounts',
    contractVersion: 1,
    mode: 'extend',
    phases: [{ id: 'publish' }],
    items: [{ id: 'c' }],
  });
  summary = summarizeWorkManifest(sid, 'accounts');
  assert.equal(summary?.contractVersion, '2');
  assert.equal(summary?.total, 2, 'a late declaration from the old contract cannot expand v2');
  assert.equal(summary?.phases.length, 2);
});

test('phase graphs reject undeclared, cyclic, or forward dependencies before work starts', () => {
  const sid = session('manifest-phase-validation');
  assert.throws(
    () => declareWorkManifest({
      sessionId: sid,
      manifestId: 'invalid',
      contractVersion: 1,
      phases: [{ id: 'merge', dependsOn: ['research'] }, { id: 'research' }],
      items: [{ id: 'a' }],
    }),
    /must come after dependency "research"/i,
  );
  assert.throws(
    () => declareWorkManifest({
      sessionId: sid,
      manifestId: 'missing',
      contractVersion: 1,
      phases: [{ id: 'research', dependsOn: ['collect'] }],
      items: [{ id: 'a' }],
    }),
    /depends on undeclared phase "collect"/i,
  );
  assert.equal(summarizeWorkManifest(sid, 'invalid'), null);
  assert.equal(summarizeWorkManifest(sid, 'missing'), null);
});

test('contract revisions preserve, revalidate, or invalidate evidence without replay ambiguity', () => {
  const sid = session('manifest-revisions');
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'research',
    contractVersion: 1,
    phases: [{ id: 'research' }, { id: 'publish', dependsOn: ['research'] }],
    items: [{ id: 'a' }, { id: 'b' }],
  });
  for (const itemId of ['a', 'b']) {
    checkpointWorkItem({
      sessionId: sid,
      manifestId: 'research',
      contractVersion: 1,
      phase: 'research',
      itemId,
      status: 'succeeded',
      evidence: [{ kind: 'source', ref: `source:${itemId}` }],
    });
  }
  reviseWorkContract({
    sessionId: sid,
    manifestId: 'research',
    fromVersion: 1,
    toVersion: 2,
    instruction: 'Use the connected first-party research source.',
    evidencePolicy: 'revalidate',
    phases: ['research'],
  });
  let summary = summarizeWorkManifest(sid, 'research');
  assert.equal(summary?.phases[0]?.needsValidation, 2);
  assert.equal(summary?.evidenceCount, 2, 'old evidence remains inspectable');

  eventlog.appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'work_item_checkpoint',
    data: {
      manifestId: 'research',
      contractVersion: '1',
      phase: 'research',
      itemId: 'a',
      status: 'succeeded',
      evidence: [{ kind: 'source', ref: 'late-old-contract' }],
    },
  });
  summary = summarizeWorkManifest(sid, 'research');
  assert.equal(summary?.staleCheckpoints, 1);
  assert.equal(summary?.phases[0]?.needsValidation, 2, 'late old-contract success cannot clear the revision');

  checkpointWorkItem({
    sessionId: sid,
    manifestId: 'research',
    contractVersion: 2,
    phase: 'research',
    itemId: 'a',
    status: 'succeeded',
    evidence: [{ kind: 'readback', ref: 'chatgpt-run:a' }],
  });
  summary = summarizeWorkManifest(sid, 'research');
  assert.equal(summary?.phases[0]?.succeeded, 1);
  assert.equal(summary?.phases[0]?.needsValidation, 1);
});

test('a late duplicate failure cannot erase an evidence-backed success', () => {
  const sid = session('manifest-monotonic-success');
  declareWorkManifest({
    sessionId: sid,
    manifestId: 'build',
    contractVersion: 1,
    phases: [{ id: 'compile' }],
    items: [{ id: 'desktop' }],
  });
  checkpointWorkItem({
    sessionId: sid,
    manifestId: 'build',
    contractVersion: 1,
    phase: 'compile',
    itemId: 'desktop',
    status: 'succeeded',
    evidence: [{ kind: 'artifact', ref: 'dist/desktop' }],
  });
  checkpointWorkItem({
    sessionId: sid,
    manifestId: 'build',
    contractVersion: 1,
    phase: 'compile',
    itemId: 'desktop',
    status: 'failed',
    reason: 'A redundant retry timed out.',
  });
  const summary = summarizeWorkManifest(sid, 'build');
  assert.equal(summary?.phases[0]?.succeeded, 1);
  assert.equal(summary?.phases[0]?.failed, 0);
  assert.equal(summary?.items[0]?.phases.compile.attempts, 2);
});

test('run_worker preparation refuses accidental expansion and binds changed labels to canonical ids', () => {
  const sid = session('manifest-worker-preflight');
  const declared = prepareWorkerManifest({
    sessionId: sid,
    items: ['account-a', 'account-b'],
    objective: 'Research the accounts.',
    descriptor: {
      id: 'accounts',
      contractVersion: '1',
      phase: 'research',
      mode: 'declare',
      phases: [{ id: 'research' }, { id: 'merge', dependsOn: ['research'] }],
    },
  });
  assert.equal(declared.ok, true);
  if (!declared.ok) return;
  checkpointPreparedWorker(sid, declared.binding, 'account-a', 'succeeded', {
    evidence: [{ kind: 'worker_result', ref: 'event:1' }],
  });

  const reconciled = prepareWorkerManifest({
    sessionId: sid,
    items: ['row-2', 'row-3'],
    descriptor: {
      id: 'accounts',
      contractVersion: '1',
      phase: 'research',
      aliases: { 'row-2': 'account-a', 'row-3': 'account-b' },
    },
  });
  assert.equal(reconciled.ok, true);
  assert.equal(summarizeWorkManifest(sid, 'accounts')?.total, 2);

  const refused = prepareWorkerManifest({
    sessionId: sid,
    items: ['row-99'],
    descriptor: {
      id: 'accounts',
      contractVersion: '1',
      phase: 'research',
    },
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /refused.*undeclared canonical item/i);
  assert.equal(summarizeWorkManifest(sid, 'accounts')?.total, 2);
});

test('prepared worker completion survives a changed call packet but not a contract revalidation', () => {
  const sid = session('manifest-worker-completion');
  const prepared = prepareWorkerManifest({
    sessionId: sid,
    items: ['row-2'],
    descriptor: {
      id: 'accounts',
      contractVersion: '1',
      phase: 'research',
      mode: 'declare',
      phases: [{ id: 'research' }],
      aliases: { 'row-2': 'account-a' },
    },
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const result = eventlog.appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'worker_result',
    data: { item: 'row-2', ok: true, packetKey: 'packet-before-restart' },
  });
  checkpointPreparedWorker(sid, prepared.binding, 'row-2', 'succeeded', {
    evidence: [{ kind: 'worker_result', ref: `event:${result.seq}` }],
  });

  const completion = completedPreparedWorker(sid, prepared.binding, 'row-2');
  assert.equal(completion?.itemId, 'account-a');
  assert.deepEqual(completion?.packetKeys, ['packet-before-restart']);

  reviseWorkContract({
    sessionId: sid,
    manifestId: 'accounts',
    fromVersion: 1,
    toVersion: 2,
    instruction: 'Use the revised source.',
    evidencePolicy: 'revalidate',
  });
  const revised = prepareWorkerManifest({
    sessionId: sid,
    items: ['row-2'],
    descriptor: {
      id: 'accounts',
      contractVersion: '2',
      phase: 'research',
      aliases: { 'row-2': 'account-a' },
    },
  });
  assert.equal(revised.ok, true);
  if (revised.ok) assert.equal(completedPreparedWorker(sid, revised.binding, 'row-2'), null);
});
