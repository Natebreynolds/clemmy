import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  homeCanSayAllClear,
  homeCountAsOf,
  homeLead,
  homeNeedsYouPane,
  homeUnfinishedNote,
  homeWorkPane,
  homeWorkPaneTitle,
  phoneHeaderChrome,
  type HomeLeadFacts,
} from './home-presentation';

/**
 * The numbers in this file are the owner's, measured on his machine on
 * 2026-09-06 — 86 counted against 0 renderable rows, and a working-now
 * projection of 100 entries holding 21 blocked runs from 2026-09-04 with
 * ZERO actually running. They are the reason the wave exists, so they are
 * the fixtures.
 */
const LIVE_NEEDS_YOU_COUNT = 86;
const LIVE_BLOCKED_TWO_DAYS_OLD = 21;
const LIVE_ACTUALLY_RUNNING = 0;

function facts(over: Partial<HomeLeadFacts> = {}): HomeLeadFacts {
  return {
    loading: false,
    answerableShown: 0,
    needsYouCount: 0,
    needsYouCountKnown: true,
    countLive: true,
    countAge: null,
    running: 0,
    workNeedsYou: 0,
    unfinished: 0,
    workKnown: true,
    workPaneShown: true,
    awayCount: 0,
    otherRows: 0,
    ...over,
  };
}

// ─── the count may never exceed what the screen can show ────────────────────

test('86 counted against 0 renderable rows never becomes a pane with a count on it', () => {
  const pane = homeNeedsYouPane({ rendered: 0, counted: LIVE_NEEDS_YOU_COUNT, countedKnown: true });
  assert.equal(pane.show, false, 'a card with no rows is not rendered at all');
  assert.equal(pane.count, 0);
});

test('the pane header counts the rows it renders, and the remainder is named as elsewhere', () => {
  const pane = homeNeedsYouPane({ rendered: 3, counted: LIVE_NEEDS_YOU_COUNT, countedKnown: true });
  assert.equal(pane.show, true);
  assert.equal(pane.count, 3, 'three rows on screen means the header says three, never 86');
  assert.equal(pane.moreLabel, '83 more in Needs you');
});

test('no remainder is invented from a count that has never been read', () => {
  const pane = homeNeedsYouPane({ rendered: 2, counted: LIVE_NEEDS_YOU_COUNT, countedKnown: false });
  assert.equal(pane.count, 2);
  assert.equal(pane.moreLabel, 'Open Needs you');
});

test('a count that matches the rows leaves the link a plain door', () => {
  const pane = homeNeedsYouPane({ rendered: 2, counted: 2, countedKnown: true });
  assert.equal(pane.moreLabel, 'Open Needs you');
});

// ─── the lead: what the phone opens with ────────────────────────────────────

test('the lead counts the rows on the screen, and discloses the rest as elsewhere', () => {
  const lead = homeLead(facts({ answerableShown: 3, needsYouCount: LIVE_NEEDS_YOU_COUNT }));
  assert.equal(lead.tone, 'answer');
  assert.equal(lead.headline, '3 things need your answer');
  assert.equal(lead.detail, '83 more in Needs you');
  assert.deepEqual(lead.action, { label: 'Open Needs you', target: 'inbox' });
  assert.doesNotMatch(lead.headline, /86/, 'the headline may not claim what the screen cannot show');
});

test('one answerable thing is written as a sentence, not as a badge', () => {
  const lead = homeLead(facts({ answerableShown: 1, needsYouCount: 1 }));
  assert.equal(lead.headline, 'One thing needs your answer');
  assert.equal(lead.detail, '');
  assert.equal(lead.action, null, 'the row is right below with its own buttons');
});

test('86 counted with no row here states the count against the screen that can show it', () => {
  const lead = homeLead(facts({ answerableShown: 0, needsYouCount: LIVE_NEEDS_YOU_COUNT }));
  assert.equal(lead.tone, 'elsewhere');
  assert.equal(lead.headline, '86 things are waiting in Needs you');
  assert.deepEqual(lead.action, { label: 'Open Needs you', target: 'inbox' });
});

