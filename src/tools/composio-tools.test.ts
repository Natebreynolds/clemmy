/**
 * Run: npx tsx --test src/tools/composio-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// Legacy clip-and-recall path (LARGE_TOOL_OUTPUT_DIGEST ships on; digest
// path covered by tool-output-digest.test.ts).
process.env.LARGE_TOOL_OUTPUT_DIGEST = 'off';
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
  assert.match(output, /composio_execute_tool returned \d+ chars/);

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
  const failed = { successful: false, data: { http_error: '404 Not Found', status_code: 404 } };
  const out = formatComposioExecuteOutput(failed, { toolName: 'cx_airtable_create_records', toolSlug: 'AIRTABLE_CREATE_RECORDS' });
  assert.match(out, /cx_airtable_create_records FAILED \(slug=AIRTABLE_CREATE_RECORDS\)/);
});

test('composioThrownErrorOutput: a THROWN composio error (not-found/auth/APIError) also gets the do-not-retry corrective', () => {
  resetEventLog();
  const out = composioThrownErrorOutput(
    new Error('ComposioToolNotFoundError: no such slug AIRTABLE_FROB'),
    { toolName: 'composio_execute_tool', toolSlug: 'AIRTABLE_FROB' },
  );
  assert.match(out, /FAILED \(slug=AIRTABLE_FROB\)/);
  assert.match(out, /ComposioToolNotFoundError/);
  assert.match(out, /Do NOT repeat this identical call/);
});
