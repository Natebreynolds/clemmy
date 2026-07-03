/**
 * Run: npx tsx --test src/integrations/composio/job-watcher.test.ts
 *
 * The Composio background job-watcher: park (create + immediately RUNNING), dedup,
 * a deterministic tick that polls the S1 recipe once and delivers/blocks/fails via
 * the background-task store, and single-owner cleanup when the task leaves 'running'.
 *
 * CLEMENTINE_HOME → mkdtemp BEFORE any src import (BINDING) so nothing touches real
 * state; every store below (background-tasks, notifications, sessions) lands in temp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-jobwatch-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const JOB_DIR = path.join(TMP_HOME, 'state', 'composio-jobs');

const {
  parkComposioJob,
  processComposioJobWatchTick,
  composioBgDeferEnabled,
  humanJobNotification,
} = await import('./job-watcher.js');
const { getBackgroundTask, listBackgroundTasks, updateBackgroundTask } = await import('../../execution/background-tasks.js');
const { listNotifications } = await import('../../runtime/notifications.js');
import type { JobReceipt } from './async-job.js';
import type { ComposioJobRecord } from './job-watcher.js';

const rec = (over: Partial<ComposioJobRecord> = {}): ComposioJobRecord =>
  ({ family: 'firecrawl', jobId: 'j-1', ...over } as ComposioJobRecord);

function jobFiles(): string[] {
  return existsSync(JOB_DIR) ? readdirSync(JOB_DIR).filter((f) => f.endsWith('.json')) : [];
}

const fcReceipt = (jobId = 'fc-1'): JobReceipt => ({
  family: 'firecrawl',
  jobId,
  status: 'scraping',
  originSlug: 'FIRECRAWL_CRAWL_URLS',
  pollGuidance: `Poll FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB (id="${jobId}") until completed.`,
});

const ctx = (over: Record<string, unknown> = {}) => ({ toolSlug: 'FIRECRAWL_CRAWL_URLS', connectionId: 'conn-abc', ...over });

test('parkComposioJob: creates a durable record and an immediately-RUNNING task', () => {
  const parked = parkComposioJob(fcReceipt('fc-park'), ctx());
  assert.ok(parked, 'parked');
  assert.equal(parked!.deduped, false);
  const task = getBackgroundTask(parked!.taskId);
  assert.ok(task, 'task exists');
  assert.equal(task!.status, 'running', 'immediately RUNNING so the drain never spawns an LLM');
  assert.ok(task!.prompt.includes('fc-park'), 'self-contained poll prompt carries the job id');
  assert.ok(jobFiles().some((f) => f.startsWith('firecrawl-fc-park')), 'record file written');
});

test('parkComposioJob: dedups by family:jobId while the task is non-terminal', () => {
  const first = parkComposioJob(fcReceipt('fc-dedup'), ctx());
  const second = parkComposioJob(fcReceipt('fc-dedup'), ctx());
  assert.ok(first && second);
  assert.equal(second!.taskId, first!.taskId, 'same task reused');
  assert.equal(second!.deduped, true);
  const records = jobFiles().filter((f) => f.startsWith('firecrawl-fc-dedup'));
  assert.equal(records.length, 1, 'exactly one record');
});

test('tick: a completed job marks the task DONE and deletes the record', async () => {
  const parked = parkComposioJob(fcReceipt('fc-done'), ctx());
  assert.ok(parked);
  const exec = async (slug: string, args: Record<string, unknown>, connectionId?: string) => {
    assert.equal(slug, 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB');
    assert.equal(args.id, 'fc-done');
    assert.equal(connectionId, 'conn-abc', 'exec is bound to the record connectionId');
    return { data: { status: 'completed', data: [{ markdown: '# a' }, { markdown: '# b' }] } };
  };
  const processed = await processComposioJobWatchTick(exec);
  assert.ok(processed >= 1, 'processed the due record');
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'done');
  assert.match(task!.result ?? '', /2 items/, 'done summary reports the item count');
  assert.ok(!jobFiles().some((f) => f.startsWith('firecrawl-fc-done')), 'record deleted on terminal');

  // The HUMAN notification is conversational, not the raw JSON dump.
  const note = listNotifications(200).find((n) => n.metadata?.backgroundTaskId === parked!.taskId);
  assert.ok(note, 'completion notification exists');
  assert.match(note!.body, /Your firecrawl job finished — 2 items retrieved\./, 'conversational sentence');
  assert.doesNotMatch(note!.body, /[{}]/, 'no raw JSON in the human body');
});

test('humanJobNotification: sentence + up to 3 readable preview lines from object items', () => {
  const result = {
    items: [
      { url: 'https://acme.example/pricing', title: 'Pricing', wordCount: 812 },
      { url: 'https://acme.example/about', title: 'About Us' },
      { url: 'https://acme.example/blog', title: 'Blog' },
      { url: 'https://acme.example/contact', title: 'Contact' },
    ],
  };
  const body = humanJobNotification(rec({ family: 'firecrawl' }), result);
  assert.match(body, /^Your firecrawl job finished — 4 items retrieved\./);
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3, 'caps the preview at 3 lines');
  assert.match(lines[0], /url: https:\/\/acme\.example\/pricing/);
  assert.match(lines[0], /title: Pricing/);
  assert.doesNotMatch(body, /[{}]/, 'no raw JSON');
});

test('humanJobNotification: degrades to just the sentence when items are not readable', () => {
  assert.equal(humanJobNotification(rec({ family: 'apify' }), 'not-an-array'), 'Your apify job finished.');
  assert.equal(
    humanJobNotification(rec({ family: 'dataforseo' }), { data: [] }),
    'Your dataforseo job finished — 0 items retrieved.',
  );
});

test('tick: a terminally-failed job marks the task FAILED and deletes the record', async () => {
  const parked = parkComposioJob(fcReceipt('fc-fail'), ctx());
  assert.ok(parked);
  const exec = async () => ({ data: { status: 'failed' } });
  await processComposioJobWatchTick(exec);
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'failed');
  assert.match(task!.error ?? '', /crawl failed/i);
  assert.ok(!jobFiles().some((f) => f.startsWith('firecrawl-fc-fail')), 'record deleted');
});

test('tick: a still-pending job heartbeats and keeps the record for the next tick', async () => {
  const parked = parkComposioJob(fcReceipt('fc-pending'), ctx());
  assert.ok(parked);
  const exec = async () => ({ data: { status: 'scraping' } });
  await processComposioJobWatchTick(exec);
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'running', 'still running');
  assert.ok((task!.progressCheckIns ?? 0) >= 1, 'heartbeat recorded');
  assert.match(task!.lastCheckInMessage ?? '', /poll #/, 'heartbeat message on the board');
  assert.ok(jobFiles().some((f) => f.startsWith('firecrawl-fc-pending')), 'record kept');
});

test('tick: past the deadline the task is BLOCKED with id-bearing guidance', async () => {
  process.env.CLEMMY_COMPOSIO_JOB_WATCH_MAX_MS = '1'; // deadline ~= park time
  let parked;
  try {
    parked = parkComposioJob(fcReceipt('fc-deadline'), ctx());
  } finally {
    delete process.env.CLEMMY_COMPOSIO_JOB_WATCH_MAX_MS;
  }
  assert.ok(parked);
  // exec must NOT be called — the deadline check precedes polling.
  const exec = async () => { throw new Error('should not poll past the deadline'); };
  await processComposioJobWatchTick(exec, { now: () => Date.now() + 60_000 });
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'blocked');
  assert.match(task!.error ?? '', /fc-deadline/, 'blocker names the job id');
  assert.ok(!jobFiles().some((f) => f.startsWith('firecrawl-fc-deadline')), 'record deleted');
});

test('tick: an externally-cancelled task drops the record (exactly one owner)', async () => {
  const parked = parkComposioJob(fcReceipt('fc-cancel'), ctx());
  assert.ok(parked);
  // Simulate the task being cancelled/resumed elsewhere → no longer 'running'.
  updateBackgroundTask(parked!.taskId, { status: 'aborted' });
  const exec = async () => { throw new Error('should not poll a task we no longer own'); };
  await processComposioJobWatchTick(exec);
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'aborted', 'the watcher did not touch the task');
  assert.ok(!jobFiles().some((f) => f.startsWith('firecrawl-fc-cancel')), 'record dropped');
});

// ── Generic family: the watcher polls a parked generic job with its inferred id-arg ──
const genericReceipt = (jobId = 'g-1'): JobReceipt => ({
  family: 'generic',
  jobId,
  status: 'queued',
  originSlug: 'MYTOOL_CREATE_JOB',
  generic: true,
  pollGuidance: `Poll MYTOOL_JOB_STATUS with the id "${jobId}".`,
  // The wiring rides the resolved getter + its id-arg into the record via the receipt.
  getterSlug: 'MYTOOL_JOB_STATUS',
  idArg: 'job_id',
} as JobReceipt & { getterSlug: string; idArg: string });

test('tick: a parked GENERIC job polls its getter with the inferred id-arg and completes', async () => {
  const parked = parkComposioJob(genericReceipt('g-done'), { toolSlug: 'MYTOOL_CREATE_JOB', connectionId: 'conn-g' });
  assert.ok(parked, 'parked');
  const exec = async (slug: string, args: Record<string, unknown>, connectionId?: string) => {
    assert.equal(slug, 'MYTOOL_JOB_STATUS', 'uses the cached getter slug (no re-discovery)');
    assert.equal(args.job_id, 'g-done', 'polls with the inferred id-arg name, not a hardcoded "id"');
    assert.equal(connectionId, 'conn-g');
    return { data: { status: 'completed', results: [{ ok: 1 }] } };
  };
  await processComposioJobWatchTick(exec);
  const task = getBackgroundTask(parked!.taskId);
  assert.equal(task!.status, 'done');
  assert.ok(!jobFiles().some((f) => f.startsWith('generic-g-done')), 'record deleted on terminal');
});

test('parkComposioJob: flag off → no-op (null) so the call-site keeps the banner', () => {
  process.env.CLEMMY_COMPOSIO_BG_DEFER = 'off';
  try {
    assert.equal(composioBgDeferEnabled(), false);
    const before = listBackgroundTasks().length;
    const parked = parkComposioJob(fcReceipt('fc-off'), ctx());
    assert.equal(parked, null, 'no park when the flag is off');
    assert.equal(listBackgroundTasks().length, before, 'no task created');
    assert.ok(!jobFiles().some((f) => f.startsWith('firecrawl-fc-off')), 'no record written');
  } finally {
    delete process.env.CLEMMY_COMPOSIO_BG_DEFER;
  }
});
