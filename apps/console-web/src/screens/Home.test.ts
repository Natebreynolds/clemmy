/**
 * Home is the owner's page. It must not bounce into Chat, and it summarizes
 * Clem's work in one line that leads to the board rather than drawing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOME = readFileSync(new URL('./Home.tsx', import.meta.url), 'utf8');
const CHAT = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

test('Home mock screens cover the visual contract', () => {
  const MOCK = readFileSync(new URL('./HomeMock.tsx', import.meta.url), 'utf8');
  const TILES = readFileSync(new URL('../components/home/mock/tiles.tsx', import.meta.url), 'utf8');
  const SCREENS = readFileSync(new URL('../components/home/mock/screens.ts', import.meta.url), 'utf8');
  assert.match(MOCK, /Build your command center/);
  assert.match(MOCK, /Add to home/);
  assert.match(MOCK, /Start here/);
  assert.match(MOCK, /Clem can build/);
  assert.match(TILES, /Content trends/);
  assert.match(TILES, /Social capture/);
  assert.match(TILES, /Baseline set/);
  assert.match(SCREENS, /id: 'phone'/);
});

test('Home renders the command center instead of redirecting to Chat', () => {
  assert.match(HOME, /export function Home\(/);
  assert.doesNotMatch(HOME, /Navigate to="\/chat"/);
  assert.match(HOME, /headingId="home-needs-you"/);
  assert.match(HOME, /headingId="home-made"/);
  assert.match(HOME, /MadePane/);
  assert.match(HOME, /max-w-\[1240px\]/);
});

test('two styles the owner picks, Clem\'s work as a live band, each Space summary or full', () => {
  assert.match(HOME, /prefs\.style === 'briefing' \? briefing : dashboard/);
  assert.match(HOME, /needsPane\('strip', 3\)/, 'Briefing leads with decisions as cards');
  assert.match(HOME, /recentPane\('timeline'\)/);
  assert.match(HOME, /\[showToday && todayPane, showNeeds && needsPane\('list', 2\), showRecent && recentPane\('list'\)\]/, 'Dashboard: Today, Needs you, what came back');
  assert.match(HOME, /<LiveStatus/);
  assert.match(HOME, /mode=\{prefs\.liveStatus \?\? 'animated'\}/);
  assert.match(HOME, /effectiveSpaceView\(chosenView\(spaceId\), summaries\.data\?\.find/, 'one rule, shared with Tune');
  const DATA = readFileSync(new URL('../lib/home-data.ts', import.meta.url), 'utf8');
  assert.match(DATA, /if \(chosen\) return chosen;/, 'the owner\'s choice wins');
  assert.match(DATA, /summary\.headline\.length === 0 && summary\.records\.length === 0 && !summary\.breakdown \? 'full' : 'summary'/, 'no summary to give: its page');
  assert.match(HOME, /useSpaceSummaries\(summaryIds\)/, 'tiles chosen as full pages read no summary');
  assert.doesNotMatch(HOME, /RunningPane/);
  assert.doesNotMatch(HOME, /headingId="home-running"/);
  // No eyebrow labels over the sections.
  assert.doesNotMatch(HOME, /uppercase tracking-widest/);
});

test('the live band names running work from the shared presenter and leads to the board', () => {
  const LIVE = readFileSync(new URL('../components/home/LiveStatus.tsx', import.meta.url), 'utf8');
  assert.match(LIVE, /entries\.filter\(\(p\) => p\.membership === 'running'\)/);
  assert.match(LIVE, /<Link to="\/tasks"/);
  assert.match(LIVE, /if \(mode === 'off' \|\| unavailable\) return null;/, 'unknown is not "caught up"');
  assert.match(LIVE, /prefers-reduced-motion: reduce/);
  const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(CSS, /\.live-band\.is-working:not\(\.live-band-still\)::after/);
  assert.match(CSS, /\.live-band\.is-working::after, \.live-band\.is-working \.live-dot::after \{ animation: none; display: none; \}/);
});

test('Build home is a tracked journey, not a chat hand-off', () => {
  assert.match(HOME, /useHomeBuilds\(/);
  assert.match(HOME, /<BuildCard/);
  assert.match(HOME, /startBuild=\{builds\.start\}/);
  assert.doesNotMatch(HOME, /onBuild=\{text => sendAndOpen/);
});

test('Chat empty state is a composer, not the briefing', () => {
  assert.doesNotMatch(CHAT, /NeedsYouPane/);
  assert.doesNotMatch(CHAT, /RunningPane/);
  assert.doesNotMatch(CHAT, /WhileAwayPane/);
  assert.doesNotMatch(CHAT, /ProjectsPane/);
  assert.doesNotMatch(CHAT, /RunningTasksDrawer/);
  assert.doesNotMatch(CHAT, /border-t border-border/);
  assert.match(CHAT, /New conversation only/);
});

test('the app lands on Home by default', () => {
  assert.match(APP, /path="\/home" element=\{<Home \/>\}/);
  assert.match(APP, /Navigate to="\/home" replace/);
  assert.match(APP, /prefs\.data\?\.landing \?\? 'home'/);
  assert.match(APP, /path="\/made"/);
  assert.match(APP, /path="\/made\/:groupId"/);
});

test('the Home mock is a side door, not the live landing', () => {
  assert.match(APP, /path="\/dev\/home-mock" element=\{<HomeMock \/>\}/);
  assert.doesNotMatch(APP, /Navigate to="\/dev\/home-mock"/);
  const HOME = readFileSync(new URL('./Home.tsx', import.meta.url), 'utf8');
  assert.match(HOME, /function LiveHome\(/);
  assert.match(HOME, /isHomeMockScreen/);
  const SCREENS = readFileSync(new URL('../components/home/mock/screens.ts', import.meta.url), 'utf8');
  assert.match(SCREENS, /export function isHomeMockScreen/);
});

test('Made is reachable from Home, not a sidebar pin', () => {
  const nav = readFileSync(new URL('../lib/nav.ts', import.meta.url), 'utf8');
  assert.match(nav, /export const MADE_NAV/);
  assert.match(nav, /ALL_NAV: NavDest\[\] = \[\.\.\.PRIMARY_NAV, MADE_NAV/);
  assert.doesNotMatch(nav.split('export const PRIMARY_NAV')[1]?.split('export const ADVANCED_NAV')[0] ?? '', /path: '\/made'/);
});
