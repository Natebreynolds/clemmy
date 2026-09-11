/**
 * Home is the command center. It must not bounce into Chat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOME = readFileSync(new URL('./Home.tsx', import.meta.url), 'utf8');
const CHAT = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8');

test('Home renders the command center instead of redirecting to Chat', () => {
  assert.match(HOME, /export function Home\(/);
  assert.doesNotMatch(HOME, /Navigate to="\/chat"/);
  assert.match(HOME, /headingId="home-needs-you"/);
  assert.match(HOME, /headingId="home-running"/);
  assert.match(HOME, /max-w-\[1080px\]/);
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
});
