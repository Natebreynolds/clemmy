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

const {
  formatComposioToolOutput,
  formatComposioExecuteOutput,
  detectComposioFailure,
  composioFailureProvesNoCommit,
  composioThrownErrorOutput,
  composioUncertainMutationOutput,
  runComposioExecuteForTest,
  asyncResultItemCount,
  formatComposioBudgetExceededOutput,
  normalizeInlineConnectedAccountId,
  applySuppressedComposioConnectionPolicy,
  buildComposioStatusPayload,
} = await import('./composio-tools.js');
const {
  closeEventLog,
  resetEventLog,
  createSession,
  appendEvent,
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
  // returns ALL of them (the acme 44→4 fix), not a bare char count.
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

test('ambiguous Composio mutation errors never replay the provider dispatch', async () => {
  let dispatches = 0;
  const output = await runComposioExecuteForTest(
    'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    { title: 'One document', markdown_text: '# Snapshot' },
    async () => {
      dispatches += 1;
      throw new Error('Socket timeout after provider accepted the request');
    },
  );
  assert.equal(dispatches, 1, 'a create crosses the provider boundary at most once');
  assert.match(output, /provider-dispatch:uncertain/);
  assert.match(output, /Do NOT repeat this mutation/);
  assert.doesNotMatch(output, /Retry this EXACT call/i);
});

test('the uncertain mutation corrective never claims a remote write failed', () => {
  const output = composioUncertainMutationOutput(new Error('503 Service unavailable'), {
    toolName: 'composio_execute_tool',
    toolSlug: 'OUTLOOK_SEND_EMAIL',
  });
  assert.match(output, /MAY already exist/);
  assert.match(output, /matching list\/get\/search action/);
});

test('normalizeInlineConnectedAccountId lifts accidental inner connection metadata out of provider args', () => {
  const args = {
    connected_account_id: 'ca_live_outlook',
    startDateTime: '2026-07-03T00:00:00',
    endDateTime: '2026-07-03T23:59:59',
  };

  const normalized = normalizeInlineConnectedAccountId(args, undefined);

  assert.equal(normalized.connectedAccountId, 'ca_live_outlook');
  assert.deepEqual(normalized.args, {
    startDateTime: '2026-07-03T00:00:00',
    endDateTime: '2026-07-03T23:59:59',
  });
});

test('normalizeInlineConnectedAccountId lets the explicit outer connection win and strips junk inner ids', () => {
  const explicit = normalizeInlineConnectedAccountId(
    { connected_account_id: 'ca_inner', connectedAccountId: 'ca_camel', q: 'x' },
    'ca_outer',
  );
  assert.equal(explicit.connectedAccountId, 'ca_outer');
  assert.deepEqual(explicit.args, { q: 'x' });

  const junk = normalizeInlineConnectedAccountId({ connected_account_id: 'null', q: 'x' }, undefined);
  assert.equal(junk.connectedAccountId, undefined);
  assert.deepEqual(junk.args, { q: 'x' });
});

test('normalizeInlineConnectedAccountId strips Clementine artifact-slot metadata before provider validation', () => {
  const normalized = normalizeInlineConnectedAccountId({
    artifact_key: 'appendix',
    outputKey: 'client-copy',
    title: 'Appendix',
  }, undefined);
  assert.deepEqual(normalized.args, { title: 'Appendix' });
});

test('applySuppressedComposioConnectionPolicy repairs stale pins for read-only Composio calls', () => {
  const routed = applySuppressedComposioConnectionPolicy(
    'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES',
    'ca_expired',
    {
      suppressedConnections: {
        ca_expired: {
          reason: 'expired',
          suppressUntil: '2026-07-10T00:00:00.000Z',
          lastErrorAt: '2026-07-09T00:00:00.000Z',
          failures: 2,
        },
      },
    },
    Date.parse('2026-07-09T12:00:00.000Z'),
  );

  assert.equal(routed.connectedAccountId, undefined);
  assert.match(routed.note ?? '', /Ignored suppressed OUTLOOK connection ca_expired/);
  assert.equal(routed.block, undefined);
});

test('applySuppressedComposioConnectionPolicy treats read-side batch getters as repairable reads', () => {
  const routed = applySuppressedComposioConnectionPolicy(
    'GOOGLESHEETS_BATCH_GET',
    'ca_expired_sheet',
    {
      suppressedConnections: {
        ca_expired_sheet: {
          reason: 'expired',
          suppressUntil: '2026-07-10T00:00:00.000Z',
          failures: 1,
        },
      },
    },
    Date.parse('2026-07-09T12:00:00.000Z'),
  );

  assert.equal(routed.connectedAccountId, undefined);
  assert.match(routed.note ?? '', /GOOGLESHEETS/);
  assert.equal(routed.block, undefined);
});

test('applySuppressedComposioConnectionPolicy blocks mutating calls on quarantined accounts', () => {
  const routed = applySuppressedComposioConnectionPolicy(
    'GMAIL_SEND_EMAIL',
    'ca_bad_sender',
    {
      suppressedConnections: {
        ca_bad_sender: {
          reason: 'entity-mismatch',
          suppressUntil: '2026-07-16T00:00:00.000Z',
          lastErrorAt: '2026-07-09T00:00:00.000Z',
          failures: 1,
        },
      },
    },
    Date.parse('2026-07-09T12:00:00.000Z'),
  );

  assert.equal(routed.connectedAccountId, 'ca_bad_sender');
  assert.match(routed.block ?? '', /COMPOSIO_CONNECTION_SUPPRESSED/);
  assert.match(routed.block ?? '', /Do NOT retry this connection id/);
  assert.match(routed.block ?? '', /do not silently switch accounts/i);
});

test('applySuppressedComposioConnectionPolicy ignores expired quarantine windows', () => {
  const routed = applySuppressedComposioConnectionPolicy(
    'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES',
    'ca_old',
    {
      suppressedConnections: {
        ca_old: {
          reason: 'expired',
          suppressUntil: '2026-07-08T00:00:00.000Z',
          failures: 1,
        },
      },
    },
    Date.parse('2026-07-09T12:00:00.000Z'),
  );

  assert.equal(routed.connectedAccountId, 'ca_old');
  assert.equal(routed.note, undefined);
  assert.equal(routed.block, undefined);
});

test('buildComposioStatusPayload puts usable connections first and does not expose suppressed ids by default', () => {
  const connections = [
    { slug: 'outlook', connectionId: 'ca_personal', status: 'ACTIVE' },
    { slug: 'outlook', connectionId: 'ca_acme', status: 'ACTIVE' },
    { slug: 'slack', connectionId: 'ca_old_slack', status: 'EXPIRED' },
  ];
  const suppressed = [
    {
      slug: 'outlook',
      connectionId: 'ca_stale_entity',
      status: 'ACTIVE',
      suppression: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-07-03T03:16:03.194Z',
        lastErrorAt: '2026-07-02T15:16:03.194Z',
        failures: 1,
      },
    },
    {
      slug: 'outlook',
      connectionId: 'ca_expired',
      status: 'EXPIRED',
      suppression: {
        reason: 'expired',
        suppressUntil: '2026-07-03T03:16:03.194Z',
        lastErrorAt: '2026-07-02T15:16:03.194Z',
        failures: 1,
      },
    },
  ];

  const payload = buildComposioStatusPayload({ enabled: true }, connections, suppressed, false);
  const counts = payload.counts as { usableByToolkit: Record<string, number>; suppressedByToolkit: Record<string, number> };
  const usable = payload.usableConnections as Array<{ slug: string; connectionId: string }>;
  const hidden = payload.suppressedConnections as Array<{ slug: string; connectionId?: string; reason: string }>;

  assert.equal(counts.usableByToolkit.outlook, 2);
  assert.equal(counts.suppressedByToolkit.outlook, 2);
  assert.deepEqual(
    usable.filter((connection) => connection.slug === 'outlook').map((connection) => connection.connectionId),
    ['ca_personal', 'ca_acme'],
  );
  assert.deepEqual(hidden.map((connection) => connection.reason), ['entity-mismatch', 'expired']);
  assert.ok(hidden.every((connection) => connection.connectionId === undefined));
});

