import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingCommit as DesktopCommit } from './pending-commit';
import { PendingCommit as PhoneCommit } from '../../../mobile-web/src/lib/pending-commit';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const [surface, Commit] of [['desktop', DesktopCommit], ['phone', PhoneCommit]] as const) {
  test(`${surface}: pending captured save admits one submit and unlocks after refusal`, async () => {
    const commit = new Commit('agent-a');
    const request = deferred<string>();
    let calls = 0;
    let failure = '';
    const submit = async () => {
      const token = commit.begin();
      if (!token) return;
      calls++;
      try { await request.promise; }
      catch (error) { if (commit.owns(token)) failure = (error as Error).message; }
      finally { commit.finish(token); }
    };
    const first = submit();
    await submit();
    assert.equal(calls, 1);
    assert.equal(commit.pending, true);
    request.reject(new Error('Controlled refusal'));
    await first;
    assert.equal(failure, 'Controlled refusal');
    assert.equal(commit.pending, false);
    assert.ok(commit.begin(), 'same draft can be retried explicitly');
  });

  test(`${surface}: replaced owner rejects late success, refusal and old unlock`, async () => {
    for (const outcome of ['success', 'refusal'] as const) {
      const commit = new Commit('space-dialog-open');
      const old = deferred<string>();
      const token = commit.begin()!;
      const notices: string[] = [];
      const response = (async () => {
        try {
          const saved = await old.promise;
          if (commit.owns(token)) notices.push(`navigate:${saved}`);
        } catch (error) {
          if (commit.owns(token)) notices.push(`error:${(error as Error).message}`);
        } finally { commit.finish(token); }
      })();
      commit.setScope('space-dialog-closed');
      commit.setScope('space-dialog-open');
      const current = commit.begin()!;
      if (outcome === 'success') old.resolve('old-space');
      else old.reject(new Error('Old refusal'));
      await response;
      assert.deepEqual(notices, [], 'old response cannot close/navigate or populate the replacement form');
      assert.equal(commit.owns(current), true, 'old finally cannot unlock a new pending commit');
      assert.equal(commit.pending, true);
    }
  });

  test(`${surface}: unmounted graph/form refuses a late reload`, async () => {
    const commit = new Commit('workflow-a');
    const request = deferred<string>();
    const token = commit.begin()!;
    let applied = '';
    const reload = request.promise.then((graph) => { if (commit.owns(token)) applied = graph; });
    commit.invalidate();
    request.resolve('old saved graph');
    await reload;
    assert.equal(applied, '');
    assert.equal(commit.finish(token), false);
  });

  test(`${surface}: graph and step submissions exclude one another through the deferred reload`, async () => {
    for (const first of ['graph', 'step'] as const) {
      const commit = new Commit('workflow-fixture');
      const write = deferred<string>();
      const reload = deferred<string>();
      const token = commit.begin()!;
      const saving = (async () => {
        await write.promise;
        if (commit.owns(token)) await reload.promise;
        commit.finish(token);
      })();
      assert.equal(commit.begin(), null, `${first} holds the other submission before acknowledgement`);
      write.resolve('accepted');
      await Promise.resolve();
      assert.equal(commit.begin(), null, `${first} still holds the other submission during reload`);
      reload.resolve('current graph');
      await saving;
      assert.ok(commit.begin(), 'next explicit submission is admitted after reload');
    }
  });
}
