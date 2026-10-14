/** Run: node scripts/run-tests-isolated.mjs src/dashboard/console-cli-connections.test.ts */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';
import express from 'express';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clem-cli-connections-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.NODE_ENV = 'test';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const priorSaved = process.env.CLEMMY_SAVED_CLIS;
process.env.CLEMMY_SAVED_CLIS = 'sf,fixture-unknown,gh';
const stateDir = path.join(fixtureHome, 'state');
fs.mkdirSync(stateDir, { recursive: true });

// Install the process seam before imports: cli-spawn may retain spawn itself.
// No executable, installation, auth command, or vendor probe is run by this test.
const processCalls: string[] = [];
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  mock.method(childProcess, method, () => {
    processCalls.push(method);
    throw new Error('Fixture forbids child processes');
  });
}
syncBuiltinESMExports();

const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');
await import('../integrations/cli-catalog/auth-health.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const app = express();
registerConsoleRoutes(app, req => req.headers.authorization === 'fixture-connection-reader', {
  getRuntime: () => ({ listPendingApprovals: () => [] }),
} as never, { serveLegacyAtRoot: false });
const layer = app._router.stack.find((candidate: { route?: { path: string; methods?: { get?: boolean } } }) =>
  candidate.route?.path === '/api/console/clis/connections' && candidate.route.methods?.get);
assert.ok(layer, 'actual registered metadata-only GET route exists');
const handler = layer.route.stack[0].handle;

test.after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  closeEventLog();
  if (priorSaved === undefined) delete process.env.CLEMMY_SAVED_CLIS;
  else process.env.CLEMMY_SAVED_CLIS = priorSaved;
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

async function request(authorized = true): Promise<{ status: number; body: Record<string, any> }> {
  let status = 200;
  let body: Record<string, any> | undefined;
  const req = { headers: authorized ? { authorization: 'fixture-connection-reader' } : {} } as express.Request;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: Record<string, any>) { body = value; return this; },
  } as unknown as express.Response;
  await handler(req, res);
  assert.ok(body, 'registered handler completed its response');
  return { status, body };
}

function guardPolling(t: TestContext) {
  const forbidden: string[] = [];
  const deny = (name: string) => () => { forbidden.push(name); throw new Error(`Fixture forbids ${name}`); };
  for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync'] as const) {
    t.mock.method(fs, method, deny(method));
  }
  for (const method of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'copyFile'] as const) {
    t.mock.method(fsPromises, method, deny(method));
  }
  // Scanning or auto-promotion must not hide behind a harmless-looking GET.
  for (const method of ['readdirSync', 'realpathSync'] as const) t.mock.method(fs, method, deny(method));
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    const filename = String(args[0]);
    // The TS loader can stat an already-imported source on its first dynamic
    // import, and metadata readers can stat private fixture files. Neither is
    // executable discovery; PATH candidates and vendor locations still fail.
    if (filename.startsWith(`${fixtureHome}${path.sep}`)
      || (filename.startsWith(`${process.cwd()}${path.sep}`) && /\.(?:[cm]?js|tsx?|json)$/.test(filename))) {
      return Reflect.apply(statSync, fs, args);
    }
    forbidden.push('statSync');
    throw new Error('Fixture forbids executable discovery');
  });
  t.mock.method(globalThis, 'fetch', deny('fetch'));
  syncBuiltinESMExports();
  const processCount = processCalls.length;
  return () => {
    assert.deepEqual(forbidden, [], 'polling never writes, discovers, or calls a vendor');
    assert.equal(processCalls.length, processCount, 'polling never launches a child process');
  };
}

const checkedAt = '2026-10-14T20:00:00.000Z';
const staleSince = '2026-10-14T19:00:00.000Z';
const privateMarker = 'fixture-private-output-and-token-do-not-project';
const connectedFile = path.join(stateDir, 'connected-clis.json');
const healthFile = path.join(stateDir, 'cli-auth-health.json');
const github = CLI_CATALOG.find(entry => entry.id === 'github')!;
const salesforce = CLI_CATALOG.find(entry => entry.id === 'salesforce')!;

function writeFixture(authStatus = 'ok') {
  fs.writeFileSync(connectedFile, JSON.stringify({ version: 'v1', entries: {
    github: { ...github, installedAt: checkedAt, name: privateMarker, vendor: privateMarker,
      authDocsUrl: privateMarker, authCommand: privateMarker, authProbe: { args: [privateMarker] },
      jobOutput: privateMarker, token: privateMarker },
    malformed: null,
    removed: { id: 'removed', command: 'removed', name: privateMarker },
  } }));
  fs.writeFileSync(healthFile, JSON.stringify({ version: 'v1', entries: {
    github: { id: 'github', command: 'gh', installed: true, authStatus, username: 'fixture-user', checkedAt,
      staleSince, lastProbeError: { exitCode: 9, timedOut: true, stderrHead: privateMarker, secret: privateMarker },
      connectionOrigin: privateMarker, rawOutput: privateMarker, token: privateMarker },
    salesforce: { id: 'salesforce', command: 'sf', installed: true, authStatus: 'error',
      checkedAt, issue: 'configuration_required' },
    'saved:fixture-unknown': { id: 'saved:fixture-unknown', command: 'fixture-unknown',
      installed: true, authStatus: 'unknown', checkedAt },
    signedOut: { id: 'signedOut', command: 'fixture-signed-out', installed: true, authStatus: 'signed_out',
      checkedAt, issue: 'credential_store_unavailable' },
    malformed: null,
    invalidStatus: { id: 'invalid', command: 'invalid', installed: true, checkedAt, authStatus: privateMarker },
  } }));
}

