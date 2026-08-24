import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'cutover-test-secret-at-least-thirty-two-bytes-long';

function listFilesRecursively(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const target = path.join(dir, entry);
      if (statSync(target).isDirectory()) visit(target);
      else files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

async function waitForBuildInfo(port: number, child?: ChildProcess): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`held daemon exited before readiness (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/console/build-info`, {
        headers: { authorization: `Bearer ${SECRET}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return await response.json() as Record<string, unknown>;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`held daemon did not become ready: ${lastError}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function childProcessesOf(pid: number): Array<{ pid: number; command: string }> {
  if (process.platform === 'win32') return [];
  const probe = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  return probe.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || Number(match[2]) !== pid) return [];
    return [{ pid: Number(match[1]), command: match[3] }];
  });
}

test('cutover configuration refuses read-only, legacy, missing, and unknown engine selectors', () => {
  for (const selector of ['host_v1_read_only', 'legacy_sdk', '', 'future_engine']) {
    const probe = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { requireValidCutoverHoldConfiguration } from ${JSON.stringify(path.join(ROOT, 'src/runtime/cutover-hold.ts'))}; requireValidCutoverHoldConfiguration();`,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLEMMY_CUTOVER_HOLD: 'on',
          CLEMMY_TURN_ENGINE: selector,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(probe.status, 0, `selector ${JSON.stringify(selector)} unexpectedly passed`);
    assert.match(`${probe.stdout}${probe.stderr}`, /requires CLEMMY_TURN_ENGINE=host_v1/);
  }
});

test('held entry rejects missing or weak auth before lease or migration mutation', () => {
  for (const secret of ['', 'short-secret']) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cutover-weak-auth-'));
    try {
      const probe = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join(ROOT, 'src/daemon/cutover-hold-entry.ts'), 'start'],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            CLEMENTINE_HOME: home,
            CLEMMY_TEST_ISOLATED_HOME: '1',
            CLEMMY_CUTOVER_HOLD: 'on',
            CLEMMY_TURN_ENGINE: 'host_v1',
            WEBHOOK_PORT: '8420',
            WEBHOOK_SECRET: secret,
          },
          encoding: 'utf8',
        },
      );
      assert.notEqual(probe.status, 0, `weak secret ${JSON.stringify(secret)} unexpectedly launched`);
      assert.match(`${probe.stdout}${probe.stderr}`, /requires a strong WEBHOOK_SECRET/);
      assert.deepEqual(listFilesRecursively(home), [], 'auth refusal happens before lease or schema writes');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('migration helper refuses a direct invocation without the live parent lease', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cutover-direct-migrate-'));
  try {
    const probe = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'src/daemon/cutover-hold-migrate.ts')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLEMENTINE_HOME: home,
          CLEMMY_TEST_ISOLATED_HOME: '1',
          CLEMMY_CUTOVER_HOLD: 'on',
          CLEMMY_TURN_ENGINE: 'host_v1',
          CLEMMY_CUTOVER_MIGRATION_PARENT_PID: String(process.pid),
          WEBHOOK_SECRET: SECRET,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(probe.status, 0, 'standalone migration unexpectedly ran without a lease');
    assert.match(`${probe.stdout}${probe.stderr}`, /requires the live parent that owns the singleton daemon lease/);
    assert.deepEqual(listFilesRecursively(home), [], 'lease refusal happens before schema writes');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cutover daemon holds durable work inert and exposes only authenticated build attestation', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cutover-hold-'));
  const cacheHome = path.join(home, 'machine-cache');
  const daemonPort = await unusedPort();
  let trapRequests = 0;
  const trap = http.createServer((_req, res) => {
    trapRequests += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    trap.once('error', reject);
    trap.listen(0, '127.0.0.1', () => resolve());
  });
  const trapAddress = trap.address();
  assert.ok(trapAddress && typeof trapAddress === 'object');
  const trapUrl = `http://127.0.0.1:${trapAddress.port}`;

  const fixtureBytes = new Map<string, string>([
    [path.join(home, 'state', 'background-tasks', 'cutover-pending.json'), JSON.stringify({
      id: 'cutover-pending',
      status: 'pending',
      title: 'must remain pending',
    }, null, 2)],
    [path.join(home, 'workflows', 'runs', 'cutover-queued.json'), JSON.stringify({
      id: 'cutover-queued',
      status: 'queued',
      workflowName: 'cutover-scheduled-workflow',
    }, null, 2)],
    [path.join(home, 'cron', 'triggers', 'cutover-scheduled.json'), JSON.stringify({
      jobName: 'cutover-scheduled-job',
      triggeredAt: '2026-08-22T00:00:00.000Z',
    }, null, 2)],
    [path.join(home, 'state', 'resolved-approval-cutover.json'), JSON.stringify({
      approvalId: 'cutover-approved',
      status: 'approved',
      resolvedAt: '2026-08-22T00:00:00.000Z',
    }, null, 2)],
    [path.join(home, 'state', 'notifications.json'), JSON.stringify([{
      id: 'cutover-delivery',
      kind: 'system',
      title: 'must not deliver',
      body: 'queued before held boot',
      createdAt: '2026-08-22T00:00:00.000Z',
      read: false,
    }], null, 2)],
    [path.join(home, 'state', 'notification-destinations.json'), JSON.stringify([{
      id: 'cutover-trap',
      name: 'local dispatch trap',
      type: 'generic_webhook',
      url: `${trapUrl}/notification`,
      enabled: true,
      createdAt: '2026-08-22T00:00:00.000Z',
    }], null, 2)],
    [path.join(home, 'state', 'notification-delivery-queue.json'), JSON.stringify([{
      notificationId: 'cutover-delivery',
      queuedAt: '2026-08-22T00:00:00.000Z',
      completedDestinationIds: [],
      failedDestinationIds: [],
      attemptCountByDestination: {},
      nextAttemptAtByDestination: {},
      lastErrorByDestination: {},
    }], null, 2)],
    [path.join(home, 'state', 'guest-runs.json'), JSON.stringify([{
      id: 'cutover-running-guest',
      harness: 'claude',
      projectPath: '/tmp/cutover-guest-project',
      projectName: 'cutover-guest-project',
      prompt: 'must remain parked while held',
      status: 'running',
      finalMessage: '',
      changedFiles: [],
      startedAt: '2026-08-21T00:00:00.000Z',
      originSessionId: 'cutover-origin-session',
      lastEventAt: '2026-08-21T00:00:00.000Z',
    }], null, 2)],
  ]);
  for (const [file, bytes] of fixtureBytes) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, 'utf8');
  }

  let output = '';
  const childEnv = {
    ...process.env,
    CLEMENTINE_HOME: home,
    XDG_CACHE_HOME: cacheHome,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMMY_CUTOVER_HOLD: 'on',
    CLEMMY_CUTOVER_HOLD_HEARTBEAT_MS: '20',
    CLEMMY_TURN_ENGINE: 'host_v1',
    WEBHOOK_HOST: '0.0.0.0',
    WEBHOOK_PORT: String(daemonPort),
    WEBHOOK_SECRET: SECRET,
    WEBHOOK_ENABLED: 'true',
    DISCORD_ENABLED: 'true',
    DISCORD_BOT_TOKEN: '',
    SLACK_ENABLED: 'true',
    SLACK_BOT_TOKEN: '',
    SLACK_APP_TOKEN: '',
    CLEMENTINE_MOBILE_APP_LISTENER: 'on',
    CLEMMY_BOOT_WARMUP: 'on',
    CLEMMY_CLI_DISCOVERY_WARMUP: 'on',
    CLEMMY_MCP_PREWARM: 'all',
    MODEL_ROUTING_MODE: 'worker',
    BYO_MODEL_BASE_URL: `${trapUrl}/v1`,
    BYO_MODEL_API_KEY: 'cutover-fake-key',
    BYO_MODEL_ID: 'cutover-fake-model',
  } as NodeJS.ProcessEnv;
  // The isolated test runner normally disables local embeddings globally.
  // Remove every inherited escape hatch so this child proves the cutover
  // boundary itself suppresses the import-time ONNX/model warmup.
  delete childEnv.CLEMMY_LOCAL_EMBEDDINGS;
  delete childEnv.CLEMMY_EMBED_PROVIDER;
  delete childEnv.EMBEDDINGS_DISABLED;
  delete childEnv.OPENAI_API_KEY;

  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      path.join(ROOT, 'src/daemon/cutover-hold-adversarial-preload.mjs'),
      path.join(ROOT, 'src/daemon/cutover-hold-entry.ts'),
      '--foreground',
    ],
    {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });

  try {
    let build = await waitForBuildInfo(daemonPort, child);
    assert.equal(build.cutoverHold, true);
    assert.equal(build.effectiveFreshTurnEngine, 'host_v1');
    assert.equal(build.schemaVersion, build.expectedSchemaVersion);
    assert.equal(build.cutoverHoldProcessId, child.pid);

    const heartbeatDeadline = Date.now() + 5_000;
    while (Number(build.cutoverHoldHeartbeatCount ?? 0) < 2 && Date.now() < heartbeatDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      build = await waitForBuildInfo(daemonPort, child);
    }
    assert.ok(Number(build.cutoverHoldHeartbeatCount ?? 0) >= 2, 'held daemon crossed more than one inert heartbeat');

    const head = await fetch(`http://127.0.0.1:${daemonPort}/api/console/build-info`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const queryOnly = await fetch(
      `http://127.0.0.1:${daemonPort}/api/console/build-info?token=${encodeURIComponent(SECRET)}`,
    );
    assert.equal(queryOnly.status, 401, 'query/cookie bootstrap auth is unavailable during cutover');

    for (const [method, pathname] of [
      ['GET', '/api/status'],
      ['GET', '/m/api/runs'],
      ['POST', '/api/console/build-info'],
      ['POST', '/api/hooks/workflows/cutover'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${daemonPort}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(response.status, 503, `${method} ${pathname} must be sealed`);
      assert.equal(response.headers.get('retry-after'), '5');
    }

    for (const [file, bytes] of fixtureBytes) {
      assert.equal(readFileSync(file, 'utf8'), bytes, `${path.relative(home, file)} changed while held`);
    }
    assert.equal(trapRequests, 0, 'no model warmup, provider poll, or notification delivery reached the trap');
    assert.equal(
      existsSync(path.join(cacheHome, 'clementine', 'transformers')),
      false,
      'held import must not start the eager local-model loader or create its machine cache',
    );
    assert.doesNotMatch(output, /local embedding provider loaded|local embedding provider unavailable/);
    assert.doesNotMatch(output, /\[cutover-adversarial-guard\]/);
    const unexpectedFiles = listFilesRecursively(home).filter((file) => {
      if (fixtureBytes.has(file)) return false;
      const relative = path.relative(home, file);
      return relative !== 'daemon.pid'
        && !relative.startsWith(`daemon.lock${path.sep}owner-`)
        && !/^state\/harness\.db(?:-(?:wal|shm|journal))?$/.test(relative);
    });
    assert.deepEqual(unexpectedFiles, [], 'held boot created state outside its lease and harness schema');
    assert.doesNotMatch(output, /Discord bot ready|Slack bot ready|MCP pre-warm complete|boot warmup: model path warmed/);
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('held start detaches the exact foreground entry, owns its port and lease, and shuts down cleanly', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cutover-detached-'));
  const daemonPort = await unusedPort();
  const entry = path.join(ROOT, 'src/daemon/cutover-hold-entry.ts');
  const preload = pathToFileURL(path.join(ROOT, 'src/daemon/cutover-hold-adversarial-preload.mjs')).href;
  const childEnv = {
    ...process.env,
    CLEMENTINE_HOME: home,
    XDG_CACHE_HOME: path.join(home, 'machine-cache'),
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMMY_CUTOVER_HOLD: 'on',
    CLEMMY_TURN_ENGINE: 'host_v1',
    WEBHOOK_HOST: '0.0.0.0',
    WEBHOOK_PORT: String(daemonPort),
    WEBHOOK_SECRET: SECRET,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
  } as NodeJS.ProcessEnv;
  delete childEnv.CLEMMY_LOCAL_EMBEDDINGS;
  delete childEnv.CLEMMY_EMBED_PROVIDER;
  delete childEnv.EMBEDDINGS_DISABLED;
  delete childEnv.OPENAI_API_KEY;

  let heldPid: number | null = null;
  try {
    const launcher = spawnSync(
      process.execPath,
      ['--import', 'tsx', entry, 'start'],
      { cwd: ROOT, env: childEnv, encoding: 'utf8', timeout: 45_000 },
    );
    assert.equal(launcher.status, 0, `${launcher.stdout}${launcher.stderr}`);
    assert.match(launcher.stdout, /Held daemon started \(PID \d+\)\./);

    heldPid = Number.parseInt(readFileSync(path.join(home, 'daemon.pid'), 'utf8').trim(), 10);
    assert.ok(Number.isSafeInteger(heldPid) && heldPid > 0, 'launcher published a valid daemon PID');
    const ownerFiles = readdirSync(path.join(home, 'daemon.lock'));
    assert.equal(ownerFiles.length, 1, 'exactly one lease owner is published');
    const lease = JSON.parse(readFileSync(path.join(home, 'daemon.lock', ownerFiles[0]), 'utf8')) as { pid?: unknown };
    assert.equal(lease.pid, heldPid, 'lease owner and compatibility PID projection agree');

    const build = await waitForBuildInfo(daemonPort);
    assert.equal(build.cutoverHold, true);
    assert.equal(build.effectiveFreshTurnEngine, 'host_v1');
    assert.equal(build.cutoverHoldProcessId, heldPid, 'authenticated port owner is the exact lease owner');
    assert.equal(path.resolve(String(build.entry)), entry, 'attested entry is the dedicated held foreground');
    assert.equal(build.schemaVersion, build.expectedSchemaVersion);
    assert.deepEqual(childProcessesOf(heldPid), [], 'migration child exited before held ingress became ready');

    const command = process.platform === 'win32'
      ? ''
      : spawnSync('ps', ['-p', String(heldPid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
    if (process.platform !== 'win32') {
      assert.match(command, /cutover-hold-entry\.(?:ts|js).*--foreground/);
    }

    process.kill(heldPid, 'SIGTERM');
    assert.equal(await waitForProcessExit(heldPid), true, 'held foreground exits after SIGTERM');
    assert.deepEqual(childProcessesOf(heldPid), [], 'held shutdown leaves no migration child');
    await assert.rejects(
      fetch(`http://127.0.0.1:${daemonPort}/api/console/build-info`, {
        headers: { authorization: `Bearer ${SECRET}` },
        signal: AbortSignal.timeout(500),
      }),
      'held listener closes with its lease owner',
    );
    heldPid = null;

    const output = readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8');
    assert.doesNotMatch(output, /\[cutover-adversarial-guard\]/);
    const unexpectedFiles = listFilesRecursively(home).filter((file) => {
      const relative = path.relative(home, file);
      return relative !== 'daemon.pid'
        && relative !== path.join('logs', 'daemon.log')
        && !relative.startsWith(`daemon.lock${path.sep}owner-`)
        && !/^state\/harness\.db(?:-(?:wal|shm|journal))?$/.test(relative);
    });
    assert.deepEqual(unexpectedFiles, [], 'detached held boot writes only lease, log, and harness schema state');
  } finally {
    if (heldPid && processIsAlive(heldPid)) {
      try { process.kill(heldPid, 'SIGTERM'); } catch { /* already gone */ }
      if (!await waitForProcessExit(heldPid, 5_000)) {
        try { process.kill(heldPid, 'SIGKILL'); } catch { /* already gone */ }
        await waitForProcessExit(heldPid, 2_000);
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