test("the owner's live projection — 0 running, 21 blocked for two days — is never led as present work", () => {
  const lead = homeLead(facts({
    running: LIVE_ACTUALLY_RUNNING,
    unfinished: LIVE_BLOCKED_TWO_DAYS_OLD,
  }));
  assert.equal(lead.tone, 'quiet');
  assert.equal(lead.headline, 'Nothing needs an answer');
  assert.equal(lead.detail, '21 earlier runs are still open');
  assert.doesNotMatch(lead.headline + lead.detail, /running|working/i,
    'unfinished work gets the past tense it earned');
  assert.equal(lead.action, null, 'there is nothing to answer, so there is no button');
});

// ─── the screen may not answer over a row that contradicts it ───────────────
//
// A workflow parked at `awaiting_project_bind` maps to lifecycle
// `awaiting_approval` (src/dashboard/activity-projection.ts), which the shared
// presenter classes `needs_you` and explicitly protects from ageing out. The
// Inbox summary counts binding stops only when they are `.scheduled`, so the
// shell's Needs-you total can be a truthful ZERO while that row is on screen
// printing "Waiting for approval". The old status line had a branch for
// exactly this; deleting it is what let the lead say "Nothing needs an answer"
// over it.

test('a run parked on a question is never answered with "Nothing needs an answer"', () => {
  const lead = homeLead(facts({ needsYouCount: 0, needsYouCountKnown: true, workNeedsYou: 1 }));
  assert.equal(lead.tone, 'attention');
  assert.equal(lead.headline, 'One run is waiting on your answer');
  assert.notEqual(lead.headline, 'Nothing needs an answer');
  assert.equal(lead.action, null, 'the row is right below with its own tap');
  assert.equal(homeLead(facts({ workNeedsYou: 3 })).headline, '3 runs are waiting on your answer');
});

test('a demand with no pane to show it gets the door to the screen that can', () => {
  const lead = homeLead(facts({ workNeedsYou: 2, workPaneShown: false }));
  assert.equal(lead.tone, 'attention');
  assert.deepEqual(lead.action, { label: 'Open Activity', target: 'activity' });
});

test('a blocked run still qualifies, and never outranks a thing answerable here', () => {
  assert.equal(homeLead(facts({ workNeedsYou: 2, unfinished: 4 })).detail, '4 earlier runs are still open');
  // Ordering: answerable here > answerable elsewhere > a run on a question >
  // live work. A demand always outranks mere running.
  assert.equal(homeLead(facts({ workNeedsYou: 2, answerableShown: 1, needsYouCount: 1 })).tone, 'answer');
  assert.equal(homeLead(facts({ workNeedsYou: 2, needsYouCount: 9 })).tone, 'elsewhere');
  assert.equal(homeLead(facts({ workNeedsYou: 2, running: 3 })).tone, 'attention');
  assert.equal(homeLead(facts({ running: 3 })).tone, 'working');
});

test('a run on a question also blocks "All clear", the same way stalled work does', () => {
  assert.equal(homeLead(facts({ workNeedsYou: 1 })).tone, 'attention');
  assert.notEqual(homeLead(facts({ workNeedsYou: 1 })).tone, 'clear');
});

// ─── the count says how old it is, and is still given ───────────────────────

test('a count off the service-worker shelf is disclosed, never gated', () => {
  const lead = homeLead(facts({
    answerableShown: 0,
    needsYouCount: LIVE_NEEDS_YOU_COUNT,
    countLive: false,
    countAge: '6h ago',
  }));
  assert.equal(lead.headline, '86 things are waiting in Needs you', 'the answer is still given');
  assert.equal(lead.asOf, "Counted 6h ago — I can't reach your Mac.");
  assert.deepEqual(lead.action, { label: 'Open Needs you', target: 'inbox' },
    'and the door to act on it stays open');
});

