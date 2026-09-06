/**
 * Every place a run appears, it opens.
 *
 * The defect these pin: Run.tsx — the screen that leads with what CHANGED —
 * was reachable exactly one way (Activity → a live card that happened to carry
 * a sessionId), and Activity was not itself offered in the phone's switcher.
 * Meanwhile Home's Running rows carried a pulse, an elapsed clock and a
 * progress bar while being untappable, which reads as a typing indicator
 * rather than a work item.
 *
 * These are source pins because the surfaces are components and this app has
 * no DOM renderer configured. The pure parts (the URL contract, the row copy)
 * are unit-tested in deep-link.test.ts and run-rows.test.ts; what is left to
 * prove is that the screens are actually WIRED to them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the shell makes a run a destination and hands every surface the same door', () => {
  const app = read('../app.tsx');
  assert.match(app, /const openRun = useCallback\(\(sessionId: string\) => \{/);
  assert.match(app, /navigateTo\('activity', \{ runId: sessionId \}\)/);
  // Home, the Inbox and the header sheet all reach the SAME run screen.
  assert.equal((app.match(/onOpenRun=\{openRun\}/g) ?? []).length, 3, 'Home, Inbox and the running sheet');
  assert.match(app, /initialRunId=\{runId\}/, 'a URL-addressed run opens on arrival');
  assert.match(app, /onRunChange=\{\(sessionId\) => navigateTo\('activity', \{ runId: sessionId \}\)\}/,
    'opening a run inside Activity updates the URL, so reload and swipe-back land in the same place');
});

test("Home's running rows open the run they are about", () => {
  const home = read('../screens/Home.tsx');
  assert.match(home, /const sessionId = entry\.sessionId/);
  assert.match(home, /class="home-run-open"[\s\S]*?onOpenRun\(sessionId\)/);
  assert.match(home, /\{sessionId \? \([\s\S]*?\) : head\}/,
    'a row with no run screen shows no dead affordance');
});

test('a finished run row says what it did, not what the engine calls it', () => {
  const activity = read('../screens/Activity.tsx');
  assert.match(activity, /const label = runRowLabel\(run\)/);
  assert.match(activity, /\{label\.state\} · \{relativeTime\(run\.updatedAt\)\}/);
  assert.match(activity, /\{label\.detail \? <div class="run-outcome truncate">\{label\.detail\}<\/div> : null\}/);
  // The raw-token rendering is gone from every phone surface that had it.
  for (const screen of ['../screens/Activity.tsx', '../screens/Run.tsx', '../screens/Workflows.tsx']) {
    assert.doesNotMatch(
      read(screen),
      /(run|data)\??\.(status|terminalOutcome)[^\n]*\.replace\(\/_\/g, ' '\)/,
      `${screen} still prints a raw status token`,
    );
  }
});

test('the phone reads the enrichment the run list already sends', () => {
  const api = read('./api.ts');
  // Declaring the fields is not reading them: run-rows.ts is the consumer, and
  // run-rows.test.ts proves what it does with each one.
  assert.match(api, /statusLabel\?: string/);
  assert.match(api, /preview\?: string/);
  const rows = read('./run-rows.ts');
  assert.match(rows, /run\.statusLabel/);
  assert.match(rows, /run\.preview/);
});

test('a stale read is stamped and never mistaken for a live one', () => {
  const api = read('./api.ts');
  assert.match(api, /const lastGoodStamp = res\.headers\.get\(LAST_GOOD_HEADER\)/);
  assert.match(api, /noteLastGood\(path, lastGoodStamp\)/);
  assert.match(api, /if \(lastGoodStamp\) \{\s*\n\s*setConnectionDoor\('offline'\)/,
    'a cached 200 must not report the door open');
  assert.match(api, /const rotatedFp = lastGoodStamp \? null : res\.headers\.get\('x-clem-session-fp'\)/,
    "a remembered copy's fingerprint has since rotated; adopting it 401s every later proof");
  // Sign-out drops the remembered reads WHETHER OR NOT the daemon answers:
  // offline the logout POST throws, and a `clearLastGood()` after that await
  // never ran — the cache and the badge outlived the credential.
  assert.match(
    api,
    /try \{\s*\n\s*await api\('\/m\/auth\/logout', \{ method: 'POST' \}\);\s*\n\s*\} finally \{[\s\S]*?clearLastGood\(\);/,
    'the clear must be in a finally, not after the await',
  );

  // Activity reads a collection path; Run reads the ENCODED detail path, and
  // must ask for the stamp with the same string getRun fetched with — the raw
  // spelling missed for every `background:task-1`-shaped session id.
  assert.match(
    read('../screens/Activity.tsx'),
    /lastGood=\{lastGoodNotice\(lastGoodAt\('\/m\/api\/runs'\), Date\.now\(\)\)\}/,
  );
  const runScreen = read('../screens/Run.tsx');
  assert.match(runScreen, /const stampedAt = lastGoodAt\(runDetailPath\(sessionId\)\);/);
  assert.match(runScreen, /lastGood=\{lastGoodNotice\(stampedAt, Date\.now\(\)\)\}/);
  assert.doesNotMatch(
    runScreen,
    /lastGoodAt\(`\/m\/api\/runs\/\$\{sessionId\}`\)/,
    'the hand-spelled, unencoded key is the defect — it must not come back',
  );
  const notice = read('../components/ScreenNotice.tsx');
  assert.match(notice, /Check again/, 'stale data always offers a re-check');
});
