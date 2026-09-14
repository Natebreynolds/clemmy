/**
 * Home is the command center. It must not bounce into Chat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOME = readFileSync(new URL('./Home.tsx', import.meta.url), 'utf8');
const CHAT = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');
const RUNNING = readFileSync(new URL('../components/home/RunningPane.tsx', import.meta.url), 'utf8');

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
  assert.match(HOME, /headingId="home-running"/);
  assert.match(HOME, /headingId="home-made"/);
  assert.match(HOME, /MadePane/);
  assert.match(HOME, /max-w-\[1180px\]/);
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

test('the lead running row on Home streams live work', () => {
  assert.match(RUNNING, /function LiveRunFeed/);
  assert.match(RUNNING, /useWorkflowRunActivity/);
  assert.match(RUNNING, /useSessionActivity/);
  assert.match(RUNNING, /leadLiveKey && <LiveRunFeed/);
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