test('every lead that rests on the count carries its provenance, including the quiet ones', () => {
  const stale = { countLive: false, countAge: '6h ago' };
  for (const over of [
    { answerableShown: 3, needsYouCount: LIVE_NEEDS_YOU_COUNT },
    { needsYouCount: LIVE_NEEDS_YOU_COUNT },
    { workNeedsYou: 1 },
    { running: 2 },
    { awayCount: 2 },
    { unfinished: LIVE_BLOCKED_TWO_DAYS_OLD },
    {},
  ] as Array<Partial<HomeLeadFacts>>) {
    const lead = homeLead(facts({ ...over, ...stale }));
    assert.equal(lead.asOf, "Counted 6h ago — I can't reach your Mac.", JSON.stringify(over));
  }
  // "All clear" is the most confident thing this screen says, so it is the one
  // that most needs the disclosure.
  assert.equal(homeLead(facts(stale)).tone, 'clear');
});

test('a confirmed count says nothing about its age, and an unread one is not aged either', () => {
  assert.equal(homeLead(facts({ needsYouCount: 4 })).asOf, '', 'a live read needs no qualifier');
  assert.equal(homeCountAsOf({ countLive: true, countAge: '6h ago' }), '');
  assert.equal(homeCountAsOf({ countLive: false, countAge: null }), 'Not confirmed just now.');
  assert.equal(
    homeLead(facts({ loading: true, countLive: false, countAge: '6h ago' })).asOf, '',
    'nothing has been read yet, so there is no age to disclose');
  assert.equal(
    homeLead(facts({ needsYouCountKnown: false, countLive: false, countAge: '6h ago' })).asOf, '',
    'an unread count is disclosed as unread, not as old');
});

test('unfinished work qualifies a headline but never becomes one', () => {
  for (const over of [
    { answerableShown: 2, needsYouCount: 2 },
    { needsYouCount: 4 },
    { running: 1 },
  ] as Array<Partial<HomeLeadFacts>>) {
    const lead = homeLead(facts({ ...over, unfinished: LIVE_BLOCKED_TWO_DAYS_OLD }));
    assert.notEqual(lead.tone, 'quiet');
    assert.doesNotMatch(lead.headline, /still open/, JSON.stringify(over));
  }
});

test('one blocked run reads as one, in the present-safe past tense', () => {
  assert.equal(homeUnfinishedNote(1), '1 earlier run is still open');
  assert.equal(homeUnfinishedNote(0), '');
});

test('genuinely live work leads, and says so without a count it cannot back', () => {
  assert.equal(homeLead(facts({ running: 1 })).headline, 'Clem is working on something');
  assert.equal(homeLead(facts({ running: 4 })).headline, 'Clem is running 4 things');
  assert.equal(homeLead(facts({ running: 4 })).tone, 'working');
});

test('a thing to answer outranks live work, which outranks what she finished', () => {
  const busy = { running: 2, awayCount: 5 };
  assert.equal(homeLead(facts({ ...busy, answerableShown: 1, needsYouCount: 1 })).tone, 'answer');
  assert.equal(homeLead(facts({ ...busy, needsYouCount: 9 })).tone, 'elsewhere');
  assert.equal(homeLead(facts(busy)).tone, 'working');
  assert.equal(homeLead(facts({ awayCount: 5 })).tone, 'away');
});

test('"Clem finished something" is a real answer the screen is willing to give', () => {
  const lead = homeLead(facts({ awayCount: 3 }));
  assert.equal(lead.headline, '3 updates while you were away');
  assert.equal(homeLead(facts({ awayCount: 1 })).headline, '1 update while you were away');
});

test('"All clear" is a real answer too, and only when every source is authoritatively empty', () => {
  const lead = homeLead(facts());
  assert.equal(lead.tone, 'clear');
  assert.equal(lead.headline, 'All clear');
  assert.equal(homeLead(facts({ otherRows: 2 })).tone, 'quiet', 'rows below mean the screen is not empty');
  assert.equal(homeLead(facts({ unfinished: 1 })).tone, 'quiet');
});

// ─── never render an unknown as a zero ──────────────────────────────────────

