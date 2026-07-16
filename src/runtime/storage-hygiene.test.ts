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
