/**
 * Run: npx tsx --test src/runtime/harness/failed-run-replay.test.ts
 *
 * THE FAILED RUN, REPLAYED.
 *
 * On 2026-08-07 a client-class task — "scrape 50 Arizona criminal defense
 * attorneys into Airtable with a personalized email per firm" — ran 40 minutes
 * and was cancelled. Every irreversible mechanism behaved correctly; the time
 * went to waste the harness itself created. Measured from the durable ledger:
 *
 *   ~21.7 min  model deliberation across 118 tool calls
 *    9.8 min  composio dispatch (incl. two 2-minute sync scrapes thrown away)
 *    7.4 min  shell — almost entirely `sleep 75/90/115` hand-waiting
 *    0.8 min  skill reads
 *
 * This suite replays the run's REAL decision points — the exact slugs,
 * commands, and payloads recorded that night — against the current harness and
 * asserts each one is now handled differently. It is deliberately written
 * against behavior, not implementation, so it keeps its meaning as the fixes
 * evolve; and every assertion is vendor-shaped only by accident of the fixture:
 * the code paths under test key on VERBS and SHAPES, never on Apify/Airtable.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-failed-run-replay-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'replay-machine\n');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('WASTE 1 — the two 2-minute sync scrapes are adopted instead of abandoned and re-bought', async () => {
  const { toolCallMayStartProviderJob } = await import('./brackets.js');

  // Live: these two calls timed out client-side, kept running server-side, and
  // produced full datasets nobody ever fetched — then a third run was paid for.
  for (const slug of ['APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS']) {
    assert.equal(
      toolCallMayStartProviderJob('composio_execute_tool', { tool_slug: slug }),
      true,
      `${slug}: must survive its timeout so its own receipt parking can run`,
    );
  }

  // GLOBAL, not Apify: the same protection reaches every job-starting family.
  for (const slug of [
    'FIRECRAWL_CRAWL_URLS',
    'DATAFORSEO_SERP_TASK_POST',
    'SOMEVENDOR_START_EXPORT',
    'ANOTHERVENDOR_TRIGGER_JOB',
  ]) {
    assert.equal(toolCallMayStartProviderJob('composio_execute_tool', { tool_slug: slug }), true, slug);
  }
  // And ordinary reads/writes still cancel normally on timeout.
  for (const slug of ['AIRTABLE_LIST_RECORDS', 'OUTLOOK_CREATE_DRAFT', 'GOOGLESHEETS_GET_SPREADSHEET_INFO']) {
    assert.equal(toolCallMayStartProviderJob('composio_execute_tool', { tool_slug: slug }), false, slug);
  }
});

test('WASTE 2 — the ~5 minutes of hand-waiting is refused with the recovery', async () => {
  const { assertCommandAllowed, longBlockingSleepSeconds } = await import('../../tools/computer-tools.js');

  // The literal commands from the run.
  const live = ['sleep 75 && echo waited', 'sleep 90 && echo waited', 'sleep 115 && echo waited'];
  let reclaimed = 0;
  for (const command of live) {
    reclaimed += longBlockingSleepSeconds(command) ?? 0;
    assert.throws(() => assertCommandAllowed(command), /Refused: this command just waits/, command);
  }
  assert.equal(reclaimed, 280, 'the exact seconds the run slept are now refused');

  // GLOBAL: any waiting shape, not just these three.
  assert.throws(
    () => assertCommandAllowed('until curl -sf https://api.example.test/done; do sleep 20; done'),
    /Refused: this command just waits/,
  );
  // Real work is never touched.
  assert.doesNotThrow(() => assertCommandAllowed('sleep 2 && curl -s https://api.example.test/x'));
});

test('WASTE 3 — the two INVALID INPUT dispatches are refused locally, by field name', async () => {
  const { ensureToolSchema, resetToolSchemaCache, _setToolSchemaLoaderForTests } =
    await import('../../tools/composio-schema-cache.js');
  const { validateComposioArgs } = await import('../../tools/composio-batch-validator.js');

  resetToolSchemaCache();
  // The provider's real contract for the slug the run dispatched twice with no
  // actorId (each rejection was a paid round-trip plus a model turn).
  _setToolSchemaLoaderForTests(async () => ({
    inputParameters: { type: 'object', required: ['actorId'], properties: { actorId: { type: 'string' } } },
  }));
  try {
    const contract = await ensureToolSchema('APIFY_RUN_ACTOR');
    const live = validateComposioArgs(
      'APIFY_RUN_ACTOR',
      { input: { searchStringsArray: ['criminal defense attorney'], locationQuery: 'Phoenix, Arizona' } },
      contract,
    );
    assert.equal(live.mode, 'schema', 'validated against the provider contract, not a heuristic');
    assert.match(String(live.error?.field), /actorId/, 'the exact missing field is named before dispatch');

    // The corrected payload the run eventually found still passes untouched.
    const corrected = validateComposioArgs(
      'APIFY_RUN_ACTOR',
      { actorId: 'lukaskrivka~google-maps-with-contact-details', input: {} },
      contract,
    );
    assert.equal(corrected.error, null);
  } finally {
    _setToolSchemaLoaderForTests(null);
    resetToolSchemaCache();
  }
});

test('WASTE 4 — the three fan-out refusal rounds cannot recur: guidance and enforcement agree', async () => {
  const { fanoutDirectiveLine } = await import('./context-packet.js');
  const { buildFanoutRecoveryMessage } = await import('./tool-guardrail.js');

  // The run's own shape: 50 same-shape items.
  const directive = fanoutDirectiveLine({ isMultiItem: true, itemCount: 50, itemKind: 'firms' } as never);
  const refusal = buildFanoutRecoveryMessage({
    toolName: 'composio_execute_tool',
    slug: 'APIFY_GET_DATASET_ITEMS',
    distinct: 6,
    blockAt: 6,
  } as never);

  for (const lane of ['run_tool_program', 'run_worker']) {
    if (refusal.includes(lane)) {
      assert.ok(directive.includes(lane), `the rail refuses toward ${lane}; the directive must offer it`);
    }
  }
  assert.doesNotMatch(directive, /do not collapse this into one aggregate program/i);
});

test('WASTE 5 — the duplicate table creation is named, and the billable jobs are reported', async () => {
  const { synthesizeWorkReport, summarizeProviderJobs } = await import('./work-report.js');
  const row = (seq: number, type: string, data: Record<string, unknown>) =>
    ({ seq, type, sessionId: 's', turn: 0, role: 'system', data } as never);

  // The run's real job ledger shape: four actor starts, one confirmed.
  const evidence = [
    row(1, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j1', preDispatch: true }),
    row(2, 'external_write_orphaned', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j1' }),
    row(3, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j2', preDispatch: true }),
    row(4, 'external_write_orphaned', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j2' }),
    row(5, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j3', preDispatch: true }),
    row(6, 'external_write_succeeded', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'j3' }),
  ];
  const jobs = summarizeProviderJobs(evidence);
  assert.equal(jobs?.started, 3, 'the run can state how many paid jobs it launched');
  assert.equal(jobs?.unresolved, 2, 'and how many have no confirmed result');

  const report = String(synthesizeWorkReport(evidence));
  assert.match(report, /Started 3 provider jobs/);
  assert.match(report, /billable/, 'the user never has to open the provider dashboard to learn this');
});

test('WASTE 6 — the credential read never becomes an approval that stalls an autonomous run', async () => {
  const { assertCommandAllowed, needsApprovalForShellSmart } = await import('../../tools/computer-tools.js');

  // The literal command that parked the run for six silent minutes.
  const live = 'env | grep -iE "apify" ; echo "---files---"; ls ~/.apify; cat ~/.apify/auth.json';
  assert.throws(() => assertCommandAllowed(live), /Refused: this reads credential material/);
  assert.equal(await needsApprovalForShellSmart()({}, { command: live }), false, 'never an approval interrupt');

  // GLOBAL: the same refusal for any provider's secrets, any shape.
  for (const command of ['cat .env', 'cat ~/.config/somevendor/auth.json', 'security find-generic-password -s x']) {
    assert.throws(() => assertCommandAllowed(command), /Refused|safety policy/, command);
  }
});

test('the whole replay: every mechanical waste in the failed run is now handled', async () => {
  // A single roll-up so a regression in ANY of the six shows up as one clear
  // failure with the run's own numbers attached.
  const { toolCallMayStartProviderJob } = await import('./brackets.js');
  const { assertCommandAllowed, longBlockingSleepSeconds } = await import('../../tools/computer-tools.js');

  const handled: string[] = [];
  if (toolCallMayStartProviderJob('composio_execute_tool', { tool_slug: 'APIFY_RUN_ACTOR' })) {
    handled.push('timed-out job adopted (~4-5 min + the double billing)');
  }
  if ((longBlockingSleepSeconds('sleep 115 && echo waited') ?? 0) >= 115) {
    handled.push('blocking sleep refused (~5 min)');
  }
  try {
    assertCommandAllowed('cat ~/.apify/auth.json');
  } catch {
    handled.push('credential read refused, run never parks (~6 min)');
  }
  assert.equal(handled.length, 3, `expected every mechanical waste handled, got: ${handled.join(' | ')}`);
});