test('Home cannot claim quiet or all-clear before the first authoritative Inbox count', () => {
  const lead = homeLead(facts({ needsYouCountKnown: false, workKnown: false }));
  assert.equal(lead.tone, 'checking');
  assert.equal(lead.headline, 'Checking what needs you…');
  assert.equal(homeCanSayAllClear({
    loading: false,
    needsYouCount: 0,
    needsYouCountKnown: false,
    currentTaskCount: 0,
    currentTaskCountKnown: false,
    reminderCount: 0,
    recentChatCount: 0,
  }), false);
});

test('Home cannot claim quiet when the Working Now source has never succeeded', () => {
  const lead = homeLead(facts({ workKnown: false }));
  assert.equal(lead.tone, 'checking');
  assert.equal(lead.headline, 'Checking current work…');
  assert.equal(homeCanSayAllClear({
    loading: false,
    needsYouCount: 0,
    needsYouCountKnown: true,
    currentTaskCount: 0,
    currentTaskCountKnown: false,
    reminderCount: 0,
    recentChatCount: 0,
  }), false);
});

test('a zero Inbox summary cannot hide blocked, stale, awaiting, or paused current work', () => {
  for (const lifecycle of ['blocked', 'stale', 'awaiting_input', 'awaiting_approval', 'paused_budget']) {
    assert.equal(homeCanSayAllClear({
      loading: false,
      needsYouCount: 0,
      needsYouCountKnown: true,
      currentTaskCount: 1,
      currentTaskCountKnown: true,
      reminderCount: 0,
      recentChatCount: 0,
    }), false, lifecycle);
    assert.notEqual(homeLead(facts({ unfinished: 1 })).tone, 'clear', lifecycle);
  }
});

test('the first load says it is catching up rather than guessing', () => {
  assert.equal(homeLead(facts({ loading: true, needsYouCount: 9 })).headline, 'Catching up…');
});

// ─── the work pane cannot call the past the present ─────────────────────────

test('a pane holding only unfinished runs is not headed "Running"', () => {
  const title = (running: number, needsYou: number, unfinished: number): string =>
    homeWorkPaneTitle({ running, needsYou, unfinished });
  assert.equal(title(LIVE_ACTUALLY_RUNNING, 0, LIVE_BLOCKED_TWO_DAYS_OLD), 'Still open');
  assert.equal(title(2, 0, 0), 'Running');
  assert.equal(title(2, 0, 3), 'Working now');
  assert.equal(title(0, 0, 0), '', 'nothing in it, nothing rendered');
  // A question is not "still open" — someone is holding it up.
  assert.equal(title(0, 1, 0), 'Waiting on you');
  assert.equal(title(0, 1, 9), 'Waiting on you', 'the demand names the pane, not the silence');
  assert.equal(title(2, 1, 0), 'Working now');
});

// ─── the one uncapped list on Home was the 21-row one ───────────────────────

test("the owner's 21 stalled runs are capped, and the remainder is named against Activity", () => {
  const pane = homeWorkPane({
    running: LIVE_ACTUALLY_RUNNING,
    needsYou: 0,
    unfinished: LIVE_BLOCKED_TWO_DAYS_OLD,
    max: 4,
  });
  assert.equal(pane.show, true);
  assert.equal(pane.title, 'Still open');
  assert.equal(pane.shown, 4, 'every other pane on Home is capped; so is this one');
  assert.equal(pane.moreLabel, '17 more in Activity');
});

test('a pane that fits gets no footer link, and an empty one is never mounted', () => {
  const fits = homeWorkPane({ running: 2, needsYou: 0, unfinished: 1, max: 4 });
  assert.equal(fits.shown, 3);
  assert.equal(fits.moreLabel, '', 'nothing is hidden, so nothing is claimed to be elsewhere');
  const empty = homeWorkPane({ running: 0, needsYou: 0, unfinished: 0, max: 4 });
  assert.equal(empty.show, false);
  assert.equal(empty.title, '');
  assert.equal(empty.moreLabel, '');
});

