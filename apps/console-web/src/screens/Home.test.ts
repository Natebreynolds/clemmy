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

test('Spaces are the main content; running work is one line that opens the board', () => {
  assert.match(HOME, /aria-labelledby="home-spaces"/);
  assert.match(HOME, /xl:col-start-1 xl:row-span-2 xl:row-start-1/, 'Spaces hold the main column beside the rail');
  assert.doesNotMatch(HOME, /RunningPane/);
  assert.doesNotMatch(HOME, /headingId="home-running"/);
  assert.match(HOME, /<Link to="\/tasks"[^>]*>\{work\}<\/Link>/);
  // No eyebrow labels over the sections.
  assert.doesNotMatch(HOME, /uppercase tracking-widest/);
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