test('actual handler gates metadata before reading private fixture files', async (t) => {
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Unauthorized metadata read'); });
  syncBuiltinESMExports();
  assert.deepEqual(await request(false), { status: 401, body: { error: 'unauthorized' } });
});

test('actual handler projects safe catalog metadata and last-known health without work', async (t) => {
  writeFixture();
  const before = [fs.readFileSync(connectedFile, 'utf8'), fs.readFileSync(healthFile, 'utf8')];
  const assertNoWork = guardPolling(t);
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.connected, { github: {
    id: github.id, command: github.command, name: github.name, vendor: github.vendor, installedAt: checkedAt,
    authDocsUrl: github.authDocsUrl, ...(github.authCommand ? { authCommand: github.authCommand } : {}),
    ...(typeof github.authHeadless === 'boolean' ? { authHeadless: github.authHeadless } : {}),
  } });
  assert.deepEqual(result.body.saved, ['fixture-unknown', 'gh', 'sf']);
  assert.deepEqual(result.body.health.github, { id: 'github', command: 'gh', installed: true, authStatus: 'ok',
    username: 'fixture-user', checkedAt, staleSince, lastProbeError: { exitCode: 9, timedOut: true } });
  assert.equal(result.body.health.salesforce.issue, 'configuration_required');
  assert.equal(result.body.health.signedOut.authStatus, 'signed_out');
  assert.equal(result.body.health.signedOut.issue, 'credential_store_unavailable');
  assert.equal(result.body.health['saved:fixture-unknown'].authStatus, 'unknown');
  assert.equal(result.body.health.malformed, undefined);
  assert.equal(result.body.health.invalidStatus, undefined);
  assert.equal(result.body.authRequired[salesforce.id], true);
  assert.equal(result.body.authRequired[salesforce.command], true);
  assert.equal(result.body.authRequired[`saved:${salesforce.command}`], true);
  assert.equal(result.body.authRequired['fixture-unknown'], undefined, 'absence is unknown, never no-auth');
  assert.ok(Object.values(result.body.authRequired).every(value => value === true));
  for (const entry of CLI_CATALOG.filter(entry => !entry.authCommand && !entry.authProbe)) {
    assert.equal(result.body.authRequired[entry.id], undefined);
  }
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(privateMarker));
  assert.deepEqual([fs.readFileSync(connectedFile, 'utf8'), fs.readFileSync(healthFile, 'utf8')], before);
  assertNoWork();
});

test('second request observes newly persisted state without a refresh probe or write', async (t) => {
  writeFixture();
  const initial = await request();
  assert.equal(initial.body.health.github.authStatus, 'ok');
  writeFixture('signed_out');
  process.env.CLEMMY_SAVED_CLIS = 'sf,fixture-new';
  const before = [fs.readFileSync(connectedFile, 'utf8'), fs.readFileSync(healthFile, 'utf8')];
  const assertNoWork = guardPolling(t);
  const next = await request();
  assert.equal(next.status, 200);
  assert.equal(next.body.health.github.authStatus, 'signed_out');
  assert.deepEqual(next.body.saved, ['fixture-new', 'sf']);
  assert.deepEqual([fs.readFileSync(connectedFile, 'utf8'), fs.readFileSync(healthFile, 'utf8')], before);
  assertNoWork();
});

test('actual handler limits optional account names to bounded benign display text', async () => {
  const invalidNames: unknown[] = [
    '', 'fixture user', 'fixture\nuser', 'fixture\u0000user', 'fixture\u0085user',
    '/private/fixture-user', 'C:\\fixture\\user', 'https://viewer.invalid/private-capability',
    '<fixture-user>', 'x'.repeat(161), { rawOutput: privateMarker },
  ];
  for (const username of [...invalidNames, 'fixture-user', 'person+fixture@example.test', 'équipe.account']) {
    writeFixture();
    const persisted = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    persisted.entries.github.username = username;
    fs.writeFileSync(healthFile, JSON.stringify(persisted));
    const result = await request();
    assert.equal(result.status, 200);
    const expected = invalidNames.includes(username) ? undefined : username;
    assert.equal(result.body.health.github.username, expected);
    if (expected === undefined) {
      assert.equal(Object.hasOwn(result.body.health.github, 'username'), false, 'unsafe account display is omitted');
    }
  }
});

test('unexpected metadata errors return a generic message without private details', async () => {
  const entry = CLI_CATALOG[0]!;
  const prior = Object.getOwnPropertyDescriptor(entry, 'authCommand');
  try {
    Object.defineProperty(entry, 'authCommand', { configurable: true, get() { throw new Error(privateMarker); } });
    assert.deepEqual(await request(), { status: 500, body: { error: 'Could not read CLI connection state.' } });
  } finally {
    if (prior) Object.defineProperty(entry, 'authCommand', prior);
    else delete entry.authCommand;
  }
});
