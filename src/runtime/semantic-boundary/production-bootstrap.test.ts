/** Run: npx tsx --test src/runtime/semantic-boundary/production-bootstrap.test.ts */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import {
  FIVE_ROWS,
  SHEET_HANDLE,
  loadBootstrapProviderStore,
  restaurantManifests,
} from './production-bootstrap-fixtures.js';
import { capabilityManifestDigest } from '../harness/capability-manifest.js';

const CHILD = new URL('./production-bootstrap-child.mts', import.meta.url).pathname;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function spawnChild(home: string, command: string, extra: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CHILD, home, command], {
    env: {
      ...process.env,
      CLEMENTINE_HOME: home,
      CLEMENTINE_SEMANTIC_CLAIM_WAIT_MS: '400',
      CLEMENTINE_GRAPH_LEASE_TTL_MS: extra.CLEMENTINE_GRAPH_LEASE_TTL_MS ?? '800',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(path.dirname(CHILD), '../../..'),
  });
}

function collect(home: string, child: ChildProcess, timeoutMs = 25_000): Promise<{
  status?: string;
  creates?: number;
  terminals?: number;
  error?: string | null;
  artifact?: { handle?: string; content?: unknown } | null;
  catalogSize?: number;
  text?: string;
}> {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      resolve({ ...readLast(home), text: `timeout ${stderr}` });
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ ...readLast(home), text: stderr });
    });
  });
}

function readLast(home: string) {
  const file = path.join(home, 'last-result.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as {
      status?: string;
      creates?: number;
      terminals?: number;
      error?: string | null;
      artifact?: { handle?: string; content?: unknown } | null;
      catalogSize?: number;
    };
  } catch {
    return {};
  }
}

async function provision(
  home: string,
  command = 'provision',
  extra: Record<string, string> = {},
): Promise<void> {
  const child = spawnChild(home, command, extra);
  const result = await collect(home, child, 20_000);
  if (!existsSync(path.join(home, 'provisioned'))) {
    throw new Error(`provision failed: ${JSON.stringify(result)}`);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('wait timed out'));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

function killHard(child: ChildProcess): void {
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
}

function openDb(home: string): Database.Database {
  return new Database(path.join(home, 'state', 'harness.db'));
}



// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19): live turns never run the
// semantic ceremony; typed execution enters only via the workflow-replay
// engine (future seam). Removed pins recoverable from this file's git
// history when the replay seam lands.
// ============================================================================

test('production bootstrap: calendar-only catalog cannot satisfy the sheet request', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-prod-cal-'));
  try {
    await provision(home, 'provision-calendar', { CLEMENTINE_PRODUCTION_CATALOG: '0' });
    const child = spawnChild(home, 'calendar', { CLEMENTINE_PRODUCTION_CATALOG: '0' });
    const result = await collect(home, child);
    assert.notEqual(result.status, 'completed', JSON.stringify(result));
    assert.equal(loadBootstrapProviderStore(home).creates, 0, JSON.stringify(result));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production bootstrap: same-ID manifest drift makes zero calls', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-prod-drift-'));
  try {
    await provision(home);
    const dest = restaurantManifests().find((item) => item.effect === 'external_write');
    assert.ok(dest);
    const drifted = {
      ...dest,
      definitionFingerprint: sha256('live:sheet_create:drifted'),
    };
    const db = openDb(home);
    db.prepare(
      `UPDATE capability_manifests SET digest = ?, manifest_json = ? WHERE manifest_id = ?`,
    ).run(capabilityManifestDigest(drifted), JSON.stringify(drifted), dest.manifestId);
    db.close();
    const child = spawnChild(home, 'run');
    const result = await collect(home, child);
    assert.notEqual(result.status, 'completed', JSON.stringify(result));
    assert.equal(loadBootstrapProviderStore(home).creates, 0, JSON.stringify(result));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production bootstrap: unclaimed semantic event makes zero calls', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-prod-unclaimed-'));
  try {
    await provision(home);
    const child = spawnChild(home, 'unclaimed');
    const result = await collect(home, child);
    assert.notEqual(result.status, 'completed', JSON.stringify(result));
    assert.equal(loadBootstrapProviderStore(home).creates, 0, JSON.stringify(result));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('GAP PIN: no pre-dispatch correlation identity exists yet, so lost-response auto-recovery must stay unclaimed', async () => {
  // This pin is DESIGNED to fail the moment someone begins the correlation
  // identity work, forcing them to also flip the honest-uncertain pin above to
  // full auto-recovery. Two facts hold today:
  const { productionCapabilityManifests } = await import('../harness/production-capability-catalog.js');
  const write = productionCapabilityManifests().find((entry) => entry.effect === 'external_write');
  assert.ok(write, 'a production write template exists');
  // 1. Production write templates truthfully declare recovery unsupported —
  //    the real provider contract cannot locate a lost artifact.
  assert.equal(write!.reconciliation.supported, false,
    'reconciliation.supported flipped true: finish auto-recovery and re-pin the crash test above');
  // 2. The idempotency contract carries no key material; a manifest cannot
  //    smuggle a correlation identity through a closed field set.
  assert.deepEqual(Object.keys(write!.idempotency).sort(), ['policy', 'required'],
    'idempotency gained a field: wire it through sealed args and the reconcile probe, then re-pin');
});
