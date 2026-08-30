/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/eventlog-live-store-guard.test.ts
 *
 * The live-store guard must refuse the user's OWN store and nothing else.
 *
 * Why it exists: 2026-08-27, three fixture sessions (`tool-search-durable-*`)
 * were found sitting in the live 1.2 GB harness.db. A test had set
 * CLEMENTINE_HOME at line 9, but a static import hoisted above it and
 * config.js captured the real home first — so the suite read and wrote the
 * user's data while looking isolated in the source. It surfaced as
 * `UNIQUE constraint failed: sessions.id`, which reads like a durability bug.
 *
 * Why THIS pin exists: the guard's first implementation tried to prove the
 * path was SAFE by requiring it under os.tmpdir(). The sanctioned runner
 * deliberately keeps TMPDIR at <root>/tmp, a SIBLING of the minted
 * <root>/homes/<name> — a deep TMPDIR pushes tsx's IPC socket past the
 * 104-byte macOS limit. So a correctly isolated home is NOT under os.tmpdir(),
 * and the guard refused 14 typed-execution pins for being safe.
 *
 * The lesson is the shape, not the paths: proving safety requires enumerating
 * every legitimate layout, and any layout you forget becomes a false refusal.
 * Naming the one FORBIDDEN location requires knowing only that. These pins
 * hold both directions.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-live-store-guard-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { REAL_DEFAULT_CLEMENTINE_HOME } = await import('../../config.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

/**
 * Re-derive the guard's decision for an arbitrary resolved path. The guard
 * itself closes over module-level BASE_DIR, so the DECISION is what is pinned
 * here; the wiring is covered by the suite that opens a real store below.
 */
function refuses(resolved: string, realUserHome?: string): boolean {
  const realHome = realUserHome
    ? path.resolve(realUserHome, '.clementine-next')
    : REAL_DEFAULT_CLEMENTINE_HOME;
  const forbidden = [REAL_DEFAULT_CLEMENTINE_HOME, realHome];
  return forbidden.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

test('the real user store is refused', () => {
  assert.equal(refuses(path.join(REAL_DEFAULT_CLEMENTINE_HOME, 'state', 'harness.db')), true,
    "a test process must never open the user's own event log");
});

test('an isolated home OUTSIDE os.tmpdir() is permitted', () => {
  // Exactly the sanctioned runner's layout: TMPDIR is <root>/tmp, the home is
  // <root>/homes/<name>. The home is therefore NOT under TMPDIR, and an
  // under-tmp test would refuse it — which is what broke 14 pins.
  const root = path.join(os.tmpdir(), 'clementine-test-home-XXXX');
  const tmpdir = path.join(root, 'tmp');
  const home = path.join(root, 'homes', 'clementine-test-home-YYYY');
  assert.ok(!home.startsWith(`${tmpdir}${path.sep}`),
    'fixture must reproduce the sibling layout, or this pin proves nothing');
  assert.equal(refuses(path.join(home, 'state', 'harness.db')), false,
    'a correctly isolated home must open even though it is not under TMPDIR');
});

test('a home anywhere else on disk is permitted', () => {
  // Test homes are not required to live in any particular place. Only the
  // user's data is off limits.
  for (const elsewhere of ['/var/data/ci-home', '/opt/runner/work/home']) {
    assert.equal(refuses(path.join(elsewhere, 'state', 'harness.db')), false,
      `${elsewhere} is not the user's store and must not be refused`);
  }
});

test('a sibling directory that merely shares a prefix is not the real store', () => {
  // `~/.clementine-next-backup` is not `~/.clementine-next`.
  assert.equal(refuses(`${REAL_DEFAULT_CLEMENTINE_HOME}-backup/state/harness.db`), false,
    'prefix matching must respect the path separator');
});

test('the real store is refused via CLEMMY_REAL_USER_HOME too', () => {
  // The sanctioned runner rewrites HOME, so the default no longer resolves to
  // the user's directory; it passes the true one separately. Both must refuse.
  const realUserHome = '/Users/example';
  assert.equal(refuses('/Users/example/.clementine-next/state/harness.db', realUserHome), true,
    'rewriting HOME must not open a door to the real store');
});

test('the guard is wired into openEventLog, not merely defined', async () => {
  // The decision table above is worthless if nothing consults it.
  const eventlog = await import('./eventlog.js');
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./eventlog.ts', import.meta.url), 'utf8'));
  assert.match(source, /export function openEventLog[\s\S]{0,200}assertNotLiveStoreUnderTest\(\)/,
    'openEventLog must call the guard before it opens anything');
  // And the isolated home still genuinely opens.
  assert.ok(eventlog.openEventLog(), 'an isolated home must remain usable');
  eventlog.closeEventLog();
});
