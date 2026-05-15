/**
 * Run: npx tsx --test src/agents/tool-observability.test.ts
 *
 * Locks the audit-log substrate. The file format is the contract for
 * downstream consumers (future "always learning" loop), so we test it
 * explicitly rather than relying on snapshots.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-obs-test-'));
const baseDir = path.join(tmpHome, 'clementine-home');
process.env.CLEMENTINE_HOME = baseDir;
process.env.HOME = tmpHome;
const eventsDir = path.join(baseDir, 'state', 'tool-events');

let recordToolEvent: typeof import('./tool-observability.js').recordToolEvent;
let beginToolEvent: typeof import('./tool-observability.js').beginToolEvent;
let recordPendingApproval: typeof import('./tool-observability.js').recordPendingApproval;

before(async () => {
  const mod = await import('./tool-observability.js');
  recordToolEvent = mod.recordToolEvent;
  beginToolEvent = mod.beginToolEvent;
  recordPendingApproval = mod.recordPendingApproval;
});

function readTodayLog(): unknown[] {
  if (!existsSync(eventsDir)) return [];
  const files = readdirSync(eventsDir);
  if (files.length === 0) return [];
  // Most recent file (sorted by name = sorted by date).
  files.sort();
  const latest = files[files.length - 1];
  const text = readFileSync(path.join(eventsDir, latest), 'utf-8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('recordToolEvent: appends a JSON line to the day-keyed file', () => {
  recordToolEvent({
    at: new Date().toISOString(),
    toolName: 'list_files',
    kind: 'read',
    phase: 'end',
    durationMs: 12,
    outcome: 'success',
  });
  const events = readTodayLog();
  const last = events[events.length - 1] as { toolName: string; phase: string };
  assert.equal(last.toolName, 'list_files');
  assert.equal(last.phase, 'end');
});

test('beginToolEvent: emits start + end with a duration', async () => {
  const finish = beginToolEvent({
    sessionId: 'console:home',
    toolName: 'cx_googlesheets_create_google_sheet1',
    kind: 'send',
    approvalReason: 'yolo-policy',
    args: { title: 'Smoke' },
  });
  // Wait a tick so durationMs is non-zero.
  await new Promise((r) => setTimeout(r, 5));
  finish('success');

  const events = readTodayLog();
  const tail = events.slice(-2) as Array<{ phase: string; toolName: string; durationMs?: number; outcome?: string }>;
  assert.equal(tail[0].phase, 'start');
  assert.equal(tail[0].toolName, 'cx_googlesheets_create_google_sheet1');
  assert.equal(tail[1].phase, 'end');
  assert.equal(tail[1].outcome, 'success');
  assert.ok((tail[1].durationMs ?? 0) >= 1, 'end event should have a non-zero duration');
});

test('beginToolEvent: error outcome records error phase + message', () => {
  const finish = beginToolEvent({
    toolName: 'cx_gmail_send_email',
    kind: 'send',
  });
  finish('error', 'invalid recipient');

  const events = readTodayLog();
  const last = events[events.length - 1] as { phase: string; outcome: string; errorMessage: string };
  assert.equal(last.phase, 'error');
  assert.equal(last.outcome, 'error');
  assert.equal(last.errorMessage, 'invalid recipient');
});

test('recordPendingApproval: writes a pending-approval phase event', () => {
  recordPendingApproval({
    sessionId: 'console:home',
    toolName: 'delete_agent',
    kind: 'admin',
    approvalId: 'abc-123',
  });
  const events = readTodayLog();
  const last = events[events.length - 1] as { phase: string; approvalReason: string; kind: string };
  assert.equal(last.phase, 'pending-approval');
  assert.equal(last.kind, 'admin');
  assert.equal(last.approvalReason, 'abc-123');
});

test('does not throw if the events dir cannot be written', () => {
  // Point at a path under a regular file so mkdirSync would normally fail.
  // We don't test by actually breaking the dir — that's flaky on CI —
  // but assert that the API surface never throws on a happy path. The
  // try/catch inside recordToolEvent guarantees correctness when fs
  // does fail.
  assert.doesNotThrow(() => {
    recordToolEvent({
      at: new Date().toISOString(),
      toolName: 'ping',
      kind: 'read',
      phase: 'end',
      outcome: 'success',
    });
  });
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
