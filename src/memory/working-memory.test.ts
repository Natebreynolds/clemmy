/**
 * Run: npx tsx --test src/memory/working-memory.test.ts
 *
 * P2-F — the lightweight between-turn checkpoint. Verifies it writes an
 * in-flight section into the per-session working-memory file, replaces (not
 * duplicates) that section on subsequent calls, preserves any pre-existing
 * content, and never throws (it must never break a turn).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wm-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  checkpointWorkingMemory,
  workingMemoryPathForSession,
  detectActiveTask,
  writeActiveTaskSection,
  readActiveTaskSection,
  hasActiveTaskSection,
  dropActiveTaskSection,
  reconcileActiveTask,
  refreshWorkingMemory,
} = await import('./working-memory.js');
const { WORKING_MEMORY_FILE } = await import('./vault.js');

function fakeSession(id: string, channel = 'dashboard') {
  const now = new Date().toISOString();
  return {
    id,
    channel,
    createdAt: now,
    updatedAt: now,
    turns: [
      { role: 'user' as const, text: 'hello there', createdAt: now },
      { role: 'assistant' as const, text: 'hi!', createdAt: now },
    ],
  };
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('checkpointWorkingMemory writes an in-flight section into the per-session file', () => {
  const sid = 'sess-wm-1';
  checkpointWorkingMemory(sid, { turn: 3, toolCallsTotal: 7, lastText: 'Pulled 10 accounts; drafting next.' });
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.ok(content.includes('## In-flight Checkpoint'), 'has the checkpoint section');
  assert.ok(content.includes('Turn: 3'));
  assert.ok(content.includes('Tool calls so far: 7'));
  assert.ok(content.includes('Pulled 10 accounts'), 'captures the latest text');
});

test('checkpointWorkingMemory replaces the section (no duplication) and preserves other content', () => {
  const sid = 'sess-wm-2';
  const file = workingMemoryPathForSession(sid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# Working Memory\n\n## Focus\nKeep going.\n');

  checkpointWorkingMemory(sid, { turn: 1, toolCallsTotal: 1 });
  checkpointWorkingMemory(sid, { turn: 4, toolCallsTotal: 9 });

  const content = readFileSync(file, 'utf-8');
  const occurrences = content.split('## In-flight Checkpoint').length - 1;
  assert.equal(occurrences, 1, 'exactly one checkpoint section (replaced, not appended)');
  assert.ok(content.includes('Turn: 4'), 'keeps the latest checkpoint');
  assert.ok(!content.includes('Turn: 1'), 'old checkpoint was replaced');
  assert.ok(content.includes('## Focus') && content.includes('Keep going.'), 'pre-existing content preserved');
});

test('checkpointWorkingMemory is best-effort and never throws', () => {
  assert.doesNotThrow(() => checkpointWorkingMemory('', {}));
  assert.doesNotThrow(() => checkpointWorkingMemory('sess-wm-3', { lastText: undefined, toolCallsTotal: undefined, turn: undefined }));
});

// ─── Active Task: detector ──────────────────────────────────────────────────

test('detectActiveTask captures verb + count + exclusivity + verbatim recipients', () => {
  const spec = detectActiveTask('Send 25 emails to ONLY this list: Alice Anderson, Bob Brennan, Carol Chen');
  assert.ok(spec, 'a constraint with a named list is detected');
  assert.equal(spec!.verb, 'send');
  assert.equal(spec!.count, 25);
  assert.equal(spec!.exclusivity, 'only');
  assert.deepEqual(spec!.recipients, ['Alice Anderson', 'Bob Brennan', 'Carol Chen']);
});

test('detectActiveTask captures an explicit email list', () => {
  const spec = detectActiveTask('email a@x.com, b@y.com and c@z.com about the launch');
  assert.ok(spec);
  assert.deepEqual(spec!.recipients, ['a@x.com', 'b@y.com', 'c@z.com']);
});

test('detectActiveTask returns null for imperatives without a concrete list', () => {
  for (const msg of [
    'send the report',
    'send me your thoughts',
    'how many emails did we send?',
    'what is on my calendar today',
    'thanks',
    'go ahead',
  ]) {
    assert.equal(detectActiveTask(msg), null, `"${msg}" should not be captured`);
  }
});

test('detectActiveTask captures a resource locator (the where-it-lives pointer)', () => {
  const url = 'https://docs.google.com/spreadsheets/d/1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz/edit';
  const spec = detectActiveTask(`send the Q2 outreach to the list at ${url}`);
  assert.ok(spec, 'mutating verb + a concrete locator fires');
  assert.equal(spec!.resourceRef, '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz');
});

test('detectActiveTask fires on "send 25 to this list" and renders an UNRESOLVED clarify line', () => {
  const spec = detectActiveTask('send 25 emails to this list');
  assert.ok(spec, 'list reference + count fires even with no inline names');
  assert.equal(spec!.count, 25);
  assert.equal(spec!.recipients.length, 0);
  assert.equal(spec!.resourceRef, undefined);
  const sid = 'sess-at-unresolved';
  writeActiveTaskSection(sid, spec!);
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.match(content, /UNRESOLVED — confirm WHICH list/);
});

test('Active Task renders the locator + use-don\'t-rediscover discipline (the real-incident fix)', () => {
  const sid = 'sess-at-loc';
  const id = '1AbcD_efGhIjKlMnOpQrStUvWxYz0123456789xyz';
  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', resourceRef: id, recipients: [],
    constraintText: 'send the Q2 outreach to that sheet',
  });
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.match(content, /pull it from the pinned reference and do NOT re-discover/);
  assert.ok(content.includes(id), 'the exact locator is pinned');
  assert.doesNotMatch(content, /UNRESOLVED/, 'a locator resolves the reference');
});

test('Active Task bounds a large recipient list (no bloat, no truncation drift)', () => {
  const sid = 'sess-at-large';
  const big = Array.from({ length: 200 }, (_, i) => `Person Number ${i}`);
  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', recipients: big, constraintText: 'send to all 200',
  });
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.match(content, /\+\d+ more/, 'overflow is summarized, not inlined');
  assert.match(content, /confirm the exact full set/);
  assert.ok(content.includes('Person Number 0'), 'preview includes the head of the list');
  assert.ok(!content.includes('Person Number 199'), 'the tail is not inlined (bounded)');
  assert.ok(content.length < 3000, 'whole section stays within the 3000-char read window');
});

// ─── Active Task: write / read / dedupe / non-destructive ────────────────────

test('writeActiveTaskSection is non-destructive, last-writer-wins, lists verbatim', () => {
  const sid = 'sess-at-1';
  const file = workingMemoryPathForSession(sid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# Working Memory\n\n## Focus\nKeep going.\n');

  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', count: 3, recipients: ['Alice Anderson', 'Bob Brennan', 'Carol Chen'],
    constraintText: 'send 3 emails to Alice Anderson, Bob Brennan, Carol Chen',
  });
  // last-writer-wins replace
  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', recipients: ['Dan Dawson', 'Eve Ellis'],
    constraintText: 'actually send to Dan Dawson, Eve Ellis',
  });

  const content = readFileSync(file, 'utf-8');
  assert.equal(content.split('## Active Task').length - 1, 1, 'exactly one Active Task section');
  assert.ok(content.includes('Dan Dawson') && content.includes('Eve Ellis'), 'keeps the latest list');
  assert.ok(!content.includes('Alice Anderson'), 'old list replaced (last-writer-wins)');
  assert.ok(content.includes('## Focus') && content.includes('Keep going.'), 'pre-existing content preserved');
});

test('readActiveTaskSection drops a stale (past-TTL) spec', () => {
  const sid = 'sess-at-stale';
  writeActiveTaskSection(sid, {
    capturedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), // 7h ago > 6h TTL
    verb: 'send', recipients: ['Alice Anderson', 'Bob Brennan'],
    constraintText: 'old',
  });
  assert.equal(readActiveTaskSection(sid), undefined, 'stale spec is not returned');
  assert.equal(hasActiveTaskSection(sid), false);
});

test('writeActiveTaskSection / reconcileActiveTask are best-effort (never throw)', () => {
  assert.doesNotThrow(() => reconcileActiveTask('', ''));
  assert.doesNotThrow(() => reconcileActiveTask('sess-at-empty', 'just chatting'));
  assert.doesNotThrow(() => dropActiveTaskSection('does-not-exist'));
});

// ─── Active Task: carry-forward + global-file leak guard ─────────────────────

test('refreshWorkingMemory carries forward a live Active Task section', () => {
  const sid = 'sess-at-carry';
  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', count: 2, recipients: ['Alice Anderson', 'Bob Brennan'],
    constraintText: 'send 2 emails to Alice Anderson, Bob Brennan',
  });
  refreshWorkingMemory(fakeSession(sid));
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.ok(content.includes('## Active Task'), 'turn-end rewrite did NOT clobber the Active Task');
  assert.ok(content.includes('Alice Anderson') && content.includes('Bob Brennan'), 'list survives the rewrite');
  assert.ok(content.includes('## Current Session'), 'base sections rebuilt alongside it');
});

test('Active Task is NOT mirrored into the GLOBAL working-memory file (no leak)', () => {
  const sid = 'sess-at-leak';
  writeActiveTaskSection(sid, {
    capturedAt: new Date().toISOString(),
    verb: 'send', recipients: ['Secret One', 'Secret Two'],
    constraintText: 'send to Secret One, Secret Two',
  });
  refreshWorkingMemory(fakeSession(sid)); // user-facing → mirrors to global
  const perSession = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  const global = readFileSync(WORKING_MEMORY_FILE, 'utf-8');
  assert.ok(perSession.includes('## Active Task'), 'per-session file has the spec');
  assert.ok(!global.includes('## Active Task'), 'global file must NOT carry the spec');
  assert.ok(!global.includes('Secret One'), 'a session list must not leak into the global file');
});

test('refreshWorkingMemory common case (no spec) writes no Active Task section', () => {
  const sid = 'sess-at-none';
  refreshWorkingMemory(fakeSession(sid));
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.ok(!content.includes('## Active Task'), 'no spec → no Active Task section (common case unchanged)');
  assert.ok(content.includes('## Current Session') && content.includes('## Focus'), 'base sections present');
});
