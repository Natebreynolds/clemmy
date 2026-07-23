import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDrainApproval } from './approval-drain.js';

// Live 2026-07-22 class: a board-approved background-task send on the harness
// lane failed with "Approval not found" because the drain consulted only the
// legacy runtime's in-memory store while the approval row sat pending in the
// sqlite registry. These tests pin the registry-first contract with injected
// seams (no DB, no brain).

function makeRegistry(row?: { sessionId: string; status: string; resolution?: string | null }) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    calls,
    get: (id: string) => { calls.push({ fn: 'get', args: [id] }); return row; },
    resolve: (id: string, resolution: string, resolver: string) => {
      calls.push({ fn: 'resolve', args: [id, resolution, resolver] });
      return { ok: true };
    },
    listPending: (filter: { sessionId?: string }) => {
      calls.push({ fn: 'listPending', args: [filter] });
      return [{ approvalId: 'apr-next' }];
    },
  };
}

test('registry miss falls back to the legacy runtime store', async () => {
  const registry = makeRegistry(undefined);
  let legacyCalled = 0;
  const result = await resolveDrainApproval({
    approvalId: 'apr-legacy',
    approved: true,
    registryForTest: registry,
    legacyResolve: async () => { legacyCalled += 1; return { approvalId: 'apr-legacy', status: 'approved', text: 'legacy ok', sessionId: 'sess-l' }; },
    resumeForTest: async () => { throw new Error('resume must not run on a registry miss'); },
  });
  assert.equal(legacyCalled, 1);
  assert.equal(result.text, 'legacy ok');
});

test('pending registry row + approve → resolves the row then resumes the parked run', async () => {
  const registry = makeRegistry({ sessionId: 'background:bg-1', status: 'pending' });
  const resumes: Array<{ sessionId: string; decision: string }> = [];
  const result = await resolveDrainApproval({
    approvalId: 'apr-1',
    approved: true,
    registryForTest: registry,
    legacyResolve: async () => { throw new Error('legacy must not run when the registry owns the row'); },
    resumeForTest: async (args) => { resumes.push(args); return { status: 'completed', lastDecision: { reply: 'sent it' } }; },
  });
  assert.deepEqual(registry.calls.find((c) => c.fn === 'resolve')?.args, ['apr-1', 'approved', 'background-task-drain']);
  assert.deepEqual(resumes, [{ sessionId: 'background:bg-1', decision: 'approve', resolver: 'background-task-drain' }]);
  assert.equal(result.status, 'approved');
  assert.equal(result.text, 'sent it');
  assert.equal(result.nextApprovalId, undefined);
});

test('pending registry row + reject → resolves rejected and never resumes', async () => {
  const registry = makeRegistry({ sessionId: 'background:bg-2', status: 'pending' });
  const result = await resolveDrainApproval({
    approvalId: 'apr-2',
    approved: false,
    registryForTest: registry,
    legacyResolve: async () => { throw new Error('legacy must not run'); },
    resumeForTest: async () => { throw new Error('a rejection must not resume — the drain aborts the task'); },
  });
  assert.deepEqual(registry.calls.find((c) => c.fn === 'resolve')?.args, ['apr-2', 'rejected', 'background-task-drain']);
  assert.equal(result.status, 'rejected');
});

test('approving a registry row already resolved as rejected fails closed', async () => {
  const registry = makeRegistry({ sessionId: 'background:bg-3', status: 'resolved', resolution: 'rejected' });
  const result = await resolveDrainApproval({
    approvalId: 'apr-3',
    approved: true,
    registryForTest: registry,
    legacyResolve: async () => { throw new Error('legacy must not run'); },
    resumeForTest: async () => { throw new Error('must not dispatch an action the durable record refused'); },
  });
  assert.equal(result.status, 'rejected');
  assert.match(result.text, /rejected/);
});

test('resume pausing on a follow-up approval surfaces nextApprovalId', async () => {
  const registry = makeRegistry({ sessionId: 'background:bg-4', status: 'resolved', resolution: 'approved' });
  const result = await resolveDrainApproval({
    approvalId: 'apr-4',
    approved: true,
    registryForTest: registry,
    legacyResolve: async () => { throw new Error('legacy must not run'); },
    resumeForTest: async () => ({ status: 'awaiting_approval' }),
  });
  assert.equal(result.nextApprovalId, 'apr-next');
});

test('resume failure propagates as a throw (drain marks the task failed)', async () => {
  const registry = makeRegistry({ sessionId: 'background:bg-5', status: 'pending' });
  await assert.rejects(
    resolveDrainApproval({
      approvalId: 'apr-5',
      approved: true,
      registryForTest: registry,
      legacyResolve: async () => { throw new Error('legacy must not run'); },
      resumeForTest: async () => ({ status: 'failed', error: 'brain unreachable' }),
    }),
    /brain unreachable/,
  );
});

// Live 2026-07-23: the approval-resume ended AWAITING USER INPUT (the artifact
// ask) and the settle stamped the task done-with-empty 6s after resuming. The
// drain result must surface the question so the settle parks the task on it.
test('a resume ending awaiting_user_input surfaces the question instead of a bare approved', async () => {
  const result = await resolveDrainApproval({
    approvalId: 'apr-input-1',
    approved: true,
    legacyResolve: async () => { throw new Error('legacy must not run'); },
    registryForTest: {
      get: () => ({ sessionId: 'sess-x', status: 'resolved', resolution: 'approved' }),
      resolve: () => ({ ok: true }),
      listPending: () => [],
    },
    resumeForTest: async () => ({
      status: 'awaiting_user_input',
      lastDecision: { reply: 'The artifact create attempt is unresolved — retry or stop?' },
    }),
  });
  assert.equal(result.status, 'approved');
  assert.match(result.awaitingInputQuestion ?? '', /unresolved/);
});
