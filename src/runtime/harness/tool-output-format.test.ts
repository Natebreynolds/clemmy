/**
 * Run: npx tsx --test src/runtime/harness/tool-output-format.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tool-output-format-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// These tests cover the recallable-tool-output WRAPPER: full output is stored +
// recoverable via recall_tool_result, and the global id-index is prepended. The
// structure-aware digest BODY is covered in detail by tool-output-digest.test.ts.
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  closeEventLog,
  resetEventLog,
  createSession,
  getToolOutput,
  getToolOutputForInvocation,
  writeToolOutput,
} = await import('./eventlog.js');
const {
  formatRecallableToolText,
  extractResourceIdIndex,
  densifyMarkdownForModelHead,
  exactToolOutputForInvocation,
} = await import('./tool-output-format.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { textResult } = await import('../../tools/shared.js');

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('formatRecallableToolText stores full output and returns canonical recall stub', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = 'global-output-'.repeat(1000);

  const visible = formatRecallableToolText(full, {
    sessionId: sess.id,
    callId: 'call_global_clip',
    toolName: 'global_tool',
    maxChars: 120,
  });

  assert.ok(visible.length < full.length);
  assert.match(visible, /recall_tool_result \{"call_id":"call_global_clip"\}/);

  const row = getToolOutput(sess.id, 'call_global_clip');
  assert.ok(row);
  assert.equal(row.output, full);
});

test('an exact output receipt remains valid when trusted provider annotations follow it', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const nonce = '11111111-1111-4111-8111-111111111111';
  const full = JSON.stringify({ successful: true, data: { id: 'doc-1', body: 'x'.repeat(20_000) } });
  const compact = withToolOutputContext({
    sessionId: sess.id,
    callId: 'call-with-trailing-banner',
    toolName: 'composio_execute_tool',
    settlementNonce: nonce,
  }, () => formatRecallableToolText(full, { maxChars: 200 }));
  const productionShape = `${compact}\n\n[sender-verified]\n[routed-to: Google Docs]\nConstraints: read back the exact id.`;

  assert.equal(exactToolOutputForInvocation({
    sessionId: sess.id,
    callId: 'call-with-trailing-banner',
    toolName: 'composio_execute_tool',
    compactResult: productionShape,
    settlementNonce: nonce,
  }), full);
});

test('large Firecrawl envelopes stay <=20k, retain exact news tuples, and redeem raw bytes', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const nonce = '33333333-3333-4333-8333-333333333333';
  const news = Array.from({ length: 5 }, (_, index) => ({
    title: `Local model release ${index}`,
    url: `https://news.example/article-${index}`,
    date: `2026-08-${String(20 + index).padStart(2, '0')}`,
    snippet: `Finding ${index} explains a substantive new local inference improvement for private on-device workloads.`,
    publisher: 'News Example',
  }));
  const full = JSON.stringify({
    data: {
      data: {
        web: [{ title: 'Huge web result', url: 'https://web.example/huge', markdown: 'w'.repeat(300_000) }],
        news,
        images: [],
      },
      successful: true,
      error: null,
      logId: 'firecrawl-log-fixture',
    },
    successful: true,
    error: null,
  });
  const visible = withToolOutputContext({
    sessionId: sess.id,
    callId: 'call-firecrawl-large',
    toolName: 'composio_execute_tool',
    settlementNonce: nonce,
  }, () => formatRecallableToolText(full, { maxChars: 20_000 }));

  assert.ok(visible.length <= 20_000, `model-visible result escaped its cap: ${visible.length}`);
  const projected = JSON.parse(visible) as {
    data: { data: { web: Array<{ markdown: string }>; news: typeof news } };
    __clementine: { receipt: string };
  };
  assert.deepEqual(projected.data.data.news, news, 'later news rows survive the huge first web row exactly');
  assert.ok(projected.data.data.web[0]!.markdown.length < 20_000);
  assert.match(projected.__clementine.receipt, /exact-output-receipt:v1/);
  assert.equal(getToolOutputForInvocation(sess.id, 'call-firecrawl-large', nonce)?.output, full,
    'the lossless side store retains the exact raw provider bytes');
  assert.equal(exactToolOutputForInvocation({
    sessionId: sess.id,
    callId: 'call-firecrawl-large',
    toolName: 'composio_execute_tool',
    compactResult: visible,
    settlementNonce: nonce,
  }), full, 'the embedded JSON receipt still redeems the exact raw output');

  const { proveWorkspaceSocialSourceEvidence } = await import('./host-local-workspace-derivation.js');
  const selected = news.slice(0, 3);
  const proof = proveWorkspaceSocialSourceEvidence({
    rawPayload: full,
    projectedPayload: {
      type: 'text',
      text: `${visible}\n\n[account-route] selectedAccount=fixture-firecrawl`,
    },
    selectedRecordIds: selected.map((row) => row.url),
    contract: {
      operationId: 'research',
      recordsPointer: '/news',
      minDistinctRecords: 3,
      titlePointer: '/title',
      urlPointer: '/url',
      publishedDatePointer: '/date',
      findingPointers: ['/snippet', '/description', '/content', '/markdown'],
      publisherPointer: '/publisher',
      maxAgeDays: 30,
      asOf: '2026-08-31T12:00:00.000Z',
    },
    workspaceArgs: {
      initial_data_json: JSON.stringify({
        posts: selected.map((row) => ({
          body: `A substantive authored post grounded in ${row.title} and its exact research finding.`,
          citations: [{
            url: row.url,
            title: row.title,
            publishedAt: row.date,
            publisher: row.publisher,
          }],
        })),
      }),
    },
  });
  assert.equal(proof.ok, true, 'typed Workspace proof can parse the compact model projection');
});

test('exact invocation resolution ignores stale larger call-id output and nonce-less rewrites', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const nonce = '22222222-2222-4222-8222-222222222222';
  const stale = JSON.stringify({ successful: true, data: { id: 'stale', body: 's'.repeat(30_000) } });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'reused-format-call',
    invocationNonce: '11111111-1111-4111-8111-111111111111',
    tool: 'composio_execute_tool',
    output: stale,
  });
  const interim = JSON.stringify({ successful: true, data: { id: 'current', body: 'i'.repeat(22_000) } });
  const final = JSON.stringify({ successful: true, data: { id: 'current', body: 'f'.repeat(14_000) } });
  withToolOutputContext({
    sessionId: sess.id,
    callId: 'reused-format-call',
    toolName: 'composio_execute_tool',
    settlementNonce: nonce,
  }, () => formatRecallableToolText(interim, { maxChars: 200 }));
  const compactFinal = withToolOutputContext({
    sessionId: sess.id,
    callId: 'reused-format-call',
    toolName: 'composio_execute_tool',
    settlementNonce: nonce,
  }, () => formatRecallableToolText(final, { maxChars: 200 }));
  writeToolOutput({
    sessionId: sess.id,
    callId: 'reused-format-call',
    tool: 'composio_execute_tool',
    output: 'later hook output without an invocation nonce',
  });

  assert.equal(getToolOutput(sess.id, 'reused-format-call')?.output, stale, 'canonical recall is still longest');
  assert.equal(getToolOutputForInvocation(sess.id, 'reused-format-call', nonce)?.output, final);
  assert.equal(exactToolOutputForInvocation({
    sessionId: sess.id,
    callId: 'reused-format-call',
    toolName: 'composio_execute_tool',
    compactResult: compactFinal,
    settlementNonce: nonce,
  }), final);
});

test('exact non-JSON output obeys even a budget smaller than receipt overhead', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = `plain-provider-output ${'x'.repeat(2_000)}`;
  for (const maxChars of [50, 100, 120, 150, 180, 200]) {
    const nonce = `44444444-4444-4444-8444-${String(maxChars).padStart(12, '0')}`;
    const callId = `small-budget-${maxChars}`;
    const visible = withToolOutputContext({
      sessionId: sess.id,
      callId,
      toolName: 'plain_provider_read',
      settlementNonce: nonce,
    }, () => formatRecallableToolText(full, { maxChars }));
    assert.ok(visible.length <= maxChars, `${maxChars}-char budget produced ${visible.length} chars`);
    const resolved = exactToolOutputForInvocation({
      sessionId: sess.id,
      callId,
      toolName: 'plain_provider_read',
      compactResult: visible,
      settlementNonce: nonce,
    });
    if (/exact-output-receipt:v1/u.test(visible)) assert.equal(resolved, full);
    else assert.equal(resolved, visible, 'an omitted receipt must fail closed instead of redeeming raw bytes');
  }
});

test('clip footer reports the TRUE record count + that recall returns ALL (acme 44→4 fix)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // The Airtable shape that broke: full result with 59 records, clipped to a few.
  const full = JSON.stringify({ data: { records: Array.from({ length: 59 }, (_, i) => ({ id: i, fields: { Name: 'Contact ' + i, Email: `c${i}@site.example` } })) }, error: null, successful: true });
  const visible = formatRecallableToolText(full, { sessionId: sess.id, callId: 'call_air', toolName: 'composio_execute_tool', maxChars: 400 });
  assert.match(visible, /[Cc]ontains 59 record\(s\) at data\.records\[\*\]/);
  assert.match(visible, /returns ALL 59/);
  assert.match(visible, /no pagination/i);
  assert.match(visible, /recall_tool_result \{"call_id":"call_air"\}/);
  assert.equal(getToolOutput(sess.id, 'call_air')!.output, full); // full payload preserved
});

test('textResult uses active tool-output context for MCP-style local tools', async () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const full = 'mcp-local-output-'.repeat(1000);

  const result = await withToolOutputContext(
    {
      sessionId: sess.id,
      callId: 'call_text_result_full',
      toolName: 'skill_read',
    },
    () => textResult(full, { maxChars: 100 }),
  );

  const visible = result.content[0].text;
  assert.match(visible, /recall_tool_result \{"call_id":"call_text_result_full"\}/);

  const row = getToolOutput(sess.id, 'call_text_result_full');
  assert.ok(row);
  assert.equal(row.output, full);
});

test('formatRecallableToolText falls back to plain truncation without call context', () => {
  const visible = formatRecallableToolText('x'.repeat(1000), { maxChars: 50 });
  assert.ok(visible.length <= 50);
  assert.match(visible, /truncated/);
  assert.doesNotMatch(visible, /recall_tool_result/);
});

// ── GLOBAL id-index: applies to EVERY tool (composio + native MCP + local) ──

test('extractResourceIdIndex: pulls id=name from resource lists, ignores bulk data rows', () => {
  // Airtable base schema (composio shape)
  assert.match(
    extractResourceIdIndex(JSON.stringify({ data: { tables: [
      { id: 'tblAAA', name: 'Prospecting Accounts', fields: [] },
      { id: 'tblBBB', name: 'Prospecting Contacts' },
    ] } })),
    /tblAAA = Prospecting Accounts[\s\S]*tblBBB = Prospecting Contacts/,
  );
  // Native-MCP-style list under a different key (objects/databases/sheets)
  assert.match(
    extractResourceIdIndex(JSON.stringify({ databases: [{ id: 'db_1', title: 'CRM' }] })),
    /db_1 = CRM/,
  );
  // Bulk record rows (id but no name) and value arrays are NOT indexed (no noise).
  assert.equal(extractResourceIdIndex(JSON.stringify({ data: { records: [{ id: 'rec1', fields: { x: 1 } }] } })), '');
  // A single object / non-list → no index.
  assert.equal(extractResourceIdIndex(JSON.stringify({ data: { display_url: 'x' } })), '');
  // Non-JSON → safe empty.
  assert.equal(extractResourceIdIndex('not json'), '');
});

test('formatRecallableToolText prepends the id index when a large resource-list result is clipped', () => {
  // 8 tables, each padded so the whole result exceeds maxChars and gets clipped.
  const tables = Array.from({ length: 8 }, (_, i) => ({ id: `tbl${i}`, name: `Table ${i}`, fields: Array.from({ length: 30 }, (_, f) => ({ id: `fld${i}_${f}`, name: 'x'.repeat(20) })) }));
  const text = JSON.stringify({ data: { tables } });
  assert.ok(text.length > 2000);
  const out = formatRecallableToolText(text, { maxChars: 1500 });
  assert.ok(out.length <= 1500, `detached resource projection escaped its cap: ${out.length}`);
  assert.match(out, /IDs available in this result/);
  assert.match(out, /tbl0 = Table 0/);
  assert.match(out, /tbl7 = Table 7/); // survives even though the body is clipped
});

// Scrape-head densifier (live 2026-07-23): the clipped model head of a
// scrape-shaped payload must carry CONTENT, not image markdown / data-URI
// blobs / bare-URL nav lines. Non-scrape text is byte-identical.
test('densifyMarkdownForModelHead strips scrape junk, leaves normal text alone', () => {
  const scrape = [
    '![](https://assets.example.com/logo-71f9f7038a26ec24.svg)',
    '![banner](https://cdn.example.com/banner.webp)',
    '![](data:image/png;base64,' + 'A'.repeat(120) + ')',
    'https://example.com/nav-link',
    '# Jacksonville Divorce & Family Law Attorney',
    '',
    '',
    '',
    'Education, collaboration and efficiency are the cornerstones of my practice.',
  ].join('\n');
  const dense = densifyMarkdownForModelHead(scrape);
  assert.ok(!dense.includes('!['), 'image markdown removed');
  assert.ok(!dense.includes('base64,AAAA'), 'data uri removed');
  assert.ok(!dense.includes('https://example.com/nav-link'), 'bare-url nav line removed');
  assert.match(dense, /Jacksonville Divorce/);
  assert.match(dense, /cornerstones of my practice/);
  assert.ok(!/\n{3,}/.test(dense), 'blank runs collapsed');

  const normal = 'A report with one image ![x](https://a.b/c.png) and prose.';
  assert.equal(densifyMarkdownForModelHead(normal), normal, 'sub-threshold text untouched');
});
