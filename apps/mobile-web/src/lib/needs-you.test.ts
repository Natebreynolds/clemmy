/**
 * The shell chrome must disclose its age too.
 *
 * The defect these pin: /m/api/inbox/summary is a last-good route, so with the
 * Mac asleep the header pill, the switcher badge and the drawer badge all said
 * "Needs you · 3" in fully confident chrome off a six-hour-old copy, while the
 * Inbox underneath honestly said it could not reach anything. Activity and Run
 * got a banner; the chrome that reads the same cached route got nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { needsYouChrome } from './needs-you';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('a live count says the number and nothing else', () => {
  const chrome = needsYouChrome({
    count: 3,
    known: true,
    asOf: new Date(NOW - 4_000).toISOString(),
    live: true,
    nowMs: NOW,
  });
  assert.equal(chrome.show, true);
  assert.equal(chrome.stale, false);
  assert.equal(chrome.age, null);
  assert.equal(chrome.pillText, 'Needs you · 3');
  assert.equal(chrome.badgeText, '3');
  assert.equal(chrome.drawerBadgeText, '3');
  assert.equal(chrome.pillAriaLabel, '3 items need you. Open Needs you');
  assert.equal(chrome.badgeAriaLabel, '3 items need you');
});

test('a remembered count says how old it is, in every surface', () => {
  const chrome = needsYouChrome({
    count: 3,
    known: true,
    asOf: '2026-09-06T06:00:00.000Z',
    live: false,
    nowMs: NOW,
  });
  assert.equal(chrome.stale, true);
  assert.equal(chrome.age, '6h ago');
  assert.equal(chrome.pillText, 'Needs you · 3 · 6h ago');
  assert.equal(
    chrome.badgeAriaLabel,
    '3 items need you, as of 6h ago',
    'a bare numeral cannot disclose its own age — the label does',
  );
  assert.match(chrome.pillAriaLabel, /Can't reach your Mac/);
});

test('a failed poll stops the chrome claiming to be current, even with no stamp', () => {
  const chrome = needsYouChrome({ count: 2, known: true, asOf: null, live: false, nowMs: NOW });
  assert.equal(chrome.stale, true);
  assert.equal(chrome.age, null, 'unknown age is not a made-up age');
  assert.equal(chrome.badgeAriaLabel, '2 items need you, not confirmed just now');
  assert.equal(chrome.pillText, 'Needs you · 2');
});

test('a freshly-missed poll is not yet worth a number', () => {
  // Under 90s the count really is what it just was; disclosing "a moment ago"
  // on every transient miss would be noise, not honesty.
  const chrome = needsYouChrome({
    count: 1,
    known: true,
    asOf: new Date(NOW - 30_000).toISOString(),
    live: false,
    nowMs: NOW,
  });
  assert.equal(chrome.stale, true, 'still marked, so the chrome is not solid');
  assert.equal(chrome.age, null);
  assert.equal(chrome.pillText, 'Needs you · 1');
  assert.equal(chrome.pillAriaLabel, "1 item needs you, not confirmed just now. Can't reach your Mac. Open Needs you");
});

test('an unknown count and a real zero both show nothing', () => {
  assert.equal(needsYouChrome({ count: 3, known: false, asOf: null, live: false, nowMs: NOW }).show, false);
  assert.equal(needsYouChrome({ count: 0, known: true, asOf: null, live: true, nowMs: NOW }).show, false);
  assert.equal(needsYouChrome({ count: Number.NaN, known: true, asOf: null, live: true, nowMs: NOW }).show, false);
});

test('counts are capped per surface, not re-derived at each one', () => {
  const chrome = needsYouChrome({ count: 140, known: true, asOf: null, live: true, nowMs: NOW });
  assert.equal(chrome.badgeText, '99+');
  assert.equal(chrome.drawerBadgeText, '9+');
  assert.equal(chrome.pillText, 'Needs you · 99+');
});

test('all three chrome surfaces read the one presenter, and the poll records provenance', () => {
  const app = read('../app.tsx');
  assert.match(app, /const needsYou = needsYouChrome\(\{/);
  assert.match(app, /const stamp = lastGoodAt\(INBOX_SUMMARY_PATH\);/,
    'a 200 off the shelf must be recognised before it feeds the chrome');
  assert.match(app, /setDecisionsLive\(!stamp\);/);
  assert.match(app, /\} catch \{[\s\S]*?if \(!cancelled\) setDecisionsLive\(false\);/,
    'a failed poll keeps the last good count but stops calling it current');
  // The pill, the title badge and the drawer badge.
  assert.match(app, /\{needsYou\.pillText\}<\/span>/);
  assert.match(app, /class=\{`title-badge\$\{needsYou\.stale \? ' badge-stale' : ''\}`\}/);
  assert.match(app, /class=\{`drawer-badge\$\{needsYou\.stale \? ' badge-stale' : ''\}`\}/);
  assert.match(app, /badgeStale: badged \? needsYou\.stale : undefined/, 'and the switcher');
  // The raw, undisclosed count must not be rendered anywhere in the chrome.
  assert.doesNotMatch(app, /Needs you · \{decisionsLabel\}/);
  assert.doesNotMatch(app, /decisions > 9 \? '9\+' : decisions/);

  const switcher = read('../components/TitleSwitcher.tsx');
  assert.match(switcher, /class=\{`switcher-badge\$\{entry\.badgeStale \? ' badge-stale' : ''\}`\}/);
  assert.match(switcher, /aria-label=\{entry\.badgeLabel\}/);

  const css = read('../styles.css');
  assert.match(css, /\.badge-stale \{/, 'the marker a numeral needs to stop looking live');
  assert.match(css, /\.needs-pill-stale \.needs-pill-face \{/);
});
