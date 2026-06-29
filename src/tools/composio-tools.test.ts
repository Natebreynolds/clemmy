/**
 * Run: npx tsx --test src/tools/composio-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatComposioToolOutput, formatComposioExecuteOutput, detectComposioFailure, composioThrownErrorOutput } = await import('./composio-tools.js');
const {
  closeEventLog,
  resetEventLog,
  createSession,
  getToolOutput,
} = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('formatComposioToolOutput stores full oversized JSON before returning a recallable clip', () => {
  resetEventLog();
  const sess = createSession({ kind: 'workflow' });
  const value = {
    data: {
      value: Array.from({ length: 20 }, (_, index) => ({
        id: `msg-${index}`,
        subject: `Long Outlook subject ${index}`,
        bodyPreview: 'A'.repeat(120),
      })),
    },
  };
  const full = JSON.stringify(value, null, 2);

  const output = formatComposioToolOutput(value, {
    context: { context: { sessionId: sess.id } },
    details: { toolCall: { callId: 'call_composio_full' } },
    toolName: 'composio_execute_tool',
    maxChars: 300,
  });

  assert.ok(output.length < full.length, 'model-facing output should be clipped');
  assert.match(output, /recall_tool_result\("call_composio_full"\)/);
  // List payload → the footer now reports the TRUE item count + that recall
  // returns ALL of them (the scorpion 44→4 fix), not a bare char count.
  assert.match(output, /20 value/);
  assert.match(output, /ALL 20/);

  const row = getToolOutput(sess.id, 'call_composio_full');
  assert.ok(row);
  assert.equal(row.output, full);
  assert.equal(row.contentBytes, Buffer.byteLength(full, 'utf8'));
  assert.equal(row.truncatedAtWrite, false);
});

test('formatComposioToolOutput falls back to a non-recallable clip without harness call context', () => {
  resetEventLog();
  const value = { payload: 'B'.repeat(1000) };

  const output = formatComposioToolOutput(value, { maxChars: 100 });

  assert.match(output, /truncated/);
  assert.doesNotMatch(output, /recall_tool_result/);
});

// ── composio-thrash fix: loud, self-correcting failure output ──────────

test('detectComposioFailure: flags Composio API error shapes, ignores successes', () => {
  // http_error in data (the live thrash shape)
  assert.equal(detectComposioFailure({ data: { http_error: '400 Bad Request', status_code: 400 }, error: '...' }).failed, true);
  // status_code >= 400 alone
  assert.equal(detectComposioFailure({ data: { status_code: 404 } }).failed, true);
  // top-level non-empty error string
  assert.equal(detectComposioFailure({ error: 'TargetIdShouldNotBeMeOrWhitespace' }).failed, true);
  // explicit successful:false
  assert.equal(detectComposioFailure({ successful: false, data: {} }).failed, true);

  // Successes / synthesized outputs must NOT be flagged (no-regress):
  assert.equal(detectComposioFailure({ data: { display_url: 'https://docs.google.com/…' } }).failed, false);
  assert.equal(detectComposioFailure({ data: { status_code: 200, value: [] }, error: null }).failed, false);
  assert.equal(detectComposioFailure({ error: '' }).failed, false); // empty error = success
  assert.equal(detectComposioFailure({ configured: false, message: 'not configured', matches: [] }).failed, false);
  assert.equal(detectComposioFailure('a plain string').failed, false);
});

test('detectComposioFailure: a 5-digit API "Ok" status code (DataForSEO 20000) is NOT a failure', () => {
  // Live regression (sess-mpzre9m2, 2026-06-04): a SUCCESSFUL DataForSEO call —
  // `successful:true, error:null, data.status_code:20000` ("Ok") — was flagged
  // as a HARD failure because `20000 >= 400`, so the model abandoned a 94KB
  // payload and looped across other endpoints. Must read as success.
  assert.equal(
    detectComposioFailure({
      successful: true,
      error: null,
      data: { status_code: 20000, status_message: 'Ok.', tasks: [{ data: {} }] },
    }).failed,
    false,
  );
  // Tool-agnostic: even without the explicit `successful:true` envelope, a
  // non-HTTP 5-digit code must not be misread as an HTTP error.
  assert.equal(detectComposioFailure({ data: { status_code: 20000, status_message: 'Ok.' } }).failed, false);
  // …but genuine HTTP 4xx/5xx (in-range) still flags as before (no-regress):
  assert.equal(detectComposioFailure({ data: { status_code: 404 } }).failed, true);
  assert.equal(detectComposioFailure({ data: { status_code: 500 } }).failed, true);
  // An authoritative successful:true envelope wins even over an in-range code.
  assert.equal(detectComposioFailure({ successful: true, data: { status_code: 404 } }).failed, false);
});

test('detectComposioFailure: flags the NOT-FOUND (wrong table/record/object) case distinctly', () => {
  // The live Airtable shape — fused permissions/not-found → treat as not-found.
  const air = detectComposioFailure({ successful: false, data: { http_error: '403', message: 'Airtable API error (INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND): …' } });
  assert.equal(air.failed, true);
  assert.equal(air.notFound, true);
  // Other not-found vocabularies.
  assert.equal(detectComposioFailure({ successful: false, error: 'Table "Current Prospects" not found' }).notFound, true);
  assert.equal(detectComposioFailure({ successful: false, error: 'no such object: Foo__c' }).notFound, true);
  // A plain bad-request that is NOT a not-found stays generic.
  assert.equal(detectComposioFailure({ successful: false, data: { status_code: 400, message: 'missing required field title' } }).notFound, false);
});

test('formatComposioExecuteOutput: NOT-FOUND failures tell her to DISCOVER ids, not guess', () => {
  resetEventLog();
  const notFound = { successful: false, data: { http_error: '403', message: 'Airtable API error (INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND): …' } };
  const out = formatComposioExecuteOutput(notFound, { toolSlug: 'AIRTABLE_LIST_RECORDS' });
  assert.match(out, /NOT FOUND \(slug=AIRTABLE_LIST_RECORDS\)/);
  assert.match(out, /DISCOVER the real options first/);
  assert.match(out, /AIRTABLE_GET_BASE_SCHEMA/);
  assert.match(out, /Do NOT guess/);
  // Not a generic "fix the arguments" message — it's the discovery path.
  assert.doesNotMatch(out, /SAME arguments will return the SAME error/);
});

test('formatComposioExecuteOutput: prepends a do-not-retry corrective on a failed call', () => {
  resetEventLog();
  const failed = {
    successful: false,
    error: 'Id is malformed',
    data: { http_error: '400 Client Error: Bad Request', status_code: 400, message: 'Id is malformed' },
  };
  const out = formatComposioExecuteOutput(failed, { toolSlug: 'AIRTABLE_GET_BASE_SCHEMA' });
  assert.match(out, /FAILED \(slug=AIRTABLE_GET_BASE_SCHEMA\)/);
  assert.match(out, /SAME arguments will return the SAME error/);
  assert.match(out, /Do NOT repeat this identical call/);
  // The raw payload is still present below the corrective for detail.
  assert.match(out, /400 Client Error/);
});

test('formatComposioExecuteOutput: a TIMEOUT on a long-running job steers to ASYNC start+poll, not a same-call retry', () => {
  resetEventLog();
  // The live 2026-06-24 case: a blocking sync Apify actor run exceeded the 5-min
  // tool window. The corrective must NOT say "retry this exact call once".
  const timedOut = { successful: false, error: 'tool composio_execute_tool timed out after 300000ms' };
  const out = formatComposioExecuteOutput(timedOut, { toolSlug: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS' });
  assert.match(out, /TIMED OUT \(slug=APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS\)/);
  assert.match(out, /ASYNC/i);
  assert.match(out, /poll/i);
  assert.doesNotMatch(out, /Retry this EXACT call ONCE/);
});

test('formatComposioExecuteOutput: a successful call is byte-identical to formatComposioToolOutput (no-regress)', () => {
  resetEventLog();
  const ok = { data: { display_url: 'https://docs.google.com/spreadsheets/d/abc/edit' } };
  assert.equal(
    formatComposioExecuteOutput(ok, { toolSlug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1' }),
    formatComposioToolOutput(ok, {}),
  );
});

test('detectComposioFailure: successful:true with an advisory error string is NOT a failure (hardened heuristic)', () => {
  assert.equal(detectComposioFailure({ successful: true, error: 'deprecation notice', data: {} }).failed, false);
  // …but successful:false with the same error string IS a failure.
  assert.equal(detectComposioFailure({ successful: false, error: 'deprecation notice' }).failed, true);
});

test('formatComposioExecuteOutput: header names the actual tool (cx_<slug> path), not always composio_execute_tool', () => {
  resetEventLog();
  // A generic (non-not-found) validation error → the "FAILED" corrective, named by the actual tool.
  const failed = { successful: false, data: { status_code: 400, message: 'missing required field title' } };
  const out = formatComposioExecuteOutput(failed, { toolName: 'cx_airtable_create_records', toolSlug: 'AIRTABLE_CREATE_RECORDS' });
  assert.match(out, /cx_airtable_create_records FAILED \(slug=AIRTABLE_CREATE_RECORDS\)/);
});

test('composioThrownErrorOutput: a THROWN composio error (not-found/auth/APIError) also gets the do-not-retry corrective', () => {
  resetEventLog();
  const out = composioThrownErrorOutput(
    new Error('ComposioToolNotFoundError: no such slug AIRTABLE_FROB'),
    { toolName: 'composio_execute_tool', toolSlug: 'AIRTABLE_FROB' },
  );
  // A ToolNotFound throw is a not-found → routes to the discover-the-options corrective.
  assert.match(out, /NOT FOUND \(slug=AIRTABLE_FROB\)/);
  assert.match(out, /ComposioToolNotFoundError/);
  assert.match(out, /DISCOVER the real options first|composio_search_tools/);
});

test('composioThrownErrorOutput: surfaces the SDK-hidden real cause/status instead of the generic stub (2026-06-29 Apify masking)', () => {
  resetEventLog();
  // The Composio SDK collapses .message to a generic stub and hangs the real
  // upstream detail on .cause / .statusCode / .possibleFixes. The old code read
  // only .message → the model saw nothing and fabricated an "auth issue".
  const sdkErr = Object.assign(new Error('Error executing the tool APIFY_RUN_ACTOR'), {
    statusCode: 400,
    cause: { message: 'Actor input invalid: startUrls[0].url must be a valid URL' },
    possibleFixes: ['Re-check the actor input schema'],
  });
  const out = composioThrownErrorOutput(sdkErr, { toolName: 'composio_execute_tool', toolSlug: 'APIFY_RUN_ACTOR' });
  // The real cause + status are now visible to the model (no more silent masking).
  assert.match(out, /HTTP 400/);
  assert.match(out, /Actor input invalid: startUrls/);
  assert.match(out, /Re-check the actor input schema/);
});

test('composioThrownErrorOutput: a plain error with no .cause is unchanged (no enrichment noise)', () => {
  resetEventLog();
  const out = composioThrownErrorOutput(new Error('boom'), { toolSlug: 'X_Y' });
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /HTTP \d|fixes:/); // nothing fabricated when there's no detail to surface
});


// ─── Ever-learning: tool choices memorize themselves (auto-commit) ──────
const { noteComposioSearchIntent, maybeAutoRememberComposioChoice } = await import('./composio-tools.js');
const { recallToolChoice } = await import('../memory/tool-choice-store.js');

test('auto-remember: a successful execute after a search memorizes intent→slug', async () => {
  const intent = 'get google serp organic rankings';
  noteComposioSearchIntent('sess-auto-1', intent);
  await maybeAutoRememberComposioChoice(
    'DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED',
    { keyword: 'criminal defense lawyer', location_name: 'Chattanooga' },
    { successful: true, data: { items: [] } },
    'sess-auto-1',
  );
  const rec = recallToolChoice(intent);
  assert.equal(rec?.choice?.identifier, 'DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED');
  assert.equal(rec?.choice?.kind, 'composio');
  // connection ids must never be baked into the memo
  assert.ok(!(rec?.choice?.invocationTemplate ?? '').includes('connected_account_id'));
});

test('auto-remember: a FAILED execute memorizes nothing', async () => {
  const intent = 'send an outlook email failing';
  noteComposioSearchIntent('sess-auto-2', intent);
  await maybeAutoRememberComposioChoice(
    'OUTLOOK_SEND_EMAIL',
    { to: 'x@y.com' },
    { successful: false, error: 'Invalid request data provided' },
    'sess-auto-2',
  );
  assert.equal(recallToolChoice(intent), null, 'a failed call must not be memorized');
});

test('auto-remember: an execute with NO prior search learns nothing (slug was already known/recalled)', async () => {
  const intent = 'intent-with-no-search';
  // No noteComposioSearchIntent for this session.
  await maybeAutoRememberComposioChoice('SOME_KNOWN_SLUG', {}, { successful: true }, 'sess-auto-3');
  assert.equal(recallToolChoice(intent), null);
});

test('auto-remember: a search query is single-use (a later unrelated execute is not mis-keyed)', async () => {
  const intent = 'one-shot search intent';
  noteComposioSearchIntent('sess-auto-4', intent);
  // First execute consumes the pending search.
  await maybeAutoRememberComposioChoice('FIRST_SLUG', {}, { successful: true }, 'sess-auto-4');
  // Second execute in the same session has no pending search → must not re-key.
  await maybeAutoRememberComposioChoice('SECOND_SLUG', {}, { successful: true }, 'sess-auto-4');
  const rec = recallToolChoice(intent);
  assert.equal(rec?.choice?.identifier, 'FIRST_SLUG', 'only the first execute after the search is keyed');
});

test('auto-remember is ADDITIVE: it does not overwrite an existing active choice', async () => {
  const { rememberToolChoice, recallToolChoice } = await import('../memory/tool-choice-store.js');
  const intent = 'additive guard intent';
  // A curated/active choice already exists for this intent.
  rememberToolChoice({ intent, choice: { kind: 'composio', identifier: 'CURATED_SLUG' } });
  noteComposioSearchIntent('sess-additive', intent);
  await maybeAutoRememberComposioChoice('DIFFERENT_SLUG', {}, { successful: true }, 'sess-additive');
  // The active choice is untouched — a "better option" routes through a model proposal, not a silent clobber.
  assert.equal(recallToolChoice(intent)?.choice?.identifier, 'CURATED_SLUG');
});

test('auto-remember RE-LEARNS after a choice was invalidated (choice cleared → fill again)', async () => {
  const { rememberToolChoice, invalidateToolChoice, peekToolChoice } = await import('../memory/tool-choice-store.js');
  const intent = 're-learn after invalidate intent';
  rememberToolChoice({ intent, choice: { kind: 'composio', identifier: 'OLD_SLUG' } });
  invalidateToolChoice(intent, 'failed', { automatic: true });
  assert.equal(peekToolChoice(intent)?.choice, null, 'precondition: choice invalidated');
  noteComposioSearchIntent('sess-relearn', intent);
  await maybeAutoRememberComposioChoice('NEW_WORKING_SLUG', {}, { successful: true }, 'sess-relearn');
  assert.equal(peekToolChoice(intent)?.choice?.identifier, 'NEW_WORKING_SLUG', 'auto-commit re-fills an invalidated intent');
});

test('auto-remember (v0.5.64 membership gate): a slug the search did NOT surface is NOT cached', async () => {
  const intent = 'outlook send email message';
  // Search surfaced only draft/list/forward tools — never a real send slug.
  noteComposioSearchIntent('sess-gate-1', intent, ['OUTLOOK_CREATE_DRAFT', 'OUTLOOK_FORWARD_MESSAGE', 'OUTLOOK_LIST_MESSAGES']);
  // The model executed an UNRELATED slug (a stale cache / cross-intent call).
  await maybeAutoRememberComposioChoice('AIRTABLE_LIST_RECORDS', {}, { successful: true }, 'sess-gate-1');
  assert.equal(recallToolChoice(intent), null, 'a slug not in the search candidates must not poison the intent');
});

test('auto-remember (v0.5.64 membership gate): a slug the search DID surface is cached normally', async () => {
  const intent = 'get dataforseo ranked keywords for site';
  noteComposioSearchIntent('sess-gate-2', intent, ['DATAFORSEO_LABS_GOOGLE_RANKED_KEYWORDS', 'DATAFORSEO_SERP']);
  await maybeAutoRememberComposioChoice('DATAFORSEO_LABS_GOOGLE_RANKED_KEYWORDS', {}, { successful: true }, 'sess-gate-2');
  assert.equal(recallToolChoice(intent)?.choice?.identifier, 'DATAFORSEO_LABS_GOOGLE_RANKED_KEYWORDS', 'a surfaced slug is learned');
});

// ── Cross-service mis-binding guard (2026-06-22) — the pure decision ──────────
// The fan-out "DataForSEO hard-errored" failures traced to a polluted store: a
// "DataForSEO ranked keywords" query bound to AIRTABLE_LIST_RECORDS via the
// no-candidate fallback. This guard refuses such cross-service binds.
test('isCrossServiceToolkitMismatch: refuses a DataForSEO query bound to an Airtable slug', async () => {
  const { isCrossServiceToolkitMismatch } = await import('./composio-tools.js');
  const known = ['airtable', 'dataforseo', 'salesforce', 'outlook'];
  // The exact observed pollution: query about dataforseo, slug from airtable.
  assert.equal(isCrossServiceToolkitMismatch('dataforseo ranked keywords domain organic traffic live', 'AIRTABLE_LIST_RECORDS', known), true);
  // Consistent: query names the slug's own toolkit.
  assert.equal(isCrossServiceToolkitMismatch('dataforseo ranked keywords for site', 'DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE', known), false);
  // Query names NO known toolkit (describes the task) → learning unchanged.
  assert.equal(isCrossServiceToolkitMismatch('send an email to the client', 'OUTLOOK_SEND_EMAIL', known), false);
  // Multi-toolkit query that names the slug's own toolkit too → allowed.
  assert.equal(isCrossServiceToolkitMismatch('pull from dataforseo then save to airtable', 'AIRTABLE_LIST_RECORDS', known), false);
  // No known toolkits supplied (e.g. test/offline) → never blocks.
  assert.equal(isCrossServiceToolkitMismatch('dataforseo ranked keywords', 'AIRTABLE_LIST_RECORDS', []), false);
});

test('fan-out advisory fires ONCE on the 3rd distinct-item call of the same slug', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-1';
  assert.equal(maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'item1' }, sid), null, 'item 1: no advice');
  assert.equal(maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'item2' }, sid), null, 'item 2: no advice');
  const advice = maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'item3' }, sid);
  assert.ok(advice && /run_worker/.test(advice), 'item 3: fan-out advice fires');
  // One-time per session.
  assert.equal(maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'item4' }, sid), null, 'item 4: advice does not repeat');
});

test('fan-out advisory RE-EMITS, hard-capped at 2 per bucket (P1 re-arm)', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-rearm';
  const slug = 'DATAFORSEO_SERP';
  const fires: number[] = [];
  // 12 distinct items in series; same slug + same arg-shape => one bucket.
  for (let i = 1; i <= 12; i++) {
    const advice = maybeFanoutAdvisory(slug, { q: `item${i}` }, sid);
    if (advice) fires.push(i);
  }
  // Spaced at the 3rd and 6th distinct items, then silent (cap = 2).
  assert.deepEqual(fires, [3, 6], 'must re-emit at 3 and 6, then stay capped');
  fires.forEach((i) => assert.ok(i, `fire ${i}`));
});

test('fan-out advisory keeps SEPARATE buckets per slug+arg-shape', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-buckets';
  // "10 prospects" via one shape...
  assert.equal(maybeFanoutAdvisory('TOOL_A', { url: 'p1' }, sid), null);
  assert.equal(maybeFanoutAdvisory('TOOL_A', { url: 'p2' }, sid), null);
  const aAdvice = maybeFanoutAdvisory('TOOL_A', { url: 'p3' }, sid);
  assert.ok(aAdvice, 'bucket A fires on its own 3rd item');
  // ...then "5 accounts" via a DIFFERENT shape — its own fresh bucket, not
  // suppressed by bucket A having already advised.
  assert.equal(maybeFanoutAdvisory('TOOL_B', { accountId: 'a1' }, sid), null, 'bucket B item 1');
  assert.equal(maybeFanoutAdvisory('TOOL_B', { accountId: 'a2' }, sid), null, 'bucket B item 2');
  const bAdvice = maybeFanoutAdvisory('TOOL_B', { accountId: 'a3' }, sid);
  assert.ok(bAdvice, 'bucket B fires independently of bucket A');
});

test('fan-out advisory reverts to fire-once when CLEMMY_FANOUT_DIRECTIVE=off', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const prev = process.env.CLEMMY_FANOUT_DIRECTIVE;
  process.env.CLEMMY_FANOUT_DIRECTIVE = 'off';
  try {
    const sid = 'sess-fanout-off';
    const fires: number[] = [];
    for (let i = 1; i <= 12; i++) {
      if (maybeFanoutAdvisory('DATAFORSEO_SERP', { q: `item${i}` }, sid)) fires.push(i);
    }
    assert.deepEqual(fires, [3], 'off: legacy fire-once-per-session latch');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_FANOUT_DIRECTIVE;
    else process.env.CLEMMY_FANOUT_DIRECTIVE = prev;
  }
});

test('fan-out advisory never throws on malformed / unserializable args', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-malformed';
  const circular: Record<string, unknown> = {};
  circular.self = circular; // JSON.stringify would throw
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i++) maybeFanoutAdvisory('TOOL_C', circular, sid);
    // @ts-expect-error proving robustness against a non-object args value
    maybeFanoutAdvisory('TOOL_C', null, sid);
    // @ts-expect-error proving robustness against a missing slug
    maybeFanoutAdvisory(undefined, { q: 'x' }, sid);
  });
});

test('fan-out advisory does NOT fire for the SAME args repeated (that is a loop, not a batch)', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-2';
  for (let i = 0; i < 5; i++) {
    assert.equal(maybeFanoutAdvisory('AIRTABLE_LIST_RECORDS', { baseId: 'app1', table: 'tbl1' }, sid), null,
      'identical args = not distinct items = no fan-out advice');
  }
});

test('fan-out advisory inside a WORKFLOW step recommends forEach, NOT run_worker (Gap D)', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  // Workflow step sessions are prefixed `workflow:<runId>:<stepId>` and block run_worker.
  const sid = 'workflow:run-abc:enrich';
  assert.equal(maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'p1' }, sid), null);
  assert.equal(maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'p2' }, sid), null);
  const advice = maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'p3' }, sid);
  assert.ok(advice, 'advice fires on the 3rd distinct item in a workflow step too');
  assert.match(advice!, /forEach/, 'workflow-step advice must name forEach as the fan-out primitive');
  assert.ok(!/run_worker once per item/.test(advice!), 'must NOT tell a workflow step to use the blocklisted run_worker');
});

// ─── FIX 2.5: the mid-run advisory is IMPERATIVE at the data-derived count ───

test('FIX2.5: chat fan-out advisory is IMPERATIVE on the 3rd serial call', async () => {
  const { maybeFanoutAdvisory } = await import('./composio-tools.js');
  const sid = 'sess-fanout-imperative';
  maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'a' }, sid);
  maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'b' }, sid);
  const advice = maybeFanoutAdvisory('DATAFORSEO_SERP', { q: 'c' }, sid);
  assert.ok(advice, '3rd serial same-shape call fires the advisory');
  assert.match(advice!, /FAN-OUT NOW/);
  assert.match(advice!, /Do NOT make the next serial call/);
  assert.match(advice!, /run_worker/);
});

// ─── FIX 1.4: transient-aware corrective (retry once vs hard-stop) ───────────

test('FIX1.4: a TRANSIENT composio failure says retry ONCE (flag on)', async () => {
  const { composioThrownErrorOutput } = await import('./composio-tools.js');
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  process.env.CLEMMY_WORKER_THRASH_GUARD = 'on';
  try {
    const rateLimited = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const out1 = composioThrownErrorOutput(rateLimited, { toolSlug: 'OUTLOOK_SEND_EMAIL' });
    assert.match(out1, /TRANSIENT/);
    assert.match(out1, /Retry this EXACT call ONCE/);
    assert.ok(!/do NOT repeat/i.test(out1.split('\n\n')[0]), 'transient must not use the hard do-not-repeat copy');

    const fetchFailed = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    assert.match(composioThrownErrorOutput(fetchFailed, {}), /TRANSIENT/);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  }
});

test('FIX1.4: a DETERMINISTIC (4xx/schema) failure keeps the hard do-not-repeat copy', async () => {
  const { composioThrownErrorOutput } = await import('./composio-tools.js');
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  process.env.CLEMMY_WORKER_THRASH_GUARD = 'on';
  try {
    const schemaErr = new Error('Bad request: missing required field "subject"');
    const out = composioThrownErrorOutput(schemaErr, { toolSlug: 'OUTLOOK_SEND_EMAIL' });
    assert.match(out, /HARD failure/);
    assert.match(out, /Do NOT repeat this identical call/);
    assert.ok(!/TRANSIENT/.test(out));
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  }
});

test('FIX1.4: a NOT-FOUND failure keeps the discover-ids copy (transient suppressed)', async () => {
  const { composioThrownErrorOutput } = await import('./composio-tools.js');
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  process.env.CLEMMY_WORKER_THRASH_GUARD = 'on';
  try {
    const out = composioThrownErrorOutput(new Error('TABLE_NOT_FOUND: tblXYZ does not exist'), { toolSlug: 'AIRTABLE_LIST_RECORDS' });
    assert.match(out, /NOT FOUND/);
    assert.ok(!/TRANSIENT/.test(out), 'a not-found is deterministic, never transient');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  }
});

test('FIX1.4: kill-switch off → even a transient error gets the legacy hard copy (revert path)', async () => {
  const { composioThrownErrorOutput } = await import('./composio-tools.js');
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  process.env.CLEMMY_WORKER_THRASH_GUARD = 'off'; // explicit kill-switch (default is now on)
  try {
    const out = composioThrownErrorOutput(Object.assign(new Error('rate limit'), { status: 429 }), { toolSlug: 'X' });
    assert.match(out, /HARD failure/);
    assert.ok(!/TRANSIENT/.test(out), 'kill-switch off must preserve the prior corrective verbatim');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  }
});

test('formatComposioExecuteOutput: an invalid-offset error redirects to recall, not guessed pagination (scorpion itr2 fix)', () => {
  const out = formatComposioExecuteOutput(
    { error: "Invalid offset value: The offset 'itr2' is not valid. The offset must be an opaque token returned in the 'offset' field of a previous list records response.", successful: false },
    { toolName: 'composio_execute_tool', toolSlug: 'AIRTABLE_LIST_RECORDS' },
  );
  assert.match(out, /FAILED/);
  assert.match(out, /recall_tool_result/);
  assert.match(out, /do NOT pass a guessed offset/i);
});