test('the remainder counts every class in the pane, never just the stalled ones', () => {
  const pane = homeWorkPane({ running: 3, needsYou: 2, unfinished: 5, max: 4 });
  assert.equal(pane.shown, 4);
  assert.equal(pane.moreLabel, '6 more in Activity', '10 rows, 4 on the glass');
});

// ─── the header row ─────────────────────────────────────────────────────────

test('the header carries a signal only for what the screen cannot show itself', () => {
  // Home leads with the answer and lists the work, so both shortcuts are noise
  // there — which leaves identity, place, and connection.
  const home = phoneHeaderChrome({ tab: 'home', needsYouSignal: true });
  assert.deepEqual(home, { needsPill: false, workChip: false });

  // Needs you shows its own list; Activity shows its own runs.
  assert.equal(phoneHeaderChrome({ tab: 'inbox', needsYouSignal: true }).needsPill, false);
  assert.equal(phoneHeaderChrome({ tab: 'activity', needsYouSignal: true }).workChip, false);

  // Everywhere else the chrome is the only door, so it keeps both.
  const chat = phoneHeaderChrome({ tab: 'chats', needsYouSignal: true });
  assert.deepEqual(chat, { needsPill: true, workChip: true });
  assert.equal(phoneHeaderChrome({ tab: 'chats', needsYouSignal: false }).needsPill, false,
    'and it never shows a pill for a count the shell has not confirmed');
});

