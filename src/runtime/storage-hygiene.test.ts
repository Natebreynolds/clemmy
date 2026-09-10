import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reapDisposableRuntimeArtifacts } from './storage-hygiene.js';

function old(target: string, nowMs: number, days = 60): void {
  const at = new Date(nowMs - days * 24 * 60 * 60 * 1000);
  utimesSync(target, at, at);
}

test('storage hygiene removes only stale disposable artifacts', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-storage-hygiene-'));
  const nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  try {
    const diagnosticOld = path.join(home, 'state', 'codex-sse-truncated', 'old.json');
    const diagnosticFresh = path.join(home, 'state', 'codex-sse-truncated', 'fresh.json');
    mkdirSync(path.dirname(diagnosticOld), { recursive: true });
    writeFileSync(diagnosticOld, 'old-diagnostic');
    writeFileSync(diagnosticFresh, 'fresh-diagnostic');
    old(diagnosticOld, nowMs);

    const activeCache = path.join(home, 'state', 'mcp-npx-cache', 'active_server');
    const inactiveCache = path.join(home, 'state', 'mcp-npx-cache', 'removed-server');
    mkdirSync(activeCache, { recursive: true });
    mkdirSync(inactiveCache, { recursive: true });
    writeFileSync(path.join(activeCache, 'package.tgz'), 'keep-active');
    writeFileSync(path.join(inactiveCache, 'package.tgz'), 'drop-rebuildable');
    old(activeCache, nowMs);
    old(inactiveCache, nowMs);

    const olderHotpatch = path.join(home, 'hotpatch-backups', 'older');
    const newestHotpatch = path.join(home, 'hotpatch-backups', 'newest');
    mkdirSync(olderHotpatch, { recursive: true });
    mkdirSync(newestHotpatch, { recursive: true });
    writeFileSync(path.join(olderHotpatch, 'bundle'), 'old');
    writeFileSync(path.join(newestHotpatch, 'bundle'), 'newest');
    old(olderHotpatch, nowMs, 60);
    old(newestHotpatch, nowMs, 40);

    const result = reapDisposableRuntimeArtifacts({
      baseDir: home,
      activeMcpServerNames: ['Active Server'],
      nowMs,
    });
    assert.equal(existsSync(diagnosticOld), false, 'old diagnostics are reaped');
    assert.equal(existsSync(diagnosticFresh), true, 'fresh diagnostics survive');
    assert.equal(existsSync(activeCache), true, 'configured MCP cache survives regardless of age');
    assert.equal(existsSync(inactiveCache), false, 'stale unconfigured MCP cache is rebuildable and reaped');
    assert.equal(existsSync(olderHotpatch), false, 'older legacy hotpatch backup ages out');
    assert.equal(existsSync(newestHotpatch), true, 'newest rollback backup gets the longer safety window');
    assert.equal(result.removed, 3);
    assert.ok(result.bytesFreed > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('storage hygiene dry-run reports candidates without deleting them', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-storage-hygiene-dry-'));
  const nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  try {
    const file = path.join(home, 'state', 'codex-sse-truncated', 'old.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'diagnostic');
    old(file, nowMs);
    const result = reapDisposableRuntimeArtifacts({ baseDir: home, nowMs, dryRun: true });
    assert.equal(result.removed, 1);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a LIVE reap never touches canonical memory, vault, recordings, sessions, or active logs — even when ancient', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-storage-hygiene-canary-'));
  const nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  try {
    // Canaries: every canonical store the reaper must be structurally unable
    // to reach, all aged far past every threshold.
    const canaries = [
      path.join(home, 'state', 'memory.db'),
      path.join(home, 'state', 'secrets-vault.json'),
      path.join(home, 'state', 'machine-id'),
      path.join(home, 'state', 'curator', 'facts.json'),
      path.join(home, 'state', 'sessions', 'sess-1.json'),
      path.join(home, 'memory', 'tool-choices', 'machine-x', 'intent.md'),
      path.join(home, 'memory', 'tool-procedures', 'machine-x', 'tp-1.md'),
      path.join(home, 'recordings', 'meeting.wav'),
      path.join(home, 'logs', 'daemon.log'),
      path.join(home, 'workspaces', 'run-1', 'artifact.md'),
    ];
    for (const canary of canaries) {
      mkdirSync(path.dirname(canary), { recursive: true });
      writeFileSync(canary, 'canary');
      old(canary, nowMs, 400);
      old(path.dirname(canary), nowMs, 400);
    }

    // A symlink INSIDE a reapable root pointing at the vault: the reap may
    // unlink the LINK but must never delete the target through it.
    const diagRoot = path.join(home, 'state', 'codex-sse-truncated');
    mkdirSync(diagRoot, { recursive: true });
    const link = path.join(diagRoot, 'sneaky-link');
    symlinkSync(path.join(home, 'state', 'secrets-vault.json'), link);
    old(link, nowMs, 400);

    // One genuinely reapable artifact so we know the reap actually ran live.
    const disposable = path.join(diagRoot, 'old.json');
    writeFileSync(disposable, 'diagnostic');
    old(disposable, nowMs, 400);

    const result = reapDisposableRuntimeArtifacts({ baseDir: home, nowMs });
    assert.equal(existsSync(disposable), false, 'the reap ran live, not as a no-op');
    for (const canary of canaries) {
      assert.equal(existsSync(canary), true, `protected path must survive a live reap: ${canary}`);
    }
    assert.ok(result.removed >= 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Pre-migration rollback images (2026-09-10) ──────────────────────────────
// memory/db.ts writes one full VACUUM INTO copy every time the database crosses
// a schema boundary and, unlike the nightly backups next door, these were never
// pruned — so a long-lived install carries one whole-database copy per
// migration, forever, each larger than the last.
test('superseded pre-migration snapshots are reaped, newest few kept', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'clem-hygiene-snap-'));
  const dir = path.join(base, 'state', 'pre-migration-backups');
  mkdirSync(dir, { recursive: true });
  const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
  const names = [
    'memory-v30-to-v32-2026-01-01T00-00-00-000Z-p1-1.db',
    'memory-v32-to-v33-2026-02-01T00-00-00-000Z-p1-1.db',
    'memory-v33-to-v34-2026-03-01T00-00-00-000Z-p1-1.db',
    'memory-v34-to-v35-2026-04-01T00-00-00-000Z-p1-1.db',
    'memory-v35-to-v36-2026-05-01T00-00-00-000Z-p1-1.db',
  ];
  names.forEach((name, i) => {
    const file = path.join(dir, name);
    writeFileSync(file, 'x'.repeat(1024));
    // Oldest first in the list -> oldest mtime.
    utimesSync(file, new Date(old + i * 86_400_000), new Date(old + i * 86_400_000));
  });

  const result = reapDisposableRuntimeArtifacts({ baseDir: base });
  const removed = result.removals
    .filter((r) => r.kind === 'superseded_pre_migration_snapshot')
    .map((r) => path.basename(r.path));

  assert.equal(removed.length, 2, 'five snapshots, three retained');
  assert.ok(removed.includes(names[0]) && removed.includes(names[1]),
    'the two oldest boundaries go first');
  for (const keep of names.slice(2)) {
    assert.ok(existsSync(path.join(dir, keep)), `${keep} must be retained`);
  }
});

test('a recent pre-migration snapshot is never swept, even beyond the retain count', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'clem-hygiene-snap-fresh-'));
  const dir = path.join(base, 'state', 'pre-migration-backups');
  mkdirSync(dir, { recursive: true });
  // Ten snapshots, all written today: a migration that is still settling must
  // never have its rollback image removed out from under it.
  for (let i = 0; i < 10; i++) {
    writeFileSync(path.join(dir, `memory-v${i + 30}-to-v${i + 31}-2026-09-10T00-00-0${i}-000Z-p1-1.db`), 'x');
  }
  const result = reapDisposableRuntimeArtifacts({ baseDir: base });
  assert.equal(
    result.removals.filter((r) => r.kind === 'superseded_pre_migration_snapshot').length,
    0,
    'nothing younger than the minimum age may be reaped',
  );
});

test('database copies this code did not write are left alone', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'clem-hygiene-snap-foreign-'));
  const dir = path.join(base, 'state', 'pre-migration-backups');
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000);
  // Shapes observed in a real home, left by hand or by a script — not ours.
  for (const name of ['pre-schema70-20260830.db', 'harness-preprune-20260907-160744.db', 'notes.txt']) {
    const file = path.join(dir, name);
    writeFileSync(file, 'x');
    utimesSync(file, old, old);
  }
  const result = reapDisposableRuntimeArtifacts({ baseDir: base });
  assert.equal(
    result.removals.filter((r) => r.kind === 'superseded_pre_migration_snapshot').length,
    0,
    'reaping only what createPreMigrationMemorySnapshot writes keeps this sweep honest',
  );
});
