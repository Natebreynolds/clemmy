/** Run: npx tsx --test src/runtime/semantic-boundary/typed-source-process-recovery.test.ts */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const CHILD = new URL('./typed-source-process-child.mts', import.meta.url).pathname;

function spawnChild(home: string, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CHILD, home, 'run'], {
    env: { ...process.env, CLEMENTINE_HOME: home, CLEM_SESSION_ID: 'sess-process', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runInit(home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, home, 'init'], {
      env: { ...process.env, CLEMENTINE_HOME: home, CLEM_SESSION_ID: 'sess-process' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`init exited ${code}`));
    });
    child.on('error', reject);
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('wait timed out'));
      else setTimeout(tick, 15);
    };
    tick();
  });
}

function killHard(child: ChildProcess): void {
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
}

function store(home: string): { creates: number; artifact: { id: string; handle: string } | null } {
  const file = path.join(home, 'fake-provider.json');
  if (!existsSync(file)) return { creates: 0, artifact: null };
  return JSON.parse(readFileSync(file, 'utf8')) as {
    creates: number;
    artifact: { id: string; handle: string } | null;
  };
}

function openDb(home: string): Database.Database {
  return new Database(path.join(home, 'state', 'harness.db'));
}

function terminalCount(home: string): number {
  try {
    return (openDb(home).prepare(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'conversation_completed'`,
    ).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function hasReservation(home: string): boolean {
  try {
    return (openDb(home).prepare(
      `SELECT COUNT(*) AS n FROM physical_dispatches WHERE logical_tool_call_id = 'logical:op-write'`,
    ).get() as { n: number }).n > 0;
  } catch {
    return false;
  }
}

function hasHandleFor(home: string, logicalToolCallId: string): boolean {
  try {
    return (openDb(home).prepare(
      `SELECT COUNT(*) AS n FROM durable_result_handles
        WHERE logical_tool_call_id = ? AND raw_location IS NOT NULL`,
    ).get(logicalToolCallId) as { n: number }).n > 0;
  } catch {
    return false;
  }
}

function hasHandle(home: string): boolean {
  return hasHandleFor(home, 'logical:op-write');
}

function readLastResult(home: string): { status?: string; creates?: number; terminals?: number } {
  const file = path.join(home, 'last-result.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      result?: { status?: string };
      creates?: number;
      terminals?: number;
    };
    return { status: parsed.result?.status, creates: parsed.creates, terminals: parsed.terminals };
  } catch {
    return {};
  }
}

function collectResult(home: string, child: ChildProcess, timeoutMs = 15_000): Promise<{ status?: string; creates?: number; terminals?: number; text?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killHard(child);
      resolve({ ...readLastResult(home), text: 'timeout' });
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(readLastResult(home));
    });
  });
}

async function recover(home: string, extraEnv: Record<string, string> = {}) {
  const child = spawnChild(home, extraEnv);
  const result = await collectResult(home, child);
  return result;
}


// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19): live turns never run the
// semantic ceremony; typed execution enters only via the workflow-replay
// engine (future seam). Removed pins recoverable from this file's git
// history when the replay seam lands.
// ============================================================================

test('SIGKILL after reservation recovers with one write and one terminal', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-process-reservation-'));
  try {
    await runInit(home);
    const child = spawnChild(home, { CLEM_HANG_AFTER: 'reservation' });
    await waitFor(() => hasReservation(home) || child.exitCode !== null);
    killHard(child);
    await waitFor(() => child.exitCode !== null || child.killed);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const recovered = await recover(home);
    assert.ok(store(home).creates <= 1, JSON.stringify({ recovered, store: store(home) }));
    assert.equal(terminalCount(home), 1, JSON.stringify(recovered));
    assert.ok(
      recovered.status === 'completed' || recovered.status === 'uncertain' || recovered.status === 'failed',
      JSON.stringify(recovered),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});