// ─── the pins: the screen actually asks these functions ─────────────────────
//
// Rules that live only in a pure module decay the moment the renderer stops
// calling them. These assert the connection.

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Home leads with the presenter and prints no count it did not render', () => {
  const home = read('../screens/Home.tsx');
  assert.match(home, /const lead = homeLead\(\{/, 'the lead is computed, not written inline');
  assert.match(home, /class="home-lead-head">\{lead\.headline\}/, 'and it is the headline');
  assert.match(home, /<p class="home-lead-eyebrow">\{greeting\}<\/p>/,
    'the greeting is an eyebrow, not the largest type on the screen');

  assert.match(home, /const needsPane = homeNeedsYouPane\(\{/);
  assert.match(home, /needs_you: \(\) => \(needsPane\.show \?/,
    'a card with no rows is never mounted');
  assert.match(home, /class="section-count">\{pane\.count\}/,
    'the pane header prints the rows it rendered');
  assert.doesNotMatch(home, /section-count">\{count\}|section-count">\{needsYouCount\}/,
    "the shell's total may not head this pane");
  assert.doesNotMatch(home, /Math\.max\(0, count - shown\.length\)/,
    'the remainder is the presenter’s, not a second derivation in JSX');
});

test('there is ONE definition of running in the app, and Home reads it', () => {
  const home = read('../screens/Home.tsx');
  // The shared presenter's three-way membership, not a seventh re-derivation.
  assert.match(home, /const liveNow = workingView\.running;/,
    'running is the presenter’s membership, not the pulse certificate');
  assert.match(home, /const workNeedsYou = workingView\.needsYou;/);
  assert.match(home, /const unfinished = workingView\.stalled;/);
  assert.doesNotMatch(home, /entries\.filter\(\(p\) => p\.pulse\)/,
    'a run with liveness "unknown" is running here exactly as it is on Chats');
  assert.doesNotMatch(home, /workingView\.total - liveNow/,
    'unfinished is a class the presenter names, not a subtraction');
});

test('the work pane is derived, capped, and its remainder has a door', () => {
  const home = read('../screens/Home.tsx');
  assert.match(home, /const workPane = homeWorkPane\(\{/);
  assert.match(home, /max: MAX_WORK_ROWS,/);
  assert.match(home, /running: \(\) => \(workPane\.show \?/, 'an empty pane is never mounted');
  assert.match(home, /pane-head">\{workPane\.title\}<\/h2>/, 'the heading is derived');
  assert.doesNotMatch(home, /pane-head">Running<\/h2>/,
    'so a pane of blocked runs cannot be headed "Running"');
  assert.match(home, /\.slice\(0, workPane\.shown\)/, 'the 21-row list is capped like every other');
  assert.match(home, /\{workRows\.map\(/, 'and the capped rows are what render');
  assert.doesNotMatch(home, /\{workingView\.entries\.map\(/, 'never the uncapped projection');
  assert.match(home, /\{workPane\.moreLabel \?/);
  assert.match(home, /<span>\{workPane\.moreLabel\}<\/span>/,
    'the remainder is named against Activity, which renders all of it');
});

test('the rows under the heading speak the same tense the heading does', () => {
  const home = read('../screens/Home.tsx');
  assert.match(home, /\{runStatusLabel\(presented\)\}/,
    'a stalled run says it stopped, instead of printing the phase word it died on');
  assert.doesNotMatch(home, /waiting \? lifecycleLabel\(entry\.lifecycle\)/,
    'the row no longer prints "Running" under a heading reading "Still open"');
  assert.match(home, /const waiting = presented\.membership === 'needs_you';/,
    'and the warn accent means a person is the blocker, not merely not-live');
});

test('the lead is fed the demand the Inbox count cannot see, and how old that count is', () => {
  const home = read('../screens/Home.tsx');
  assert.match(home, /const lead = homeLead\(\{/, 'the lead is computed, not written inline');
  assert.match(home, /\n    workNeedsYou,\n/,
    'a run parked on a question reaches the lead, so it cannot answer over that row');
  assert.match(home, /countLive: needsYouCountLive,/);
  assert.match(home, /countAge: needsYouCountAge,/);
  assert.match(home, /workPaneShown: paneSet\.has\('running'\) && workPane\.show,/);
  assert.match(home, /\{lead\.asOf \? <p class="home-lead-asof">\{lead\.asOf\}<\/p> : null\}/,
    'and the age is actually rendered');
  assert.match(home, /<div class="home-lead-say" aria-live="polite">/,
    'the answer rewrites itself as polls land, so it is announced');
  assert.match(home, /if \(leadAction\.target === 'activity'\) onOpenActivity\(\);/,
    'a control may not be offered for something it cannot do: the tap goes where it says');
});

test('the header row is fed by the chrome rule, and Home is handed the age the pill used to carry', () => {
  const app = read('../app.tsx');
  assert.match(app, /const headerChrome = phoneHeaderChrome\(\{ tab, needsYouSignal: needsYou\.show \}\)/);
  assert.match(app, /\{headerChrome\.workChip \? <RunningTasksSheet onOpenRun=\{openRun\} \/> : null\}/);
  assert.match(app, /\{headerChrome\.needsPill \? \(/);
  assert.doesNotMatch(app, /tab === 'home' && needsYou\.show/,
    'the pill no longer appears only on the one screen that already says it');
  // Suppressing the pill on Home removed the phone's only staleness
  // disclosure from the screen that leads with the count. It is handed over
  // from the SAME presenter, so chrome and Home cannot disagree about the age.
  assert.match(app, /needsYouCountLive=\{!needsYou\.stale\}/);
  assert.match(app, /needsYouCountAge=\{needsYou\.age\}/);
  assert.match(app, /onOpenActivity=\{\(\) => navigateTo\('activity'\)\}/,
    'and the work pane’s remainder has somewhere to go');

  const css = read('../styles.css');
  assert.match(css, /\.app-main h2\.home-lead-head \{/,
    'the headline outranks the generic h2 rule that would otherwise size it');
  assert.match(css, /\.home-lead-asof \{/, 'the disclosure has a real style, not a default');
  assert.match(css, /\.home-lead-attention/,
    'a run waiting on you reads as a demand, like the other two');
  assert.match(css, /\.home-lead-say \{/, 'and the live region is laid out, not left to collapse');
  assert.doesNotMatch(css, /\.home-greet|\.home-status \{|\.qa-chip-add|\.home-skeleton/,
    'dead chrome styles are deleted, not left behind');
});