test('buildComposioStatusPayload can expose suppressed ids only for explicit diagnostics', () => {
  const payload = buildComposioStatusPayload(
    { enabled: true },
    [],
    [{
      slug: 'outlook',
      connectionId: 'ca_stale_entity',
      status: 'ACTIVE',
      suppression: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-07-03T03:16:03.194Z',
        lastErrorAt: '2026-07-02T15:16:03.194Z',
        failures: 1,
      },
    }],
    true,
  );
  const suppressed = payload.suppressedConnections as Array<{ connectionId?: string }>;
  assert.equal(suppressed[0]?.connectionId, 'ca_stale_entity');
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

test('composioFailureProvesNoCommit: uncertain transport/status signals override validation-looking text', () => {
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 400, message: 'missing required field title' } }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'No connected account found' }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: '503 upstream record not found' }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: '409 conflict: invalid recipient' }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { message: 'validation failed after submit timeout' } }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'provider rejected request' }), false);
});

test('composioFailureProvesNoCommit: proof derives from STRUCTURED status, never from a number in prose', () => {
  // A structured 4xx client-error FIELD proves no-commit (rejected at the door).
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 422 } }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 404 } }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, status: 429 }), true);
  // …but a coincidental 4xx-LOOKING number scavenged out of free-text prose is
  // NOT an HTTP status. "row 422" after a dropped connection has an UNKNOWN
  // outcome and must stay AMBIGUOUS (park), never proven-no-commit — otherwise a
  // duplicate external write is authorized (the receipt-ledger regression class).
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'failed to sync row 422 to the sheet' }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { message: 'could not write record 404 to Contacts' } }), false);
  // A structured 5xx / retry-conflict status FIELD stays ambiguous.
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 500 } }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 409 } }), false);
});

