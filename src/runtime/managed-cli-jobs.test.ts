/**
 * Run: npx tsx --test src/runtime/managed-cli-jobs.test.ts
 *
 * Pins for the managed/catalog CLI job runner. The two legacy kinds
 * (gh, composio) are byte-pinned — their commands are the product's only
 * hardcoded auth flows and a silent drift would break the Connect
 * buttons. Catalog auth jobs are pinned at the authority boundary: the
 * command comes only from the catalog, and interactive jobs require an exact conversation owner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-managed-cli-jobs-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { _testOnly_commandFor, startCatalogAuthJob } = await import('./managed-cli-jobs.js');
const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');

test('legacy gh/composio command specs are pinned byte-for-byte', () => {
  assert.equal(_testOnly_commandFor('github', 'install').command, 'brew install gh');
  assert.equal(_testOnly_commandFor('github', 'auth').command,
    'gh auth login -h github.com --web -s repo -s read:org -s workflow');
  assert.equal(_testOnly_commandFor('github', 'repair').command,
    'gh auth refresh -h github.com -s repo -s read:org -s workflow');
  assert.equal(_testOnly_commandFor('composio', 'install').command,
    'curl -fsSL https://composio.dev/install | bash');
  assert.equal(_testOnly_commandFor('composio', 'auth').command, 'composio login');
  assert.equal(_testOnly_commandFor('composio', 'repair').command, 'composio login');
});

test('an unknown catalog id cannot start an auth job', async () => {
  await assert.rejects(() => startCatalogAuthJob('definitely-not-a-cli'), /Unknown catalog CLI/);
});

test('every headless catalog entry can construct its job spec (authority check passes)', () => {
  // Construction-level pin only: actually starting the job would spawn a
  // real login. The headless entries' runnability is covered by the
  // authHeadless ⇒ authCommand catalog pin plus this lookup sanity.
  for (const entry of CLI_CATALOG) {
    if (!entry.authHeadless) continue;
    assert.ok(entry.authCommand && entry.authCommand.startsWith(entry.command),
      `${entry.id}: auth command should invoke the entry's own binary`);
  }
});


test('managed interactive auth is source-bound, durable, private, and never replayed', { skip: process.platform !== 'darwin' }, async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { readFileSync } = await import('node:fs');
  const jobs = await import('./managed-cli-jobs.js');
  jobs._testOnly_setCliResolver(command => ({ skipped: false, command, path: process.execPath }));
  const { withToolOutputContext } = await import('./harness/tool-output-context.js');
  const { BASE_DIR } = await import('../config.js');
  const entry = CLI_CATALOG.find(e => e.authCommand && !e.authHeadless)!;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let spawns = 0;
  jobs._testOnly_setCliSpawn(((binary: string, args: string[], options: { cwd: string; env: Record<string, unknown> }) => {
    spawns += 1; assert.equal(binary, '/usr/bin/expect'); assert.deepEqual(args.slice(3), entry.authCommand!.split(/\s+/).slice(1));
    assert.equal(options.cwd, BASE_DIR); assert.equal(options.env.OPENAI_API_KEY, undefined);
    return child;
  }) as never);
  const owner = { sessionId: 'sess-cli-proof', sourceUserSeq: 42, callId: 'auth-1' };
  try {
    const job = await withToolOutputContext(owner, () => startCatalogAuthJob(entry.id));
    assert.equal(job.interactive, true);
    assert.equal(jobs.sendManagedCliInput(job.id, 'foreign-session', 'password'), false);
    assert.equal(jobs.sendManagedCliInput(job.id, owner.sessionId, 'private-password'), true);
    child.stdout.write('password: private-pass');
    assert.doesNotMatch(jobs.getManagedCliJob(job.id)!.output, /private-pass/);
    child.stdout.write('word');
    assert.equal(jobs.sendManagedCliInput(job.id, owner.sessionId, 'clé-private'), true);
    const echoed = Buffer.from('clé-private');
    child.stdout.write(echoed.subarray(0, 3));
    assert.doesNotMatch(jobs.getManagedCliJob(job.id)!.output, /cl$/);
    child.stdout.write(echoed.subarray(3));
    assert.doesNotMatch(jobs.getManagedCliJob(job.id)!.output, /clé-private/);
    assert.doesNotMatch(jobs.getManagedCliJob(job.id)!.output, /private-password/);
    const disk = readFileSync(path.join(BASE_DIR, 'state', 'cli-jobs', job.id + '.json'), 'utf8');
    assert.doesNotMatch(disk, /private-password|password:/);
    const replay = await withToolOutputContext(owner, () => startCatalogAuthJob(entry.id));
    assert.equal(replay.id, job.id); assert.equal(spawns, 1);
    assert.equal(jobs.listManagedCliJobs('foreign-session').length, 0);
    assert.equal(jobs.listManagedCliJobs(owner.sessionId)[0]?.id, job.id);
    child.emit('close', 1, null);
    assert.equal(jobs.getManagedCliJob(job.id)?.status, 'failed');
  } finally { jobs._testOnly_setCliSpawn(); jobs._testOnly_setCliResolver(); }
});

test('a persisted running process from another boot is interrupted, never declared successful', async () => {
  const { writeFileSync } = await import('node:fs');
  const { BASE_DIR } = await import('../config.js');
  const { getManagedCliJob } = await import('./managed-cli-jobs.js');
  const directory = path.join(BASE_DIR, 'state', 'cli-jobs'); mkdirSync(directory, { recursive: true });
  const id = 'cli-abcdef';
  writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ id, bootId: 'old-boot', status: 'running', output: '', sessionId: 'sess-old' }));
  assert.equal(getManagedCliJob(id)?.status, 'interrupted');
  assert.equal(getManagedCliJob('../credentials'), undefined);
});

test('exit zero without a fresh healthy connection does not report authenticated', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const jobs = await import('./managed-cli-jobs.js');
  jobs._testOnly_setCliResolver(command => ({ skipped: false, command, path: process.execPath }));
  const health = await import('../integrations/cli-catalog/auth-health.js');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  jobs._testOnly_setCliSpawn((() => child) as never);
  health._testOnly_setCommandResolver(command => ({ skipped: false, command, path: process.execPath }));
  health._testOnly_setProbeExec(async () => ({ exitCode: 1, output: 'Unauthorized', timedOut: false }));
  try {
    const job = await startCatalogAuthJob('railway');
    child.emit('close', 0, null);
    const deadline = Date.now() + 2000;
    while (job.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(job.status, 'failed');
    assert.match(job.detail!, /could not be verified/);
    assert.equal(job.exitCode, 0);
  } finally { jobs._testOnly_setCliSpawn(); jobs._testOnly_setCliResolver(); health._testOnly_setCommandResolver(); health._testOnly_setProbeExec(); }
});

test('native macOS pseudo-terminal accepts private input and preserves a nonzero child exit', { skip: process.platform !== 'darwin' }, async () => {
  const { writeFileSync } = await import('node:fs');
  const jobs = await import('./managed-cli-jobs.js');
  const { withToolOutputContext } = await import('./harness/tool-output-context.js');
  const fixture = path.join(TMP_HOME, 'interactive-fixture');
  writeFileSync(fixture, '#!/bin/sh\nprintf "READY\\n"\nIFS= read -r value\nprintf "received:%s\\n" "$value"\nexit 7\n', { mode: 0o700 });
  jobs._testOnly_setCliResolver(command => ({ skipped: false, command, path: fixture }));
  const owner = { sessionId: 'sess-native-pty-fixture', sourceUserSeq: 43, callId: 'native-auth' };
  let job: Awaited<ReturnType<typeof startCatalogAuthJob>> | undefined;
  try {
    job = await withToolOutputContext(owner, () => startCatalogAuthJob('salesforce'));
    const ready = Date.now() + 3000;
    while (!job.output.includes('READY') && job.status === 'running' && Date.now() < ready) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(job.output, /READY/);
    assert.equal(jobs.sendManagedCliInput(job.id, owner.sessionId, 'fixture-private'), true);
    const end = Date.now() + 3000;
    while (job.status === 'running' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 7);
    assert.match(job.output, /received:/); assert.doesNotMatch(job.output, /fixture-private/);
  } finally {
    if (job?.status === 'running') jobs.cancelManagedCliJob(job.id, owner.sessionId);
    jobs._testOnly_setCliResolver();
  }
});


test('interactive login without an owning conversation is refused before dispatch', { skip: process.platform !== 'darwin' }, async () => {
  const jobs = await import('./managed-cli-jobs.js');
  jobs._testOnly_setCliResolver(command => ({ skipped: false, command, path: process.execPath }));
  try { await assert.rejects(() => startCatalogAuthJob('salesforce'), /accepted conversation request/); }
  finally { jobs._testOnly_setCliResolver(); }
});

test('native interactive cancellation stops the owned PTY process and retains uncertainty', { skip: process.platform !== 'darwin' }, async () => {
  const { writeFileSync } = await import('node:fs');
  const jobs = await import('./managed-cli-jobs.js');
  const { withToolOutputContext } = await import('./harness/tool-output-context.js');
  const fixture = path.join(TMP_HOME, 'cancel-fixture');
  writeFileSync(fixture, '#!/bin/sh\nprintf "PID:%s\\n" "$$"\nIFS= read -r value\n', { mode: 0o700 });
  jobs._testOnly_setCliResolver(command => ({ skipped: false, command, path: fixture }));
  const owner = { sessionId: 'sess-native-cancel-fixture', sourceUserSeq: 44, callId: 'native-cancel' };
  let job: Awaited<ReturnType<typeof startCatalogAuthJob>> | undefined;
  let pid: number | undefined;
  try {
    job = await withToolOutputContext(owner, () => startCatalogAuthJob('salesforce'));
    const ready = Date.now() + 3000;
    while (!job.output.includes('PID:') && job.status === 'running' && Date.now() < ready) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(job.output, /PID:[0-9]+/);
    pid = Number(/PID:([0-9]+)/.exec(job.output)![1]);
    assert.equal(jobs.cancelManagedCliJob(job.id, 'foreign-session'), false);
    assert.equal(jobs.cancelManagedCliJob(job.id, owner.sessionId), true);
    assert.equal(jobs.sendManagedCliInput(job.id, owner.sessionId, 'late'), false);
    let alive = true;
    const end = Date.now() + 3000;
    while (alive && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the owned PTY child must stop, not just its adapter');
    assert.equal(job.status, 'cancelled'); assert.match(job.detail!, /effects already performed/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    if (job?.status === 'running') jobs.cancelManagedCliJob(job.id, owner.sessionId);
    jobs._testOnly_setCliResolver();
  }
});
