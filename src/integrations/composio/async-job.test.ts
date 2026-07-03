/**
 * Run: npx tsx --test src/integrations/composio/async-job.test.ts
 *
 * Detector is validated against the REAL 2026-06-30 Composio envelopes captured
 * live from executeComposioTool (DataForSEO TASK_POST, Apify RUN_ACTOR, Firecrawl
 * CRAWL sync). A receipt must be caught; a normal/finished result must NOT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectJobReceipt,
  asyncReceiptBanner,
  autoPollJob,
  pickDataforseoGetterSlug,
  pickSiblingGetterSlug,
  pollJobToResolution,
  checkJobOnce,
  resolveJobGetter,
  registerJobFamily,
  recipeFor,
  type JobReceipt,
  type ComposioToolkitTool,
  type JobFamilyRecipe,
} from './async-job.js';

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

// ── S1: DataForSEO runtime getter discovery ──────────────────────────────────────
const DFS_BASE = 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC';
const tool = (slug: string, inputParameters?: unknown): ComposioToolkitTool => ({ slug, name: slug, inputParameters });

test('pickDataforseoGetterSlug: prefers ADVANCED over REGULAR/GET/HTML', () => {
  const tools = [
    tool(`${DFS_BASE}_TASK_GET_HTML`),
    tool(`${DFS_BASE}_TASK_GET_REGULAR`),
    tool(`${DFS_BASE}_TASK_GET_ADVANCED`),
    tool(`${DFS_BASE}_TASK_GET`),
    tool('DATAFORSEO_UNRELATED_ACTION'),
  ];
  assert.equal(pickDataforseoGetterSlug(`${DFS_BASE}_TASK_POST`, tools), `${DFS_BASE}_TASK_GET_ADVANCED`);
});

test('pickDataforseoGetterSlug: zero candidates → null (never invents a slug)', () => {
  assert.equal(pickDataforseoGetterSlug(`${DFS_BASE}_TASK_POST`, [tool('DATAFORSEO_SOMETHING_ELSE')]), null);
  assert.equal(pickDataforseoGetterSlug(`${DFS_BASE}_TASK_POST`, []), null);
});

test('pickDataforseoGetterSlug: ambiguous unknown variants → null', () => {
  const tools = [tool(`${DFS_BASE}_TASK_GET_FOO`), tool(`${DFS_BASE}_TASK_GET_BAR`)];
  assert.equal(pickDataforseoGetterSlug(`${DFS_BASE}_TASK_POST`, tools), null);
});

test('pickDataforseoGetterSlug: drops a getter whose schema explicitly lacks an id param', () => {
  const tools = [
    tool(`${DFS_BASE}_TASK_GET_ADVANCED`, { properties: { keyword: {} } }), // no id → dropped
    tool(`${DFS_BASE}_TASK_GET_REGULAR`, { properties: { id: {} } }),        // has id → kept
  ];
  assert.equal(pickDataforseoGetterSlug(`${DFS_BASE}_TASK_POST`, tools), `${DFS_BASE}_TASK_GET_REGULAR`);
});

test('resolveJobGetter: DataForSEO discovers the getter via an injected toolkit list', async () => {
  const dfs = detectJobReceipt(`${DFS_BASE}_TASK_POST`, DFS_TASK_POST)!;
  const plan = await resolveJobGetter(dfs, async () => { throw new Error('exec unused'); }, {
    listToolkitTools: async () => [tool(`${DFS_BASE}_TASK_GET_ADVANCED`), tool(`${DFS_BASE}_TASK_GET_REGULAR`)],
  });
  assert.equal(plan?.getterSlug, `${DFS_BASE}_TASK_GET_ADVANCED`);
});

// ── S1: DataForSEO checkOnce + shared-loop poll ───────────────────────────────────
const dfsReceipt = (): JobReceipt => detectJobReceipt(`${DFS_BASE}_TASK_POST`, DFS_TASK_POST)!;
const dfsPlan = { getterSlug: `${DFS_BASE}_TASK_GET_ADVANCED` };
const DFS_GETTER_LIST = async () => [tool(`${DFS_BASE}_TASK_GET_ADVANCED`)];

test('checkJobOnce: DataForSEO done when status_code 20000 + non-null result', async () => {
  const exec = async (slug: string, args: Record<string, unknown>) => {
    assert.equal(slug, `${DFS_BASE}_TASK_GET_ADVANCED`);
    assert.equal(args.id, dfsReceipt().jobId);
    return { data: { tasks: [{ id: dfsReceipt().jobId, status_code: 20000, result: [{ keyword: 'k', rank: 1 }] }] } };
  };
  const check = await checkJobOnce(dfsPlan, dfsReceipt(), exec);
  assert.equal(check.state, 'done');
  assert.ok(check.result, 'carries the real payload');
});

test('checkJobOnce: DataForSEO pending while still queued (20100 / null result)', async () => {
  const exec = async () => ({ data: { tasks: [{ id: dfsReceipt().jobId, status_code: 20100, result: null }] } });
  const check = await checkJobOnce(dfsPlan, dfsReceipt(), exec);
  assert.equal(check.state, 'pending');
});

test('checkJobOnce: DataForSEO error status_code is terminal-bad', async () => {
  const exec = async () => ({ data: { tasks: [{ id: dfsReceipt().jobId, status_code: 40501, result: null }] } });
  const check = await checkJobOnce(dfsPlan, dfsReceipt(), exec);
  assert.equal(check.state, 'failed');
  assert.match(check.reason ?? '', /40501/);
});

test('pollJobToResolution: DataForSEO polled to done returns the real result', async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls < 2) return { data: { tasks: [{ id: dfsReceipt().jobId, status_code: 20100, result: null }] } };
    return { data: { tasks: [{ id: dfsReceipt().jobId, status_code: 20000, result: [{ keyword: 'k' }] }] } };
  };
  const res = await pollJobToResolution(dfsReceipt(), exec, { listToolkitTools: DFS_GETTER_LIST, sleep: async () => {} });
  assert.equal(res.resolved, true);
  assert.ok(res.result);
});

test('pollJobToResolution: an unrecognized/never-ready DataForSEO shape falls back at budget', async () => {
  let t = 0;
  const exec = async () => ({ data: { weird: 'shape' } }); // no tasks[] → pending forever
  const res = await pollJobToResolution(dfsReceipt(), exec, {
    listToolkitTools: DFS_GETTER_LIST,
    now: () => (t += 30_000),
    sleep: async () => {},
  });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /budget-exceeded/);
});

test('pollJobToResolution: DataForSEO with no discoverable getter falls back (never worse than banner)', async () => {
  const res = await pollJobToResolution(dfsReceipt(), async () => ({}), { listToolkitTools: async () => [], sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /dataforseo-getter-not-found/);
});

// ── S1: Firecrawl poll recipe ─────────────────────────────────────────────────────
const FIRECRAWL_INPROGRESS = { data: { id: 'fc-123', status: 'scraping', data: [] }, successful: true };
const fcReceipt = (): JobReceipt => detectJobReceipt('FIRECRAWL_CRAWL_URLS', FIRECRAWL_INPROGRESS)!;

test('Firecrawl in-progress crawl is detected as a receipt', () => {
  const r = fcReceipt();
  assert.equal(r.family, 'firecrawl');
  assert.equal(r.jobId, 'fc-123');
});

test('checkJobOnce: Firecrawl completed → done; failed/cancelled → terminal-bad', async () => {
  const done = await checkJobOnce({ getterSlug: 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB' }, fcReceipt(),
    async (slug, args) => {
      assert.equal(slug, 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB');
      assert.equal(args.id, 'fc-123');
      return { data: { status: 'completed', data: [{ markdown: '# p' }] } };
    });
  assert.equal(done.state, 'done');
  assert.ok(done.result);

  const failed = await checkJobOnce({ getterSlug: 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB' }, fcReceipt(),
    async () => ({ data: { status: 'failed' } }));
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason ?? '', /failed/);
});

// ── S1: one-entry extensibility (a fake 4th family) ───────────────────────────────
test('registerJobFamily: a 4th family plugs in with one entry (detect + poll)', async () => {
  const fourth: JobFamilyRecipe = {
    family: 'fakefam',
    detect(s, d, slug) {
      if (!s.startsWith('FAKEFAM')) return null;
      if (typeof d.job_id === 'string' && d.done !== true) {
        return { family: 'fakefam', jobId: d.job_id, originSlug: slug, pollGuidance: `poll fake job ${d.job_id}` };
      }
      return null;
    },
    poll: {
      inlineAutoResolve: true,
      unresolvableReason: 'fakefam-unresolvable',
      async resolveGetter() { return { getterSlug: 'FAKEFAM_GET' }; },
      async checkOnce(_plan, receipt, exec) {
        const r = (await exec('FAKEFAM_GET', { id: receipt.jobId })) as { done?: boolean; payload?: unknown };
        return r.done ? { state: 'done', result: r.payload } : { state: 'pending' };
      },
    },
  };
  const dispose = registerJobFamily(fourth);
  try {
    assert.ok(recipeFor('fakefam'), 'registered');
    const receipt = detectJobReceipt('FAKEFAM_START_JOB', { data: { job_id: 'f-9', done: false } });
    assert.ok(receipt, 'detected via the registry');
    assert.equal(receipt!.family, 'fakefam');
    // Inline auto-resolve drives the fake family through the SAME shared loop.
    let n = 0;
    const exec = async () => (++n >= 2 ? { done: true, payload: { ok: 1 } } : { done: false });
    const res = await autoPollJob(receipt!, exec, { sleep: async () => {} });
    assert.equal(res.resolved, true);
    assert.deepEqual(res.result, { ok: 1 });
  } finally {
    dispose();
  }
  assert.equal(recipeFor('fakefam'), undefined, 'disposer removed it');
});

// ── Generic (family-agnostic) receipt detection ───────────────────────────────────
// The generic detector must catch an UNAMBIGUOUS queued receipt from an UNKNOWN
// toolkit (id + non-terminal status + no payload) while NEVER firing on a normal
// completed result — false positives here are very costly, so these adversarial
// negatives are the load-bearing tests.

test('generic: an unknown-toolkit receipt (id + pending status + no payload) is detected', () => {
  const r = detectJobReceipt('HEYGEN_CREATE_AVATAR_VIDEO', { data: { video_id: 'vid_42', status: 'pending' }, successful: true });
  assert.ok(r, 'detected');
  assert.equal(r!.family, 'generic');
  assert.equal(r!.generic, true);
  assert.equal(r!.jobId, 'vid_42');
  assert.match(asyncReceiptBanner(r!), /QUEUED RECEIPT/);
  assert.match(r!.pollGuidance, /vid_42/);
});

test('generic: a nested small envelope carrying id + status is detected', () => {
  const r = detectJobReceipt('SOMEAPP_START_EXPORT', { data: { job: { id: 'exp_9', status: 'processing' } } });
  assert.ok(r, 'detected via one-level nesting');
  assert.equal(r!.jobId, 'exp_9');
});

test('generic: an explicit async marker (id + async:true, no status) is detected', () => {
  const r = detectJobReceipt('SOMEAPP_ENQUEUE_TASK', { data: { request_id: 'req_7', async: true } });
  assert.ok(r);
  assert.equal(r!.jobId, 'req_7');
});

test('generic NEGATIVE: an id alone (no status, no async marker) is NOT a receipt', () => {
  assert.equal(detectJobReceipt('SOMEAPP_CREATE_CONTACT', { data: { id: 'c_1', name: 'Ada' } }), null);
});

test('generic NEGATIVE: a pending status WITH a populated payload is NOT a receipt', () => {
  assert.equal(detectJobReceipt('SOMEAPP_LIST_THINGS', { data: { id: 'x', status: 'processing', results: [{ a: 1 }] } }), null);
  assert.equal(detectJobReceipt('SOMEAPP_GET_ITEMS', { data: { id: 'x', status: 'running', items: [{ a: 1 }] } }), null);
  assert.equal(detectJobReceipt('SOMEAPP_GET_DATA', { data: { id: 'x', status: 'queued', output: { big: 'payload' } } }), null);
});

test('generic NEGATIVE: a terminal status (completed/succeeded/sent) is NOT a receipt', () => {
  assert.equal(detectJobReceipt('SOMEAPP_RUN', { data: { id: 'x', status: 'completed' } }), null);
  assert.equal(detectJobReceipt('SOMEAPP_RUN', { data: { id: 'x', status: 'succeeded' } }), null);
  assert.equal(detectJobReceipt('EMAIL_SEND', { data: { id: 'm_1', status: 'sent' } }), null);
});

test('generic NEGATIVE: an ambiguous entity state ("active") is NOT treated as a receipt', () => {
  // A user/record that merely carries status "active" must never trip the detector.
  assert.equal(detectJobReceipt('SOMEAPP_GET_USER', { data: { id: 'u_1', status: 'active' } }), null);
});

test('generic NEGATIVE: an array of items each with a status field is NOT a receipt', () => {
  assert.equal(detectJobReceipt('SOMEAPP_SEARCH', { data: [{ id: 1, status: 'running' }, { id: 2, status: 'running' }] }), null);
});

test('generic does NOT shadow a known family (DataForSEO receipt still resolves as dataforseo)', () => {
  const r = detectJobReceipt('DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', DFS_TASK_POST);
  assert.equal(r!.family, 'dataforseo', 'known family wins over generic');
});

// ── Generic sibling-getter inference ──────────────────────────────────────────────
test('pickSiblingGetterSlug: infers the *_STATUS sibling from the start stem, prefers STATUS>RESULT>GET', () => {
  const tools = [
    tool('SOMEAPP_START_EXPORT'),
    tool('SOMEAPP_EXPORT_GET'),
    tool('SOMEAPP_EXPORT_RESULT'),
    tool('SOMEAPP_EXPORT_STATUS'),
    tool('SOMEAPP_UNRELATED'),
  ];
  assert.equal(pickSiblingGetterSlug('SOMEAPP_START_EXPORT', tools), 'SOMEAPP_EXPORT_STATUS');
});

test('pickSiblingGetterSlug: infers across prefix/infix verbs and needs an identity token', () => {
  // infix verb (CREATE) — matches on the JOB identity token
  assert.equal(
    pickSiblingGetterSlug('MYTOOL_CREATE_JOB', [tool('MYTOOL_JOB_STATUS'), tool('MYTOOL_UNRELATED')]),
    'MYTOOL_JOB_STATUS',
  );
  // only toolkit + verb, no identity noun → cannot match safely → null
  assert.equal(pickSiblingGetterSlug('MYTOOL_RUN', [tool('MYTOOL_STATUS')]), null);
  // a candidate in a DIFFERENT toolkit is never chosen
  assert.equal(pickSiblingGetterSlug('MYTOOL_START_EXPORT', [tool('OTHERTOOL_EXPORT_STATUS')]), null);
});

test('pickSiblingGetterSlug: zero siblings, or a tie at the best rank → null', () => {
  assert.equal(pickSiblingGetterSlug('SOMEAPP_START_EXPORT', [tool('SOMEAPP_UNRELATED')]), null);
  // Two distinct *_STATUS siblings share the best rank → ambiguous → bail.
  const tie = [tool('SOMEAPP_EXPORT_STATUS'), tool('SOMEAPP_EXPORT_JOB_STATUS')];
  assert.equal(pickSiblingGetterSlug('SOMEAPP_START_EXPORT', tie), null);
});

test('resolveJobGetter (generic): discovers the sibling getter + its id-arg name from schema', async () => {
  const receipt = detectJobReceipt('MYTOOL_CREATE_JOB', { data: { job_id: 'j_1', status: 'queued' } })!;
  const plan = await resolveJobGetter(receipt, async () => { throw new Error('exec unused'); }, {
    listToolkitTools: async () => [
      tool('MYTOOL_CREATE_JOB'),
      tool('MYTOOL_JOB_STATUS', { properties: { job_id: {} }, required: ['job_id'] }),
    ],
  });
  assert.equal(plan?.getterSlug, 'MYTOOL_JOB_STATUS');
  assert.equal(plan?.idArg, 'job_id', 'poll arg name inferred from the getter schema');
});

test('checkJobOnce (generic): terminal payload → done; fail status → failed; queued → pending', async () => {
  const receipt = detectJobReceipt('MYTOOL_CREATE_JOB', { data: { job_id: 'j_1', status: 'queued' } })!;
  const plan = { getterSlug: 'MYTOOL_JOB_STATUS', idArg: 'job_id' };

  const done = await checkJobOnce(plan, receipt, async (slug, args) => {
    assert.equal(slug, 'MYTOOL_JOB_STATUS');
    assert.equal(args.job_id, 'j_1', 'polls with the inferred id-arg name');
    return { data: { status: 'completed', results: [{ a: 1 }] } };
  });
  assert.equal(done.state, 'done');
  assert.ok(done.result);

  const pending = await checkJobOnce(plan, receipt, async () => ({ data: { status: 'running' } }));
  assert.equal(pending.state, 'pending');

  const failed = await checkJobOnce(plan, receipt, async () => ({ data: { status: 'failed' } }));
  assert.equal(failed.state, 'failed');
});

test('autoPollJob: a generic receipt is never inline-resolved (parks instead)', async () => {
  const receipt = detectJobReceipt('MYTOOL_CREATE_JOB', { data: { job_id: 'j_1', status: 'queued' } })!;
  const res = await autoPollJob(receipt, async () => { throw new Error('must not poll inline'); }, { sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /family-not-auto-pollable/);
});

// ── Inline poll cap → park transition (change #2) ─────────────────────────────────
test('autoPollJob: with parkAvailable, a still-running Apify run caps SHORT and returns budget-exceeded', async () => {
  // now advances 5s per poll; the 45s inline cap is hit long before the 240s budget,
  // so we get budget-exceeded quickly (the caller then parks). Bounded poll count proves
  // the SHORT cap, not the long one.
  let t = 0;
  let polls = 0;
  const exec = async () => { polls += 1; return { data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status: 'RUNNING' }] } }; };
  const res = await autoPollJob(APIFY_RECEIPT, exec, { parkAvailable: true, now: () => (t += 5_000), sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /budget-exceeded/);
  assert.ok(polls <= 12, `capped short (${polls} polls under the 45s cap, not the 240s budget)`);
});

test('autoPollJob: without a park target, the FULL long budget is used (blocking beats losing the result)', async () => {
  // Same 5s/poll clock; with parkAvailable false the budget is 240s, so many more polls
  // run before budget-exceeded — proving the fallback keeps the long inline budget.
  let t = 0;
  let polls = 0;
  const exec = async () => { polls += 1; return { data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status: 'RUNNING' }] } }; };
  const res = await autoPollJob(APIFY_RECEIPT, exec, { parkAvailable: false, now: () => (t += 5_000), sleep: async () => {} });
  assert.equal(res.resolved, false);
  assert.match(res.reason ?? '', /budget-exceeded/);
  assert.ok(polls > 12, `used the long budget (${polls} polls, well past the 45s cap)`);
});

test('autoPollJob: parkAvailable does NOT prevent an EARLY terminal resolve within the cap', async () => {
  // The cap only bounds the WAIT — a run that finishes fast still resolves inline.
  let n = 0;
  const exec = async (slug: string, args: Record<string, unknown>) => {
    if (slug === 'APIFY_GET_LIST_OF_RUNS') return { data: { items: [{ id: 'Rv5AM2u9CRMGBYt2P', status: (++n >= 2 ? 'SUCCEEDED' : 'RUNNING') }] } };
    if (slug === 'APIFY_GET_DATASET_ITEMS') { assert.equal(args.datasetId, '71epPtxtXZshtjnV4'); return { data: [{ ok: 1 }] }; }
    throw new Error(`unexpected ${slug}`);
  };
  const res = await autoPollJob(APIFY_RECEIPT, exec, { parkAvailable: true, sleep: async () => {} });
  assert.equal(res.resolved, true);
  assert.deepEqual(res.result, { data: [{ ok: 1 }] });
});
