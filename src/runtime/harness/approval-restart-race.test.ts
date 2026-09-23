/** Fresh-process duplicate decisions and grant claims; no model/provider calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-restart-race-'));
process.env.CLEMENTINE_HOME = home;
const registry = await import('./approval-registry.js');
const events = await import('./eventlog.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

type Reply = { ok?: boolean; state?: string; reason?: string };
async function race(input: { mode: 'resolve' | 'claim' | 'session-claim'; approvalId: string; resumeKey: string; sessionId?: string }): Promise<Reply[]> {
  const script = `
    const reg = await import(${JSON.stringify(new URL('./approval-registry.ts', import.meta.url).href)});
    const { openEventLog, closeEventLog } = await import(${JSON.stringify(new URL('./eventlog.ts', import.meta.url).href)});
    openEventLog();
    process.once('message', () => {
      try {
        const input = JSON.parse(process.env.CLEM_APPROVAL_RACE_INPUT);
        const result = input.mode === 'resolve'
          ? reg.resolve(input.approvalId, 'approved', 'fixture-phone')
          : input.mode === 'session-claim'
            ? { state: reg.claimApprovedUnconsumedForSession(input.sessionId, { tools: ['fixture_deliver'] }) ? 'approved' : 'consumed' }
            : reg.claimResumableApproval(input.resumeKey, input.approvalId);
        process.send({ result: { ok: result.ok, state: result.state, reason: result.reason } });
      } catch (error) { process.send({ error: JSON.parse(process.env.CLEM_APPROVAL_RACE_INPUT).mode + ': ' + (error.stack || String(error)) }); }
      finally { closeEventLog(); process.disconnect(); }
    });
    process.send({ ready: true });
  `;
  const children = [0, 1].map(() => spawn(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, CLEMENTINE_HOME: home, CLEM_APPROVAL_RACE_INPUT: JSON.stringify(input) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }));
  try {
    return await new Promise<Reply[]>((resolve, reject) => {
      const ready = new Set<number>();
      const replies: Reply[] = [];
      let exited = 0;
      const timeout = setTimeout(() => reject(new Error('approval race exceeded 20 seconds')), 20_000);
      for (const [index, child] of children.entries()) {
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => { clearTimeout(timeout); reject(error); });
        child.on('message', (message: { ready?: boolean; error?: string; result?: Reply }) => {
          if (message.error) { clearTimeout(timeout); reject(new Error(message.error)); }
          if (message.result) replies.push(message.result);
          if (message.ready) {
            ready.add(index);
            if (ready.size === children.length) children.forEach((worker) => worker.send('go'));
          }
        });
        child.on('exit', (code) => {
          if (code !== 0) { clearTimeout(timeout); reject(new Error(`worker exited ${code}: ${stderr}`)); }
          if (++exited === children.length) {
            clearTimeout(timeout);
            replies.length === children.length ? resolve(replies) : reject(new Error('missing worker result'));
          }
        });
      }
    });
  } finally {
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); })));
  }
}

test('restart then duplicate approvals and competing resumes consume one exact grant', async () => {
  const session = events.createSession({ kind: 'workflow' });
  const resumeKey = 'exact-write-canary';
  const { row } = registry.registerResumable({ sessionId: session.id, subject: 'Review fixture',
    tool: 'fixture_deliver', args: { destination: 'fixture-only', body: 'exact payload' }, resumeKey });
  // No in-process connection, listener or cache survives into either race.
  events.closeEventLog();
  const decisions = await race({ mode: 'resolve', approvalId: row.approvalId, resumeKey });
  assert.equal(decisions.filter((result) => result.ok).length, 1);
  assert.equal(decisions.filter((result) => result.reason === 'already_resolved').length, 1);
  const claims = await race({ mode: 'claim', approvalId: row.approvalId, resumeKey });
  assert.deepEqual(claims.map((result) => result.state).sort(), ['approved', 'consumed']);
  const persisted = registry.get(row.approvalId)!;
  assert.equal(persisted.resolution, 'approved');
  assert.ok(persisted.consumedAt);
  assert.deepEqual(persisted.args, { destination: 'fixture-only', body: 'exact payload' });
});


test('competing session resume claims also return one grant without a read-upgrade failure', async () => {
  const session = events.createSession({ kind: 'workflow' });
  const resumeKey = 'session-write-canary';
  const { row } = registry.registerResumable({ sessionId: session.id, subject: 'Session fixture',
    tool: 'fixture_deliver', args: { body: 'session payload' }, resumeKey });
  assert.equal(registry.resolve(row.approvalId, 'approved', 'fixture-phone').ok, true);
  events.closeEventLog();
  const claims = await race({ mode: 'session-claim', sessionId: session.id, approvalId: row.approvalId, resumeKey });
  assert.deepEqual(claims.map((result) => result.state).sort(), ['approved', 'consumed']);
});
