/**
 * Run: npx tsx --test src/execution/guest-run-jobs.test.ts
 *
 * Pins the guest-run job contract: the roster boundary (a path outside the
 * user's workspace projects is REFUSED — neither model nor console can aim
 * a guest harness at an arbitrary directory), the start → poll lifecycle,
 * and the kill switch reaching a running child. Offline, deterministic —
 * spawns go through the guest-harness test seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guest-jobs-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { setGuestHarnessSpawnForTest, setGuestHarnessBinaryResolverForTest } = await import('./guest-harness.js');
const { startGuestRun, getGuestRun, killGuestRun, _setGuestOutcomeDelivererForTests } = await import('./guest-run-jobs.js');
const { updateEnvKey, clearWorkspaceProjectCache } = await import('../tools/shared.js');

const workspace = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guest-jobs-ws-'));
const projectDir = path.join(workspace, 'fixture-project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(path.join(projectDir, 'package.json'), '{"name":"fixture-project"}');
updateEnvKey('WORKSPACE_DIRS', workspace);
clearWorkspaceProjectCache();
setGuestHarnessBinaryResolverForTest(() => process.execPath);

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
  updateEnvKey('WORKSPACE_DIRS', '');
  clearWorkspaceProjectCache();
  setGuestHarnessBinaryResolverForTest(null);
  setGuestHarnessSpawnForTest(null);
});

function fakeChild(): { child: any; finish: (code: number) => void; killed: string[] } {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killed: string[] = [];
  child.kill = (sig: string) => { killed.push(sig); };
  return { child, finish: (code: number) => child.emit('close', code), killed };
}

async function settle(): Promise<void> {
  // Job completion hops through promise callbacks + a dynamic import.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test('roster boundary: a directory outside the workspace roster is refused', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'clemmy-not-a-project-'));
  try {
    assert.throws(
      () => startGuestRun({ harness: 'claude', project: outside, prompt: 'x' }),
      /not a project on the user's workspace roster/,
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('start → poll → succeeded, resolving the project by NAME', async () => {
  const { child, finish } = fakeChild();
  setGuestHarnessSpawnForTest((() => child) as any);

  const job = startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: '/seo-audit example.com' });
  assert.equal(job.status, 'running');
  assert.equal(job.projectPath, projectDir);

  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'All done.' })}\n`));
  finish(0);
  await settle();

  const done = getGuestRun(job.id);
  assert.ok(done);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.finalMessage, 'All done.');
  assert.ok(done.events.some((e) => e.includes('working')));
});

test('completion reports back into the ORIGIN conversation — kills and console runs stay quiet', async () => {
  // The class fix for the babysat-turn UX (live incident 2026-07-30, Discord
  // /build-brief): the origin turn may END with a conversational ack because
  // completion rides the canonical outcome pipeline back into that session.
  const delivered: Array<{ id: string; status: string; origin?: string }> = [];
  _setGuestOutcomeDelivererForTests((job) => delivered.push({ id: job.id, status: job.status, origin: job.originSessionId }));
  try {
    // With an origin session: completion delivers exactly once, to that session.
    const a = fakeChild();
    setGuestHarnessSpawnForTest((() => a.child) as any);
    const withOrigin = startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: '/build-brief x', sessionId: 'discord-sess-1' });
    assert.equal(withOrigin.originSessionId, 'discord-sess-1', 'the starting conversation is captured on the job');
    a.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'Brief done.' })}\n`));
    a.finish(0);
    await settle();
    assert.deepEqual(delivered, [{ id: withOrigin.id, status: 'succeeded', origin: 'discord-sess-1' }]);

    // No origin (console-started): the silent dashboard notification is enough.
    delivered.length = 0;
    const b = fakeChild();
    setGuestHarnessSpawnForTest((() => b.child) as any);
    startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: 'x' });
    b.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`));
    b.finish(0);
    await settle();
    assert.equal(delivered.length, 0, 'console runs do not report into a conversation');

    // Killed: the user ended it on purpose — a report-back would be noise.
    const c = fakeChild();
    setGuestHarnessSpawnForTest((() => c.child) as any);
    const killedJob = startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: 'x', sessionId: 'discord-sess-2' });
    killGuestRun(killedJob.id);
    c.finish(143);
    await settle();
    assert.equal(delivered.length, 0, 'a user-killed run never reports back');
  } finally {
    _setGuestOutcomeDelivererForTests(null);
  }
});

test('kill: abort reaches the running child and the job reports killed', async () => {
  const { child, finish, killed } = fakeChild();
  setGuestHarnessSpawnForTest((() => child) as any);

  const job = startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: 'long thing' });
  killGuestRun(job.id);
  assert.ok(killed.includes('SIGTERM'), 'kill switch must signal the child');
  finish(143);
  await settle();

  const done = getGuestRun(job.id);
  assert.equal(done?.status, 'killed');
});

test('success records document outputs in the deliverable index (route + file recall)', async () => {
  const { child, finish } = fakeChild();
  setGuestHarnessSpawnForTest((() => child) as any);

  const job = startGuestRun({ harness: 'claude', project: 'fixture-project', prompt: '/seo-audit example.com' });
  // The guest "produces" a report + scratch JSON mid-run; only the document
  // must reach the index.
  writeFileSync(path.join(projectDir, 'audit.html'), '<html>report</html>');
  writeFileSync(path.join(projectDir, 'research.json'), '{}');
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`));
  finish(0);
  await settle();
  assert.equal(getGuestRun(job.id)?.status, 'succeeded');

  const { searchDeliverables } = await import('../memory/deliverable-index.js');
  const hits = searchDeliverables('seo audit example');
  const auditHit = hits.find((h) => h.target.endsWith('audit.html'));
  assert.ok(auditHit, `audit.html should be recorded — got: ${hits.map((h) => h.target).join(', ') || '(none)'}`);
  assert.match(auditHit.why, /project_run \(claude\)/);
  assert.equal(auditHit.stillExists, true);
  assert.ok(!hits.some((h) => h.target.endsWith('research.json')), 'scratch JSON must stay out of the index');
});

test('missing binary surfaces as a failed job naming cli_setup, not an unhandled rejection', async () => {
  setGuestHarnessBinaryResolverForTest(() => null);
  try {
    const job = startGuestRun({ harness: 'codex', project: 'fixture-project', prompt: 'x' });
    await settle();
    const done = getGuestRun(job.id);
    assert.equal(done?.status, 'failed');
    assert.match(done?.error ?? '', /not installed.*cli_setup/s);
  } finally {
    setGuestHarnessBinaryResolverForTest(() => process.execPath);
  }
});