test('composioFailureProvesNoCommit: prose-only NOT-FOUND is not proof — only a structured 404/410 status is', () => {
  // detectComposioFailure sets `notFound` off a free-text regex. A "not found"
  // phrase can surface AFTER a partial/committed multi-target write or refer to a
  // sub-resource, so text alone is NOT proof of no-commit — it must PARK.
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'Table "Current Prospects" not found' }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { message: 'no such record: rec123' } }), false);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'The referenced object could not be found' }), false);
  // …but the SAME not-found backed by a structured 404/410-class status FIELD
  // proves no-commit (the provider rejected the id at the door).
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 404, message: 'Record not found' } }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, data: { status_code: 410, message: 'Table not found' } }), true);
  // not-CONNECTED (Composio's connection router refused to route) stays proof —
  // it is unambiguously pre-dispatch even though it also matches the not-found regex.
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'Connected account not found for toolkit GMAIL' }), true);
  assert.equal(composioFailureProvesNoCommit({ successful: false, error: 'ToolRouterV2_NoActiveConnection' }), true);
});

test('detectComposioFailure: a 5-digit API "Ok" status code (DataForSEO 20000) is NOT a failure', () => {
  // Success-payload regression: a SUCCESSFUL DataForSEO call —
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

test('detectComposioFailure: distinguishes a NOT-CONNECTED toolkit from a wrong-id not-found', () => {
  // "Connected account not found for toolkit X" ALSO matches the not-found regex,
  // so the DISTINCT not-connected flag is what lets the corrective avoid the wrong
  // "the connection works, the id doesn't" advice.
  const nc = detectComposioFailure({ successful: false, error: 'Connected account not found for toolkit GMAIL' });
  assert.equal(nc.failed, true);
  assert.equal(nc.notConnected, true);
  assert.equal(detectComposioFailure({ successful: false, error: 'No connected account found' }).notConnected, true);
  // A genuine wrong-id not-found is NOT flagged as not-connected.
  assert.equal(detectComposioFailure({ successful: false, error: 'Table "Current Prospects" not found' }).notConnected, false);
});

test('formatComposioExecuteOutput: a NOT-CONNECTED toolkit steers to connect it, NOT to hunt for ids', () => {
  resetEventLog();
  const notConnected = { successful: false, error: 'Connected account not found for toolkit GMAIL' };
  const out = formatComposioExecuteOutput(notConnected, { toolSlug: 'GMAIL_SEND_EMAIL' });
  assert.match(out, /NOT CONNECTED \(slug=GMAIL_SEND_EMAIL\)/);
  assert.match(out, /GMAIL/);
  assert.match(out, /Open Connect and reconnect GMAIL/);
  assert.match(out, /Do NOT retry/);
  assert.match(out, /not\s+connected/i);
  // Crucially it is NOT the wrong-identifier corrective (which claims the connection works).
  assert.doesNotMatch(out, /the connection works/);
  assert.doesNotMatch(out, /DISCOVER the real options first/);
});

test('composioThrownErrorOutput: a THROWN not-connected error also gets the connect-it corrective, not the id-discovery one', () => {
  resetEventLog();
  const out = composioThrownErrorOutput(
    new Error('Connected account not found for toolkit SLACK'),
    { toolName: 'composio_execute_tool', toolSlug: 'SLACK_SEND_MESSAGE' },
  );
  assert.match(out, /NOT CONNECTED \(slug=SLACK_SEND_MESSAGE\)/);
  assert.match(out, /SLACK/);
  assert.doesNotMatch(out, /the connection works/);
});

test('current Composio entity-mismatch and no-active-connection errors go straight to reconnect guidance', () => {
  resetEventLog();
  const mismatch = formatComposioExecuteOutput({
    successful: false,
    error: 'ConnectedAccountEntityIdMismatch: connected account user ID does not match the provided user ID',
    data: { code: 1812 },
  }, { toolSlug: 'OUTLOOK_LIST_CALENDAR_EVENTS' });
  assert.match(mismatch, /Open Connect and reconnect OUTLOOK/);
  assert.match(mismatch, /Do NOT retry/);
  assert.doesNotMatch(mismatch, /Retry this EXACT call ONCE/);

  const noActive = composioThrownErrorOutput(
    Object.assign(new Error('Composio CLI execute failed: ToolRouterV2_NoActiveConnection'), {
      cause: { error: { code: 1810 } },
    }),
    { toolSlug: 'GMAIL_LIST_EMAILS' },
  );
  assert.match(noActive, /Open Connect and reconnect GMAIL/);
  assert.match(noActive, /Do NOT retry/);
  assert.doesNotMatch(noActive, /Retry this EXACT call ONCE/);
});

test('formatComposioExecuteOutput: a genuine record-not-found STILL gets the id-discovery corrective (characterization)', () => {
  resetEventLog();
  const notFound = { successful: false, error: 'Record not found' };
  const out = formatComposioExecuteOutput(notFound, { toolSlug: 'AIRTABLE_GET_RECORD' });
  assert.match(out, /NOT FOUND \(slug=AIRTABLE_GET_RECORD\)/);
  assert.match(out, /the connection works, the id you used doesn't exist/);
  assert.doesNotMatch(out, /NOT CONNECTED/);
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

test('formatComposioExecuteOutput: a hard failure surfaces CROSS-SURFACE alternatives (intent threaded from the slug)', () => {
  resetEventLog();
  const failed = { successful: false, error: 'Bad Request: invalid recipient address' };
  const out = formatComposioExecuteOutput(failed, { toolSlug: 'GMAIL_SEND_EMAIL' });
  // The slug seeds intent "gmail send email" → capability registry "send email" → the
  // alternatives now render (were inert before: callers passed no intent). Alternatives
  // span OTHER surfaces, not just the failed Composio tool — the "smart re-discovery" ask.
  assert.match(out, /alternativ/i, 'offers alternatives on a hard failure');
  assert.match(out, /cli_mail_send|outlook|manual/i, 'alternatives span other surfaces/tools, not just the failed one');
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

test('auto-remember: a QUEUED RECEIPT (task_post) memorizes nothing — the job has no result yet', async () => {
  const intent = 'zzq-queued-receipt-guard-unique-probe-intent-42';
  noteComposioSearchIntent('sess-auto-receipt', intent);
  // A DataForSEO TASK_POST returns a receipt (status_code 20100, result:null) — a
  // queued job, NOT the answer. It must NOT be learned as the proven tool for this
  // intent (that would teach "task_post = the answer" when it only queues).
  await maybeAutoRememberComposioChoice(
    'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST',
    { tasks: [{ keyword: 'x', location_code: 2840, language_code: 'en' }] },
    { successful: true, data: { tasks: [{ id: 'task-1', result: null, status_code: 20100, status_message: 'Task Created.' }] } },
    'sess-auto-receipt',
  );
  assert.equal(recallToolChoice(intent), null, 'a queued receipt is not a completed outcome — learn nothing');
});

test('auto-remember: a FAILED execute memorizes nothing', async () => {
  const intent = 'send an outlook email failing';
  noteComposioSearchIntent('sess-auto-2', intent);
  await maybeAutoRememberComposioChoice(
    'OUTLOOK_SEND_EMAIL',
    { to: 'x@personal.example' },
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

test('formatComposioExecuteOutput: an invalid-offset error redirects to recall, not guessed pagination (acme itr2 fix)', () => {
  const out = formatComposioExecuteOutput(
    { error: "Invalid offset value: The offset 'itr2' is not valid. The offset must be an opaque token returned in the 'offset' field of a previous list records response.", successful: false },
    { toolName: 'composio_execute_tool', toolSlug: 'AIRTABLE_LIST_RECORDS' },
  );
  assert.match(out, /FAILED/);
  assert.match(out, /recall_tool_result/);
  assert.match(out, /do NOT pass a guessed offset/i);
});

test('asyncResultItemCount: counts items in an Apify dataset (partial-scrape check)', () => {
  assert.equal(asyncResultItemCount({ data: { items: new Array(40).fill({ lead: 'x' }) } }), 40, 'nested items → count');
  assert.equal(asyncResultItemCount(new Array(100).fill({ lead: 'x' })), 100, 'bare array → length');
  assert.equal(asyncResultItemCount({ data: new Array(7).fill(1) }), 7, 'data array → length');
  assert.equal(asyncResultItemCount({ results: new Array(3).fill(1) }), 3);
  assert.equal(asyncResultItemCount({ status: 'SUCCEEDED' }), null, 'no item list → null (no false count)');
});

test('post-clarification long Composio receipt cannot inject a second background gate or rerun', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Background, hold, or now?', source: 'offer_background' },
  });
  const receipt = {
    family: 'apify',
    jobId: 'run-clarified-1',
    status: 'RUNNING',
    pollGuidance: 'Poll run-clarified-1 for its existing result.',
  } as const;
  const output = formatComposioBudgetExceededOutput(
    receipt,
    '{"status":"RUNNING"}',
    { context: { sessionId: sess.id } },
  );

  assert.doesNotMatch(output, /offer_background|dispatch_background_task/);
  assert.doesNotMatch(output, /Prefer handing it to the background/);
  assert.match(output, /existing LONG-running job/);
  assert.match(output, /do not add another background-choice gate/);
  assert.match(output, /do not restart or re-invoke the job/);
  assert.match(output, /run-clarified-1/);

  const normal = formatComposioBudgetExceededOutput(receipt, '{}');
  assert.match(normal, /ask the user, then dispatch_background_task/);
});

// ─── Discovery-tax: composio_search_tools consults tool-choice memory FIRST ────
const { getComposioRuntimeTools } = await import('./composio-tools.js');
const { rememberToolChoice: rememberTC, updateToolChoiceOutcomeForIdentifier: bumpTC } = await import('../memory/tool-choice-store.js');

function searchTool() {
  const t = getComposioRuntimeTools().find((x) => (x as { name?: string }).name === 'composio_search_tools') as unknown as {
    invoke: (ctx: unknown, input: string, details: unknown) => Promise<{ content?: Array<{ text?: string }> }>;
  };
  return t;
}
async function invokeSearch(query: string): Promise<string> {
  const out = await searchTool().invoke({ context: { sessionId: 'sess-search' } }, JSON.stringify({ query, toolkit_slug: null, limit: null }), { toolCall: { callId: 'c1' } });
  return out?.content?.[0]?.text ?? JSON.stringify(out);
}

test('composio_search_tools: a confident memory match returns the remembered slug and SKIPS discovery (zero network)', async () => {
  // Seed the store with fragmented apify-facebook intents → one slug, many successes.
  for (const intent of [
    'apify run actor facebook page posts scraper public page url',
    'apify facebook posts scraper actor search',
  ]) rememberTC({ intent, description: 'Auto-remembered: this Composio slug satisfied the searched intent.', choice: { kind: 'composio', identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', invocationTemplate: '{"actorId":"apify/facebook-posts-scraper"}' } });
  for (let i = 0; i < 40; i += 1) bumpTC('APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', 'success');
  const { listToolProcedures, peekToolChoice } = await import('../memory/tool-choice-store.js');
  const beforeProcedure = listToolProcedures().find((procedure) => procedure.choice?.identifier === 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.ok(beforeProcedure);
  const beforeImpressions = beforeProcedure!.impressionCount;

  // COMPOSIO_API_KEY is NOT set in this test home. If the short-circuit did NOT
  // fire, the search would fall through to the credentials guard and return
  // "not configured" — reaching NO network either way. So a result naming the
  // remembered slug PROVES the memory path returned before any discovery.
  const text = await invokeSearch('facebook public page latest posts scrape');
  assert.match(text, /APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS/, 'returns the remembered slug');
  assert.match(text, /memory|remembered/i, 'labels it as recalled from memory');
  assert.doesNotMatch(text, /not configured/i, 'never reached the credentials/discovery path');
  assert.ok(peekToolChoice('apify run actor facebook page posts scraper public page url')?.choice,
    'search exposure does not invalidate the remembered procedure');
  const afterProcedure = listToolProcedures().find((procedure) => procedure.procedureId === beforeProcedure!.procedureId);
  assert.equal(afterProcedure?.impressionCount, beforeImpressions + 1, 'memory-backed search records an impression only');
  assert.equal(afterProcedure?.choice?.failureCount ?? 0, beforeProcedure?.choice?.failureCount ?? 0,
    'searching again is not a negative outcome');
});

test('composio_search_tools: a query with NO confident memory falls through to normal discovery', async () => {
  const text = await invokeSearch('brightspot cms publish an article revision');
  assert.doesNotMatch(text, /APIFY_RUN_ACTOR/, 'unrelated query does not surface the apify memory');
  // With no API key, the fall-through path is the credentials guard (no network).
  assert.match(text, /not configured/i, 'a miss runs the normal (non-memory) path');
});

test('auto-remember fires for a BACKGROUND-lane success (lane-agnostic, just a sessionId)', async () => {
  const intent = 'brightdata scrape a public company profile page';
  const bgSession = 'background:bg-attribution-fixture';
  noteComposioSearchIntent(bgSession, intent);
  await maybeAutoRememberComposioChoice('BRIGHTDATA_SCRAPE_AS_MARKDOWN', { url: 'https://site-alt.example' }, { successful: true, data: { markdown: 'hi' } }, bgSession);
  const rec = recallToolChoice(intent);
  assert.equal(rec?.choice?.identifier, 'BRIGHTDATA_SCRAPE_AS_MARKDOWN', 'a background-lane success is remembered too');
});

const { executionIntentForSession } = await import('./composio-tools.js');

test('executionIntentForSession: a fresh search that surfaced the slug is the intent', () => {
  noteComposioSearchIntent('sess-intent-1', 'pull outlook unread messages', ['OUTLOOK_LIST_MESSAGES', 'OUTLOOK_GET_MESSAGE']);
  assert.equal(
    executionIntentForSession('sess-intent-1', 'OUTLOOK_LIST_MESSAGES'),
    'pull outlook unread messages',
  );
  // Read-only: the session entry survives for auto-remember to consume.
  assert.equal(
    executionIntentForSession('sess-intent-1', 'OUTLOOK_LIST_MESSAGES'),
    'pull outlook unread messages',
  );
});

test('executionIntentForSession: a search that did NOT surface this slug falls back to the slug seed', () => {
  noteComposioSearchIntent('sess-intent-2', 'dataforseo ranked keywords', ['DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED']);
  assert.equal(
    executionIntentForSession('sess-intent-2', 'AIRTABLE_LIST_RECORDS'),
    'airtable list records',
  );
});

test('executionIntentForSession: no session / no search falls back to the slug seed, then the constant', () => {
  assert.equal(executionIntentForSession(undefined, 'GMAIL_SEND_EMAIL'), 'gmail send email');
  assert.equal(executionIntentForSession('sess-never-searched', 'GMAIL_SEND_EMAIL'), 'gmail send email');
  assert.equal(executionIntentForSession(undefined, ''), 'composio_execute');
});

test('uniform-empty streak: 3 same-slug empty reads append the query-shape advisory; a real result resets it', async () => {
  const { runComposioExecuteForTest, composioResultLooksEmpty } = await import('./composio-tools.js');
  const { equal, ok, doesNotMatch, match } = await import('node:assert/strict');

  equal(composioResultLooksEmpty({ data: { items: [] } }), true);
  equal(composioResultLooksEmpty({ data: { data: { items: [] } } }), true);
  equal(composioResultLooksEmpty({ data: { html: '<html>real content</html>' } }), false);
  equal(composioResultLooksEmpty({}), false);

  const emptyExec = (async () => ({ data: { items: [] }, error: null, successful: true })) as never;
  const fullExec = (async () => ({ data: { items: [{ ad: 'PI attorneys near you' }] }, error: null, successful: true })) as never;

  const first = await runComposioExecuteForTest('APIFY_GET_DATASET_ITEMS', { q: 'firm-a' }, emptyExec);
  doesNotMatch(first, /empty-result advisory/);
  const second = await runComposioExecuteForTest('APIFY_GET_DATASET_ITEMS', { q: 'firm-b' }, emptyExec);
  doesNotMatch(second, /empty-result advisory/);
  const third = await runComposioExecuteForTest('APIFY_GET_DATASET_ITEMS', { q: 'firm-c' }, emptyExec);
  match(third, /empty-result advisory/);
  match(third, /unverified \(tool returned empty\)/);

  // A genuinely non-empty result resets the streak.
  const real = await runComposioExecuteForTest('APIFY_GET_DATASET_ITEMS', { q: 'firm-d' }, fullExec);
  doesNotMatch(real, /empty-result advisory/);
  const afterReset = await runComposioExecuteForTest('APIFY_GET_DATASET_ITEMS', { q: 'firm-e' }, emptyExec);
  doesNotMatch(afterReset, /empty-result advisory/);
  ok(true);
});

test('data-quality checkpoint: an autonomous run with hollow reads is confronted before its first write; second attempt proceeds', async () => {
  const { runComposioExecuteForTestInSession, resetDataQualityForTest } = await import('./composio-tools.js');
  const { match, doesNotMatch } = await import('node:assert/strict');
  resetDataQualityForTest();
  try {
    const emptyExec = (async () => ({ data: { items: [] }, error: null, successful: true })) as never;
    const writeExec = (async () => ({ data: { id: 'appNEW123' }, error: null, successful: true })) as never;
    const sid = 'background:bg-checkpoint-test';

    // Three hollow reads build the ledger (read slug — retried internally is fine).
    for (const q of ['a', 'b', 'c']) {
      await runComposioExecuteForTestInSession('APIFY_GET_DATASET_ITEMS', { q }, emptyExec, sid);
    }

    // First WRITE attempt: deferred with the evidence + the real-assistant fork.
    const first = await runComposioExecuteForTestInSession('AIRTABLE_CREATE_BASE', { name: 'Intel' }, writeExec, sid);
    match(first, /DATA-QUALITY CHECKPOINT/);
    match(first, /APIFY_GET_DATASET_ITEMS: 3\/3 reads returned empty/);
    match(first, /ask_user_question/);

    // Deliberate second attempt proceeds (autonomy redirected, never dead-ended).
    const second = await runComposioExecuteForTestInSession('AIRTABLE_CREATE_BASE', { name: 'Intel' }, writeExec, sid);
    doesNotMatch(second, /DATA-QUALITY CHECKPOINT/);
    match(second, /appNEW123/);

    // Foreground chat sessions are untouched.
    resetDataQualityForTest();
    for (const q of ['a', 'b', 'c']) {
      await runComposioExecuteForTestInSession('APIFY_GET_DATASET_ITEMS', { q }, emptyExec, 'sess-desktop-foreground');
    }
    const fg = await runComposioExecuteForTestInSession('AIRTABLE_CREATE_BASE', { name: 'Intel' }, writeExec, 'sess-desktop-foreground');
    doesNotMatch(fg, /DATA-QUALITY CHECKPOINT/);
  } finally {
    resetDataQualityForTest();
  }
});
