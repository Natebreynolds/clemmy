#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { startCutoverHoldServer, stopCutoverHoldServer } from '../channels/cutover-hold-server.js';
import { WEBHOOK_SECRET_IS_STRONG } from '../config.js';
import {
  CUTOVER_HOLD,
  CUTOVER_HOLD_HEARTBEAT_MS,
  recordCutoverHoldHeartbeat,
  requireValidCutoverHoldConfiguration,
} from '../runtime/cutover-hold.js';
import { describeBuild, requireHarnessSchemaReady } from '../runtime/build-info.js';
import {
  acquireDaemonLease,
  isDaemonRunning,
  readDaemonPid,
  registerShutdownHandlers,
  spawnDetachedDaemonEntrypoint,
  PID_FILE,
} from './process.js';
import { setDaemonRuntimePhase, startSupervisorIpcHeartbeat } from './phase.js';

const logger = pino({ name: 'clementine-next.cutover-hold' });
const START_HANDSHAKE_TIMEOUT_MS = 30_000;
const modulePath = fileURLToPath(import.meta.url);
let migrationChild: ChildProcess | null = null;

function requireHeldLaunch(): void {
  if (!CUTOVER_HOLD) {
    throw new Error('cutover-hold-entry requires CLEMMY_CUTOVER_HOLD=on at process start.');
  }
  requireValidCutoverHoldConfiguration();
  if (!WEBHOOK_SECRET_IS_STRONG) {
    throw new Error('Cutover hold requires a strong WEBHOOK_SECRET before lease or migration state is created.');
  }
}

function siblingEntrypoint(stem: string): string {
  const moduleDir = path.dirname(modulePath);
  const source = path.join(moduleDir, `${stem}.ts`);
  if (modulePath.endsWith('.ts') && existsSync(source)) return source;
  return path.join(moduleDir, `${stem}.js`);
}

function childNodeArgs(entrypoint: string): string[] {
  // Preserve loader/preload guards from the held parent. Source launches need
  // the inherited tsx loader; adversarial tests also use this to constrain the
  // short-lived migration child to the same no-network/no-delivery boundary.
  return [...process.execArgv, entrypoint];
}

async function runSchemaMigrationChild(): Promise<void> {
  const entrypoint = siblingEntrypoint('cutover-hold-migrate');
  const child = spawn(process.execPath, childNodeArgs(entrypoint), {
    env: {
      ...process.env,
      CLEMMY_CUTOVER_MIGRATION_PARENT_PID: String(process.pid),
    },
    stdio: 'inherit',
  });
  migrationChild = child;
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    migrationChild = null;
  });
  if (status.code !== 0) {
    throw new Error(
      `Cutover schema migration child failed (${status.signal ?? `exit ${String(status.code)}`}).`,
    );
  }
}

async function stopHeldRuntime(): Promise<void> {
  const child = migrationChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
  await stopCutoverHoldServer();
}

async function runForeground(): Promise<void> {
  requireHeldLaunch();
  if (!acquireDaemonLease(process.pid)) {
    throw new Error(`Another Clementine runtime owns the daemon lease (PID ${readDaemonPid() ?? 'unknown'}).`);
  }
  registerShutdownHandlers(stopHeldRuntime);
  startSupervisorIpcHeartbeat();
  setDaemonRuntimePhase('daemon.cutover_hold.schema_bootstrap', { cutoverHold: true });
  await runSchemaMigrationChild();
  const build = requireHarnessSchemaReady();
  await startCutoverHoldServer();
  setDaemonRuntimePhase('daemon.cutover_hold.ready', { cutoverHold: true, ingressReady: true });
  logger.warn({ build }, `Clementine daemon sealed for cutover: ${describeBuild(build)}`);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, CUTOVER_HOLD_HEARTBEAT_MS));
    recordCutoverHoldHeartbeat();
  }
}

function legacyPidProjection(): number | null {
  try {
    const value = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

async function launchDetached(): Promise<void> {
  requireHeldLaunch();
  const pid = spawnDetachedDaemonEntrypoint(modulePath, ['--foreground']);
  const deadline = Date.now() + START_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const owner = readDaemonPid();
    // Lease acquisition unlinks the legacy daemon.pid projection, publishes the
    // lease, then rewrites the projection. A launcher that reports "started"
    // on the lease alone lets a reader open daemon.pid inside that window
    // (2026-09-08: ENOENT under CPU contention, locally and on the release
    // runner). Report started only once the projection names this child too.
    if (owner === pid && isDaemonRunning() && legacyPidProjection() === pid) {
      console.log(`Held daemon started (PID ${pid}).`);
      return;
    }
    try { process.kill(pid, 0); } catch {
      throw new Error(`Held daemon ${pid} exited before acquiring the singleton lease.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Held daemon ${pid} did not acquire its lease within ${START_HANDSHAKE_TIMEOUT_MS / 1_000}s.`);
}

const command = process.argv[2] ?? 'start';
if (command === '--foreground') {
  await runForeground();
} else if (command === 'start') {
  await launchDetached();
} else {
  throw new Error('Usage: cutover-hold-entry [start|--foreground]');
}
