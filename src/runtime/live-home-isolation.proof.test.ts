/** Run: node scripts/run-tests-isolated.mjs src/runtime/live-home-isolation.proof.test.ts */
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  compareLiveHome,
  liveHomeOwnerPids,
  realDefaultClementineHome,
  snapshotLiveHome,
} from '../../scripts/live-home-sentinel.mjs';

const before = snapshotLiveHome();
// A developer machine usually has a live daemon rewriting its own databases
// throughout this file. Byte equality therefore reported an escape on every
// overlapping run; compareLiveHome attributes that churn to the owner it
// sampled, while keeping secrets, auth, identity and contracts inviolable.
const owners = liveHomeOwnerPids();

/** Could only reach the live home by escaping isolation. */
const ESCAPE_CANARY = `CLEMMY_ISOLATION_CANARY_${process.pid}_${Date.now()}`;

function liveHomeFilesMatching(needle: string): string[] {
  const root = path.join(realDefaultClementineHome(), 'memory', 'tool-contracts');
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.includes(needle)) { found.push(full); continue; }
      try { if (statSync(full).isDirectory()) walk(full); } catch { /* raced */ }
    }
  };
  walk(root);
  return found;
}

test('isolated tests do not read workspace credential env files', async () => {
  const { ACTIVE_ENV_FILES, PKG_DIR } = await import('../config.js');
  const workspaceEnv = path.resolve(path.join(PKG_DIR, '.env'));
  const cwdEnv = path.resolve(path.join(process.cwd(), '.env'));
  assert.equal(ACTIVE_ENV_FILES.some((file) => path.resolve(file) === workspaceEnv), false);
  assert.equal(ACTIVE_ENV_FILES.some((file) => path.resolve(file) === cwdEnv), false);
});

test('this suite is not bound to the live Clementine home', async () => {
  const { BASE_DIR, REAL_DEFAULT_CLEMENTINE_HOME } = await import('../config.js');
  assert.equal(path.resolve(REAL_DEFAULT_CLEMENTINE_HOME), before.home);
  assert.equal(path.resolve(REAL_DEFAULT_CLEMENTINE_HOME), realDefaultClementineHome());
  assert.notEqual(path.resolve(BASE_DIR), before.home);
  assert.notEqual(process.env.CLEMENTINE_HOME, before.home);
  assert.ok(before.harnessDb.exists === false || before.harnessDb.size > 0);
  assert.ok(before.memoryDb.exists === false || before.memoryDb.size > 0);
});

test('importing adapter and contract writers does not mutate the live home', async () => {
  const adapters = await import('./harness/production-capability-adapters.js');
  const { saveToolContract } = await import('../tools/tool-contract-store.js');
  const { rememberToolSchema } = await import('../tools/composio-schema-cache.js');
  // A SYNTHETIC identifier, deliberately. A realistic slug cannot prove
  // anything here: a live daemon deposits real contracts mid-suite (measured
  // 2026-08-22 — it wrote GOOGLESHEETS_BATCH_GET and
  // SLACK_FETCH_CONVERSATION_HISTORY while this suite ran), so a real name in
  // the live tree is ambiguous. This one could only arrive by escaping.
  rememberToolSchema(ESCAPE_CANARY, {
    type: 'object',
    required: ['title', 'sheet_name', 'sheet_json'],
    properties: {
      title: { type: 'string' },
      sheet_name: { type: 'string' },
      sheet_json: { type: 'array' },
    },
  });
  saveToolContract({
    identifier: ESCAPE_CANARY,
    schema: {
      type: 'object',
      required: ['title', 'sheet_name', 'sheet_json'],
      properties: {
        title: { type: 'string' },
        sheet_name: { type: 'string' },
        sheet_json: { type: 'array' },
      },
    },
    providerObservedAt: new Date().toISOString(),
  });
  assert.equal(typeof adapters.normalizeSheetRows, 'function');
  // The precise check, and the one that still means something while a daemon
  // owns the home: the canary must not exist anywhere in the real tree.
  assert.deepEqual(
    liveHomeFilesMatching(ESCAPE_CANARY),
    [],
    'contract and schema writers stayed inside the isolated home',
  );
  const verdict = compareLiveHome(before, snapshotLiveHome(), owners);
  assert.deepEqual(verdict.violations, [], 'and no unattributable change reached the live home');
});

test('suite sentinel: live harness/memory DBs, secrets, auth, and contracts are unchanged', () => {
  const verdict = compareLiveHome(before, snapshotLiveHome(), owners);
  assert.deepEqual(
    verdict.violations,
    [],
    `live home changed outside daemon-owned databases: ${verdict.violations.join(', ')}`,
  );
});

test('sentinel is strict with no daemon and reports itself as not performed with one', () => {
  // The rule is binary because a running daemon writes EVERY path in the
  // snapshot — databases continuously, tool contracts when it learns a schema,
  // auth.json when it refreshes a token on its own schedule. An earlier attempt
  // to carve out an "inviolable" subset failed on its first real run, when the
  // daemon deposited two provider contracts mid-suite. There is no subset of a
  // live home a daemon will not touch, so the check either holds or says
  // plainly that it could not run.
  const base = snapshotLiveHome();
  const moved = { ...base, toolContracts: { exists: true, sha256: 'b'.repeat(64) } };

  const unowned = compareLiveHome(base, moved, []);
  assert.equal(unowned.performed, true, 'with no owner the proof is available');
  assert.deepEqual(unowned.violations, ['toolContracts'], 'and any change is a violation');

  const owned = compareLiveHome(base, moved, [4242]);
  assert.equal(owned.performed, false, 'a live owner makes the byte diff unattributable');
  assert.equal(owned.ok, true, 'so it must not fail — a sentinel red on every dev run gets ignored');
  assert.deepEqual(owned.attributed, ['toolContracts'], 'but what moved stays visible');

  const quiet = compareLiveHome(base, base, []);
  assert.equal(quiet.ok, true);
  assert.deepEqual(quiet.violations, []);
});
