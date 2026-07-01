/**
 * Run: npx tsx --test src/integrations/composio/async-job.test.ts
 *
 * Detector is validated against the REAL 2026-06-30 Composio envelopes captured
 * live from executeComposioTool (DataForSEO TASK_POST, Apify RUN_ACTOR, Firecrawl
 * CRAWL sync). A receipt must be caught; a normal/finished result must NOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectJobReceipt, asyncReceiptBanner, autoPollJob, type JobReceipt } from './async-job.js';

// Real DataForSEO TASK_POST envelope (keyword: best coffee austin).
const DFS_TASK_POST = {
  data: {
    cost: 0.0006, status_code: 20000, status_message: 'Ok.',
    tasks: [{
      cost: 0.0006, data: { api: 'serp', function: 'task_post', keyword: 'best coffee austin' },
      id: '07010725-1049-0066-0000-63bcc94a0be3', path: ['v3', 'serp', 'google', 'organic', 'task_post'],
      result: null, result_count: 0, status_code: 20100, status_message: 'Task Created.', time: '0.0040 sec.',
    }],
    tasks_count: 1, tasks_error: 0,
  },
  error: null, successful: true,
};

// Real Apify RUN_ACTOR envelope (apify~hello-world, waitForFinish=0).
const APIFY_RUN = {
  data: {
    actId: 'E2jjCZBezvAZnX8Rb', buildId: 'jt6dKCQYprWAeQKJ9', finishedAt: null,
    id: 'Rv5AM2u9CRMGBYt2P', status: 'READY', defaultDatasetId: '71epPtxtXZshtjnV4',
  },
  successful: true, error: null,
};

// Real Firecrawl CRAWL SYNC envelope (example.com) — NOT a receipt (finished, data inline).
const FIRECRAWL_SYNC_DONE = {
  data: { completed: 3, creditsUsed: 3, data: [{ markdown: '# Example Domain' }, { markdown: '…' }, { markdown: '…' }] },
  successful: true, error: null,
};

test('DataForSEO TASK_POST is detected as a queued receipt with the task id', () => {
  const r = detectJobReceipt('DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', DFS_TASK_POST);
  assert.ok(r, 'detected');
  assert.equal(r!.family, 'dataforseo');
  assert.equal(r!.jobId, '07010725-1049-0066-0000-63bcc94a0be3');
  assert.match(r!.pollGuidance, /TASK_GET/);
  assert.match(asyncReceiptBanner(r!), /QUEUED JOB/);
});

test('Apify RUN_ACTOR is detected as a queued run with the run id + dataset id', () => {
  const r = detectJobReceipt('APIFY_RUN_ACTOR', APIFY_RUN);
  assert.ok(r, 'detected');
  assert.equal(r!.family, 'apify');
  assert.equal(r!.jobId, 'Rv5AM2u9CRMGBYt2P');
  assert.equal(r!.datasetId, '71epPtxtXZshtjnV4');
  assert.match(r!.pollGuidance, /APIFY_GET_DATASET_ITEMS/);
  assert.match(r!.pollGuidance, /71epPtxtXZshtjnV4/);
});

test('a SYNC Firecrawl crawl that already finished is NOT a receipt (data is inline)', () => {
  assert.equal(detectJobReceipt('FIRECRAWL_CRAWL', FIRECRAWL_SYNC_DONE), null);
});

test('a normal successful result is NOT misdetected', () => {
  assert.equal(detectJobReceipt('GMAIL_SEND_EMAIL', { data: { id: 'msg-1', threadId: 't-1' }, successful: true }), null);
  assert.equal(detectJobReceipt('DATAFORSEO_LABS_GOOGLE_KEYWORD_OVERVIEW', { data: { tasks: [{ id: 'x', result: [{ keyword: 'k' }], status_code: 20000 }] } }), null);
  assert.equal(detectJobReceipt('APIFY_GET_ACTOR', { data: { id: 'act-1', name: 'x' } }), null, 'a non-RUN Apify GET is never a run receipt');
});

test('an Apify run that already SUCCEEDED (finishedAt set) is NOT a queued receipt', () => {
  const done = { data: { id: 'r1', status: 'SUCCEEDED', finishedAt: '2026-06-30T04:20:00Z', defaultDatasetId: 'd1' }, successful: true };
  assert.equal(detectJobReceipt('APIFY_RUN_ACTOR', done), null);
});

test('a DataForSEO error envelope is NOT a receipt', () => {
  const err = { data: { tasks: [{ id: 'x', result: null, status_code: 40400, status_message: 'Not Found.' }] } };
  assert.equal(detectJobReceipt('DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', err), null);
});

// ── A3: bounded Apify auto-poll (fake exec + injectable sleep — no real credits) ──
const APIFY_RECEIPT: JobReceipt = detectJobReceipt('APIFY_RUN_ACTOR', APIFY_RUN)!;

test('autoPollJob: Apify run polled to SUCCEEDED returns the real dataset items', async () => {
  const calls: string[] = [];
  let status = 'RUNNING';
  const exec = async (slug: string, args: Record<string, unknown>) => {
    calls.push(slug);
    if (slug === 'APIFY_GET_LIST_OF_RUNS') {
      status = status === 'RUNNING' ? 'RUNNING' : 'SUCCEEDED';
      // flip to SUCCEEDED on the 2nd status check
      if (calls.filter((c) => c === 'APIFY_GET_LIST_OF_RUNS').length >= 2) status = 'SUCCEEDED';
      return { data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status, defaultDatasetId: '71epPtxtXZshtjnV4' }] } };
    }
    if (slug === 'APIFY_GET_DATASET_ITEMS') {
      assert.equal(args.datasetId, '71epPtxtXZshtjnV4', 'fetches the run\'s own dataset');
      return { data: [{ hello: 'world' }], successful: true };
    }
    throw new Error(`unexpected slug ${slug}`);
  };
  const res = await autoPollJob(APIFY_RECEIPT, exec, { sleep: async () => {} });
  assert.equal(res.resolved, true, 'resolved to the real result');
  assert.deepEqual(res.result, { data: [{ hello: 'world' }], successful: true });
  assert.ok(calls.includes('APIFY_GET_DATASET_ITEMS'), 'fetched dataset items');
});

test('autoPollJob: a FAILED run does NOT fetch items and falls back (resolved:false)', async () => {
  const exec = async (slug: string) => {
    if (slug === 'APIFY_GET_LIST_OF_RUNS') return { data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status: 'FAILED' }] } };
    throw new Error('should not fetch dataset for a failed run');
  };
  const res = await autoPollJob(APIFY_RECEIPT, exec, { sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /FAILED/);
});

test('autoPollJob: budget overrun falls back to the corrective (resolved:false)', async () => {
  let t = 0;
  const exec = async () => ({ data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status: 'RUNNING' }] } });
  const res = await autoPollJob(APIFY_RECEIPT, exec, { now: () => (t += 30_000), sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /budget/);
});

test('autoPollJob: a non-Apify receipt is never auto-polled (DataForSEO falls back)', async () => {
  const dfs = detectJobReceipt('DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', DFS_TASK_POST)!;
  const res = await autoPollJob(dfs, async () => { throw new Error('must not poll'); }, { sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /family-not-auto-pollable/);
});
