/** Controlled resolver/process fixtures only: never invoke GitHub or sign in. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import childProcess, { type ChildProcess, type spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import type { CliProbeProcessResult } from '../runtime/cli-probe-process.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-github-probe-'));
const previousHome = process.env.CLEMENTINE_HOME;
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
// Install before loading the public helper: cli-spawn captures its platform
// substrate once. Both the old direct spawn and the shared probe substrate
// must terminate at this controlled boundary; no actual executable may run.
let publicSpawn: ((binary: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess) | undefined;
const spawnHook = mock.method(childProcess, 'spawn', (...args: unknown[]) => {
  if (!publicSpawn) throw new Error('No real CLI may run in this test file');
  return publicSpawn(String(args[0]), args[1] as string[], args[2] as Record<string, unknown>);
});
syncBuiltinESMExports();
const { _testOnly_createGitHubCliClient: createClient, findGitHubCli, getGitHubCliStatus } = await import('./github-cli.js');
const { createCliProbeRunner } = await import('../runtime/cli-probe-process.js');
after(() => {
  spawnHook.mock.restore();
  syncBuiltinESMExports();
  if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function result(stdout = '', extra: Partial<CliProbeProcessResult> = {}): CliProbeProcessResult {
  return { stdout, stderr: '', output: stdout, exitCode: 0, timedOut: false, ...extra };
}

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 2345, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref() {},
  }) as unknown as ChildProcess;
}

test('GitHub public status honors the declared CLI profile rather than the raw parent environment', async t => {
  const binary = path.join(home, process.platform === 'win32' ? 'public-gh.exe' : 'public-gh');
  // Native Windows resolution checks stat as well as access. These are inert
  // fixture bytes: the guarded spawn boundary above owns every launch.
  writeFileSync(binary, 'controlled executable fixture', { mode: 0o700 });
  const previousBinary = process.env.GITHUB_CLI_PATH;
  const previousProfile = process.env.GH_CONFIG_DIR;
  const cliEnv = path.join(home, 'state', 'cli-env.json');
  const seen: Array<{ binary: string; profile: string | undefined }> = [];
  const access = t.mock.method(fs, 'accessSync', candidate => {
    if (candidate !== binary) throw Object.assign(new Error('controlled unavailable path'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  publicSpawn = (selected, args, options) => {
    const env = options.env as NodeJS.ProcessEnv;
    seen.push({ binary: selected, profile: env.GH_CONFIG_DIR });
    const owned = Object.assign(child(), { pid: undefined });
    queueMicrotask(() => {
      owned.stdout!.emit('data', Buffer.from(args[0] === '--version' ? 'gh controlled'
        : `Logged in to github.com account ${env.GH_CONFIG_DIR}`));
      owned.emit('close', 0);
    });
    return owned;
  };
  try {
    process.env.GITHUB_CLI_PATH = binary;
    process.env.GH_CONFIG_DIR = 'parent-profile';
    writeFileSync(cliEnv, JSON.stringify({ GH_CONFIG_DIR: 'declared-profile' }));
    const status = await getGitHubCliStatus();
    assert.equal(status.path, binary);
    assert.equal(status.username, 'declared-profile');
    assert.deepEqual(seen, [{ binary, profile: 'declared-profile' }, { binary, profile: 'declared-profile' }]);
  } finally {
    publicSpawn = undefined;
    access.mock.restore(); syncBuiltinESMExports();
    if (previousBinary === undefined) delete process.env.GITHUB_CLI_PATH; else process.env.GITHUB_CLI_PATH = previousBinary;
    if (previousProfile === undefined) delete process.env.GH_CONFIG_DIR; else process.env.GH_CONFIG_DIR = previousProfile;
    rmSync(cliEnv, { force: true });
  }
});

test('GitHub public status cannot attach a later executable account to the first selected path', async t => {
  const first = path.join(home, process.platform === 'win32' ? 'public-a.exe' : 'public-a');
  const later = path.join(home, process.platform === 'win32' ? 'public-b.exe' : 'public-b');
  for (const file of [first, later]) writeFileSync(file, 'controlled executable fixture', { mode: 0o700 });
  const previousBinary = process.env.GITHUB_CLI_PATH;
  const selected: string[] = [];
  const access = t.mock.method(fs, 'accessSync', candidate => {
    if (candidate !== first && candidate !== later) throw Object.assign(new Error('controlled unavailable path'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  publicSpawn = (binary, args) => {
    selected.push(binary);
    process.env.GITHUB_CLI_PATH = later;
    const owned = Object.assign(child(), { pid: undefined });
    queueMicrotask(() => {
      owned.stdout!.emit('data', Buffer.from(args[0] === '--version' ? 'gh controlled'
        : `Logged in to github.com account ${binary === first ? 'account-a' : 'account-b'}`));
      owned.emit('close', 0);
    });
    return owned;
  };
  try {
    process.env.GITHUB_CLI_PATH = first;
    const status = await getGitHubCliStatus();
    assert.equal(status.path, first);
    assert.equal(status.username, 'account-a');
    assert.deepEqual(selected, [first, first], 'both probes must execute the path returned with their account verdict');
  } finally {
    publicSpawn = undefined;
    access.mock.restore(); syncBuiltinESMExports();
    if (previousBinary === undefined) delete process.env.GITHUB_CLI_PATH; else process.env.GITHUB_CLI_PATH = previousBinary;
  }
});

test('GitHub rich status binds both probes and returned identity to one immutable executable/environment snapshot', async () => {
  let binary = '/controlled/bin-a/gh';
  let resolutions = 0;
  let environments = 0;
  const callerEnv = { GH_CONFIG_DIR: 'profile-a', PATH: '/controlled/bin-a' };
  const calls: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const client = createClient({
    platform: 'linux', resolve: () => { resolutions++; return binary; },
    environment: () => { environments++; return callerEnv; }, cwd: () => '/controlled/home',
    probe: async (selected, args, options) => {
      calls.push({ binary: selected, args, env: options.env });
      assert.equal(options.cwd, '/controlled/home');
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.equal(Object.isFrozen(options.env), true);
      if (calls.length === 1) {
        binary = '/controlled/bin-b/gh';
        callerEnv.GH_CONFIG_DIR = 'profile-b';
        assert.equal(Reflect.set(options.env, 'GH_CONFIG_DIR', 'caller-poison'), false);
      }
      return result(args[0] === '--version' ? 'gh version controlled' : `Logged in to github.com account ${options.env.GH_CONFIG_DIR}`);
    },
  });
  const first = await client.getGitHubCliStatus();
  assert.equal(resolutions, 1);
  assert.equal(environments, 1);
  assert.deepEqual(calls.map(call => call.binary), ['/controlled/bin-a/gh', '/controlled/bin-a/gh']);
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['auth', 'status', '-h', 'github.com']]);
  assert.equal(calls[0]!.env, calls[1]!.env);
  assert.equal(calls[0]!.env.GH_CONFIG_DIR, 'profile-a');
  assert.equal(first.path, '/controlled/bin-a/gh');
  assert.equal(first.authStatus, 'ok');
  assert.equal(first.username, 'profile-a');
  const second = await client.getGitHubCliStatus();
  assert.equal(resolutions, 2);
  assert.equal(environments, 2);
  assert.equal(second.path, '/controlled/bin-b/gh');
  assert.equal(second.username, 'profile-b');
  assert.equal(calls[0]!.env.GH_CONFIG_DIR, 'profile-a', 'a later call cannot relabel the first observation');
});

test('GitHub rich status uses current declared CLI profile once and does not copy the private daemon file', async () => {
  const originalProfile = process.env.GH_CONFIG_DIR;
  const privateKey = 'CLEMMY_GITHUB_CONTROLLED_PRIVATE';
  const originalPrivate = process.env[privateKey];
  const cliEnv = path.join(home, 'state', 'cli-env.json');
  const daemonEnv = path.join(home, '.env');
  const snapshots: NodeJS.ProcessEnv[] = [];
  let changed = false;
  try {
    process.env.GH_CONFIG_DIR = 'parent-profile';
    delete process.env[privateKey];
    writeFileSync(cliEnv, JSON.stringify({ GH_CONFIG_DIR: 'declared-a', Path: 'refused-user-path' }));
    writeFileSync(daemonEnv, `${privateKey}=synthetic-file-only-value\n`);
    const client = createClient({
      resolve: () => process.execPath,
      probe: async (_binary, args, options) => {
        snapshots.push(options.env);
        assert.equal(options.env[privateKey], undefined);
        assert.notEqual(options.env.PATH, 'refused-user-path');
        if (!changed) {
          changed = true;
          process.env.GH_CONFIG_DIR = 'changed-parent-profile';
          writeFileSync(cliEnv, JSON.stringify({ GH_CONFIG_DIR: 'declared-b' }));
        }
        return result(args[0] === '--version' ? 'gh controlled' : `Logged in to github.com account ${options.env.GH_CONFIG_DIR}`);
      },
    });
    const first = await client.getGitHubCliStatus();
    assert.equal(first.username, 'declared-a');
    assert.equal(snapshots[0], snapshots[1]);
    assert.equal(snapshots[1]!.GH_CONFIG_DIR, 'declared-a');
    const next = await client.getGitHubCliStatus();
    assert.equal(next.username, 'declared-b');
    assert.equal(snapshots[2], snapshots[3]);
    assert.notEqual(snapshots[0], snapshots[2]);
  } finally {
    if (originalProfile === undefined) delete process.env.GH_CONFIG_DIR; else process.env.GH_CONFIG_DIR = originalProfile;
    if (originalPrivate === undefined) delete process.env[privateKey]; else process.env[privateKey] = originalPrivate;
    rmSync(cliEnv, { force: true });
    rmSync(daemonEnv, { force: true });
  }
});

test('GitHub missing or ambiguous executable provenance starts no probe or environment capture', async () => {
  for (const [platform, binary] of [
    ['linux', null], ['linux', 'relative/gh'], ['linux', '/controlled/gh\n'],
    ['win32', 'C:relative\\gh.exe'], ['win32', '\\rooted\\gh.exe'],
  ] as const) {
    let probes = 0;
    let environments = 0;
    const client = createClient({ platform, resolve: () => binary,
      environment: () => { environments++; return {}; }, probe: async () => { probes++; return result(); } });
    assert.deepEqual(await client.getGitHubCliStatus(), {
      installed: false, path: null, version: null, authenticated: false, username: null, authStatus: 'missing',
      authMessage: 'Install GitHub CLI to clone private skill repos and use GitHub tools locally.',
    });
    assert.deepEqual(await client.runGitHubCli(['auth', 'status']), {
      ok: false, stdout: '', stderr: 'GitHub CLI is not installed.', exitCode: null, timedOut: false,
    });
    assert.equal(probes, 0);
    assert.equal(environments, 0);
  }
});

test('GitHub standalone helper preserves literal argv/result shape and captures a fresh context per call', async () => {
  let binary = '/controlled/a/gh';
  const env = { GH_CONFIG_DIR: 'profile-a' };
  const seen: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }> = [];
  const client = createClient({ platform: 'linux', resolve: () => binary, environment: () => env,
    probe: async (selected, args, options) => {
      seen.push({ binary: selected, args, env: options.env, timeout: options.timeoutMs });
      return result('controlled output', { stderr: 'controlled diagnostic' });
    } });
  const args = ['repo', 'view', 'literal ; $() | *', 'café 日本語'];
  const pending = client.runGitHubCli(args, 321);
  args.push('caller-late-value');
  const first = await pending;
  assert.deepEqual(first, { ok: true, stdout: 'controlled output', stderr: 'controlled diagnostic', exitCode: 0, timedOut: false });
  assert.deepEqual(seen[0]!.args, ['repo', 'view', 'literal ; $() | *', 'café 日本語']);
  assert.equal(seen[0]!.timeout, 321);
  binary = '/controlled/b/gh'; env.GH_CONFIG_DIR = 'profile-b';
  await client.runGitHubCli(['--version']);
  assert.equal(seen[1]!.binary, '/controlled/b/gh');
  assert.equal(seen[1]!.env.GH_CONFIG_DIR, 'profile-b');
  assert.equal(seen[0]!.env.GH_CONFIG_DIR, 'profile-a');
  assert.equal(seen[1]!.timeout, 8_000);
});

for (const [label, version] of [
  ['timeout', result('gh partial', { timedOut: true })],
  ['overflow', result('gh partial', { overflowed: true })],
  ['cleanup uncertain', result('gh partial', { cleanupIncomplete: true })],
] as const) {
  test(`GitHub rich status cannot qualify successful auth while its version probe has ${label}`, async () => {
    const client = createClient({ resolve: () => process.execPath, environment: () => ({}),
      probe: async (_binary, args) => args[0] === '--version' ? version : result('Logged in to github.com account fixture-user') });
    const status = await client.getGitHubCliStatus();
    assert.equal(status.installed, true);
    assert.equal(status.path, process.execPath);
    assert.equal(status.authenticated, false, 'one completed sibling does not settle an incomplete owned process');
    assert.equal(status.authStatus, 'error');
    assert.equal(status.username, null);
    assert.equal(status.version, null);
    assert.doesNotMatch(status.authMessage ?? '', /fixture-user|Logged in/);
  });
}

test('GitHub rich status retains completed auth when only a completed version command returns nonzero', async () => {
  const client = createClient({ resolve: () => process.execPath, environment: () => ({}),
    probe: async (_binary, args) => args[0] === '--version'
      ? result('', { exitCode: 1 }) : result('Logged in to github.com account fixture-user') });
  const status = await client.getGitHubCliStatus();
  assert.equal(status.authenticated, true);
  assert.equal(status.username, 'fixture-user');
  assert.equal(status.authStatus, 'ok');
});

for (const [label, auth, expected] of [
  ['signed out', result('', { exitCode: 1, stderr: 'not logged into github.com' }), 'invalid'],
  ['network failure', result('account unverified', { exitCode: 1, stderr: 'connection unavailable' }), 'error'],
  ['timeout', result('account partial', { exitCode: 0, timedOut: true, stderr: 'token is invalid' }), 'error'],
  ['overflow', result('account partial', { exitCode: 0, overflowed: true, stderr: 'not authenticated' }), 'error'],
  ['cleanup uncertain', result('account partial', { exitCode: 0, cleanupIncomplete: true, stderr: 'not authenticated' }), 'error'],
] as const) {
  test(`GitHub rich status keeps ${label} separate from a completed healthy account`, async () => {
    const client = createClient({ resolve: () => process.execPath, environment: () => ({}),
      probe: async (_binary, args) => args[0] === '--version' ? result('gh controlled') : auth });
    const status = await client.getGitHubCliStatus();
    assert.equal(status.path, process.execPath);
    assert.equal(status.authStatus, expected);
    assert.equal(status.authenticated, false);
    assert.equal(status.username, null);
    assert.deepEqual(Object.keys(status).sort(),
      ['installed', 'path', 'version', 'authenticated', 'username', 'authStatus', 'authMessage'].sort());
  });
}

test('GitHub selected Windows launcher uses the existing literal-argv process substrate', async () => {
  const run = createCliProbeRunner();
  const selected = 'C:\\Controlled & café\\gh.cmd';
  const calls: string[][] = [];
  const client = createClient({ platform: 'win32', resolve: () => selected,
    environment: () => ({ SystemRoot: 'C:\\Windows' }), cwd: () => 'C:\\Controlled Home',
    probe: (binary, args, options) => run(binary, args, { ...options,
      spawnProcess: ((command, argv, launch) => {
        assert.equal(command, selected);
        assert.equal(launch?.shell, undefined);
        assert.equal(launch?.windowsHide, true);
        assert.equal(launch?.cwd, 'C:\\Controlled Home');
        calls.push(argv as string[]);
        const owned = child();
        queueMicrotask(() => {
          owned.stdout!.emit('data', Buffer.from(args[0] === '--version' ? 'gh controlled' : 'Logged in to github.com account controlled'));
          owned.emit('close', 0);
        });
        return owned;
      }) as typeof spawn,
    }),
  });
  const status = await client.getGitHubCliStatus();
  assert.equal(status.path, selected);
  assert.equal(status.username, 'controlled');
  assert.deepEqual(calls, [['--version'], ['auth', 'status', '-h', 'github.com']]);
});

test('GitHub shared Windows cleanup waits for the exact tree receipt and latches incomplete cleanup', async () => {
  const run = createCliProbeRunner();
  const owned = child();
  let selected = 'C:\\Controlled\\gh.cmd';
  let spawns = 0;
  let finishStop: ((value: 'incomplete') => void) | undefined;
  let returned = false;
  const client = createClient({ platform: 'win32', resolve: () => selected,
    environment: () => ({ SystemRoot: 'C:\\Windows' }),
    probe: (binary, args, options) => run(binary, args, { ...options,
      spawnProcess: (() => { spawns++; return owned; }) as typeof spawn,
      stopWindowsTree: async target => {
        assert.equal(target, owned);
        return new Promise(resolve => { finishStop = resolve; });
      },
    }),
  });
  const pending = client.runGitHubCli(['auth', 'status'], 5).then(value => { returned = true; return value; });
  owned.stdout!.emit('data', Buffer.from('account partial'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(finishStop);
  assert.equal(returned, false, 'a deadline does not abandon a running child tree');
  owned.emit('close', 0);
  finishStop('incomplete');
  const stopped = await pending;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stdout, '');
  assert.equal(stopped.exitCode, null);
  assert.equal(stopped.timedOut, true);
  selected = 'c:\\CONTROLLED\\GH.CMD';
  const blocked = await client.runGitHubCli(['auth', 'status'], 5);
  assert.equal(spawns, 1);
  assert.equal(blocked.ok, false);
  assert.match(blocked.stderr, /restart Clementine/);
});

test('GitHub shared spawn failure remains unknown without returning private process errors as account data', async () => {
  const run = createCliProbeRunner();
  const client = createClient({ resolve: () => process.execPath, environment: () => ({}),
    probe: (binary, args, options) => run(binary, args, { ...options,
      spawnProcess: (() => { throw new Error('synthetic-private-process-detail'); }) as typeof spawn,
    }),
  });
  const status = await client.getGitHubCliStatus();
  assert.equal(status.authStatus, 'error');
  assert.equal(status.authenticated, false);
  assert.equal(status.username, null);
  assert.doesNotMatch(status.authMessage ?? '', /synthetic-private-process-detail/);
});

test('GitHub explicit relative lookup becomes the absolute selected path before the child cwd changes', () => {
  const file = path.join(home, process.platform === 'win32' ? 'controlled-gh.exe' : 'controlled-gh');
  writeFileSync(file, 'controlled non-executed fixture');
  chmodSync(file, 0o700);
  const previous = process.env.GITHUB_CLI_PATH;
  try {
    process.env.GITHUB_CLI_PATH = path.relative(process.cwd(), file);
    assert.equal(findGitHubCli(), file);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_CLI_PATH; else process.env.GITHUB_CLI_PATH = previous;
  }
});
