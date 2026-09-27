/**
 * No reader may name its own successor — the loop must be uncloseable.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/retained-result-routes.test.ts
 *
 * Live 2026-09-07, source 146537. Two individually well-reasoned messages:
 *   recall exhausted   -> "Call tool_output_query instead"
 *   output is text     -> "use recall_tool_result to read it"
 * A model obeying either lands back at the other. The owner's Platform 49
 * Sheet-cleanup Plan burned its turn inside that cycle and never published.
 * The same shape was already "fixed" on 2026-09-02 by pointing one tool at the
 * other; that moved the loop rather than removing it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-retained-routes-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'retained-routes\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { retainedResultRoutes, retainedResultWayThrough, authenticRetainedAlternatives } = await import('./retained-result-routes.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function stored(callId: string, output: string) {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: callId });
  eventlog.writeToolOutput({
    sessionId: s.id, callId, invocationNonce: `nonce-${callId}`,
    tool: 'work_call', output,
  });
  return s.id;
}

test('THE 146537 LOOP: plain text with recall exhausted still has a route', () => {
  const sessionId = stored('toolu_text', 'Log sheet rows, as plain narrative text, not JSON at all.');
  const routes = retainedResultRoutes({
    sessionId, callId: 'toolu_text',
    exclude: ['recall_tool_result'], recallCallsRemaining: 0,
  });
  assert.ok(routes.length > 0, 'a reader must remain');
  assert.ok(!routes.some((r) => r.tool === 'recall_tool_result'), 'never the exhausted one');
  assert.ok(routes.some((r) => r.tool === 'file_query'),
    'file_query reads the same stored text and spends no recall budget — the route neither message ever named');
});

test('the two messages can no longer point at each other', () => {
  const sessionId = stored('toolu_pair', 'plain text content');
  // recall exhausted must not name tool_output_query for text it cannot parse
  const fromRecall = retainedResultWayThrough({
    sessionId, callId: 'toolu_pair', exclude: ['recall_tool_result'], recallCallsRemaining: 0,
  });
  assert.doesNotMatch(fromRecall, /recall_tool_result \{/, 'cannot send back to the exhausted reader');
  // tool_output_query refusing text must not name recall when recall is spent
  const fromQuery = retainedResultWayThrough({
    sessionId, callId: 'toolu_pair', exclude: ['tool_output_query'],
  });
  assert.doesNotMatch(fromQuery, /tool_output_query \{/, 'cannot send back to itself');
});

test('structured output prefers the server-side query', () => {
  const sessionId = stored('toolu_json', JSON.stringify([{ account: 'A', domain: 'a.com' }]));
  const routes = retainedResultRoutes({ sessionId, callId: 'toolu_json' });
  assert.equal(routes[0]?.tool, 'tool_output_query', 'structured records query server-side');
});

test('an unknown output yields an HONEST empty answer, not a guess', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'none' });
  assert.deepEqual(retainedResultRoutes({ sessionId: s.id, callId: 'toolu_absent' }), []);
  assert.match(
    retainedResultWayThrough({ sessionId: s.id, callId: 'toolu_absent' }),
    /No retained reader can serve this/,
    'says so plainly instead of naming a reader that will refuse differently',
  );
});

test('excluding every reader leaves the honest terminal', () => {
  const sessionId = stored('toolu_all', 'text');
  const way = retainedResultWayThrough({
    sessionId, callId: 'toolu_all',
    exclude: ['recall_tool_result', 'tool_output_query', 'file_query'],
  });
  assert.match(way, /re-read the source|say what is missing/);
});

test('an unusable output points at the authentic evidence the host still holds', () => {
  // Live 2026-09-07 source 148101 (the Platform 49 baseline): a derived reader
  // was refused as "presentation-only … Re-run the source read" — unactionable
  // for a derived id, and it discards retained work. Two Sheet reads were held
  // at that moment.
  const sessionId = stored('toolu_good_one', JSON.stringify([{ row: 1 }]));
  eventlog.writeToolOutput({
    sessionId, callId: 'toolu_good_two', invocationNonce: 'nonce-good-two',
    tool: 'work_call', output: JSON.stringify([{ row: 2 }]),
  });
  const alternatives = authenticRetainedAlternatives({ sessionId, excludeCallId: 'toolu_absent' });
  assert.ok(alternatives.length > 0, 'the host names what it is still holding');
  assert.ok(!alternatives.some((a) => a.callId === 'toolu_absent'), 'never the failed id');

  const way = retainedResultWayThrough({ sessionId, callId: 'toolu_absent' });
  assert.match(way, /retained results still can/, 'offers them instead of a re-read');
  assert.doesNotMatch(way, /No retained reader can serve/, 'the honest-empty branch is for when nothing remains');
});

test('with nothing retained it still says so plainly', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'truly-empty' });
  assert.match(
    retainedResultWayThrough({ sessionId: s.id, callId: 'toolu_nothing' }),
    /No retained reader can serve this/,
  );
});

test('file_query is never advertised for a derived output it would refuse', () => {
  // Regression: routes offered file_query for every retained id, derived
  // presentation-only readers included, and file_query then refused it.
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'derived-no-file-query' });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_derived_query', tool: 'tool_output_query',
    output: 'Showing 1 record(s) [0–1] of 1 matching (1 total)\n\n[{"row":1}]' });
  const routes = retainedResultRoutes({ sessionId: s.id, callId: 'toolu_derived_query' });
  assert.ok(!routes.some((r) => r.tool === 'file_query'), JSON.stringify(routes));
});

test('routes for a carrier-dispatched recall name the producer, never the recall copy', () => {
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'recall-lineage-routes' });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_producer_text', invocationNonce: 'nonce-producer-text', tool: 'read_file',
    output: 'A long plain narrative the owner wrote, not structured data.' });
  eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_recall_carried', tool: 'call_tool', effectiveTool: 'recall_tool_result', accounting: 'top_level',
    arguments: JSON.stringify({ name: 'recall_tool_result', args_json: JSON.stringify({ call_id: 'toolu_producer_text' }) }),
  } });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_recall_carried', tool: 'call_tool',
    output: 'Recalled chars 0–10 of 60 (more remains — continue with recall_tool_result {"call_id":"toolu_producer_text","offset":10})\n\nA long pla' });
  const routes = retainedResultRoutes({ sessionId: s.id, callId: 'toolu_recall_carried' });
  assert.deepEqual(routes.map((r) => r.tool), ['recall_tool_result', 'file_query'], JSON.stringify(routes));
  for (const route of routes) {
    assert.match(route.call, /"call_id":"toolu_producer_text"/);
    assert.doesNotMatch(route.call, /toolu_recall_carried/);
  }
});

test('a result still inside its own open lifecycle is offered to file_query', () => {
  // A digest footer is written while its call is still open (no return yet),
  // and says so. file_query will read it once the call settles, so the router
  // must not withhold it for that.
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'open-lifecycle' });
  eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_open_text', tool: 'call_tool', effectiveTool: 'space_get_view', accounting: 'top_level',
    arguments: JSON.stringify({ name: 'space_get_view', args_json: '{"slug":"notes"}' }),
  } });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_open_text', invocationNonce: 'nonce-open-text',
    tool: 'space_get_view', output: 'A saved view of plain prose notes.' });
  const routes = retainedResultRoutes({ sessionId: s.id, callId: 'toolu_open_text' });
  assert.deepEqual(routes.map((r) => r.tool), ['recall_tool_result', 'file_query'], JSON.stringify(routes));
});

test('a prose document with its data inside is routed to the query for the data and recall for the prose', () => {
  const sessionId = stored('toolu_doc_with_data', [
    'Workspace "Board" (board) — active, v1.',
    'View source: reader({slug:"board"}) returns the saved HTML.',
    `Dataset (complete JSON): ${JSON.stringify({ rows: [{ id: 1 }, { id: 2 }] })}`,
  ].join('\n'));
  const routes = retainedResultRoutes({ sessionId, callId: 'toolu_doc_with_data' });
  assert.deepEqual(routes.map((r) => r.tool), ['tool_output_query', 'recall_tool_result', 'file_query'], JSON.stringify(routes));
  const spent = retainedResultRoutes({ sessionId, callId: 'toolu_doc_with_data', recallCallsRemaining: 0 });
  assert.deepEqual(spent.map((r) => r.tool), ['tool_output_query', 'file_query']);
});

test('prose whose brackets happen to parse is routed as text, never to the record query', () => {
  for (const [callId, output] of [
    ['toolu_wiki_page', '[Jump to content](#bodyContent)\nThe valley runs through Oregon.[[1]](https://en.example.org/wiki/V#cite_note-1)'],
    ['toolu_docs_page', '[Skip to main](#main)\nSend the body:\n```json\n{"email":"jane@example.com","name":"Jane"}\n```\nDone.'],
    ['toolu_build_log', 'See [the docs](x) for details. Build [42] passed.'],
    ['toolu_nan_export', '{"meta":{"page":1},"rows":[{"id":1,"v":NaN},{"id":2,"v":0.5}]}'],
  ] as const) {
    const sessionId = stored(callId, output);
    const routes = retainedResultRoutes({ sessionId, callId });
    assert.deepEqual(routes.map((r) => r.tool), ['recall_tool_result', 'file_query'], `${callId}: ${JSON.stringify(routes)}`);
  }
});

test('file_query is offered exactly when its own query-authority check accepts the output', () => {
  // Settled outputs: the router asks the resolver file_query applies.
  const failed = stored('toolu_failure_text', 'ERROR: the provider refused the request.\nNothing was read.');
  assert.equal(eventlog.resolveToolOutputForQuery(failed, 'toolu_failure_text').status, 'failed',
    'precondition: file_query refuses a failure-shaped output');
  const failedRoutes = retainedResultRoutes({ sessionId: failed, callId: 'toolu_failure_text' });
  assert.ok(!failedRoutes.some((r) => r.tool === 'file_query'), JSON.stringify(failedRoutes));
  assert.ok(failedRoutes.some((r) => r.tool === 'recall_tool_result'), 'recall still reads the text verbatim');

  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'explicit-failed-lifecycle' });
  const called = eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_lifecycle_failed', tool: 'read_file', arguments: '{"path":"notes.txt"}',
  } });
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_lifecycle_failed', invocationNonce: 'nonce-lifecycle-failed',
    tool: 'read_file', output: 'Partial notes read before the provider dropped the connection.' });
  eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_returned', parentEventId: called.id, data: {
    callId: 'toolu_lifecycle_failed', tool: 'read_file', ok: false,
  } });
  assert.equal(eventlog.resolveToolOutputForQuery(s.id, 'toolu_lifecycle_failed').status, 'failed',
    'precondition: file_query refuses an output whose lifecycle explicitly failed');
  const lifecycleRoutes = retainedResultRoutes({ sessionId: s.id, callId: 'toolu_lifecycle_failed' });
  assert.ok(!lifecycleRoutes.some((r) => r.tool === 'file_query'), JSON.stringify(lifecycleRoutes));

  // A call with no durable return yet is judged on its bytes: a
  // failure-shaped result is withheld from file_query even before its return
  // is recorded.
  const open = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'open-failure' });
  eventlog.appendEvent({ sessionId: open.id, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_open_failure', tool: 'call_tool', effectiveTool: 'space_get_view', accounting: 'top_level',
    arguments: JSON.stringify({ name: 'space_get_view', args_json: '{"slug":"notes"}' }),
  } });
  eventlog.writeToolOutput({ sessionId: open.id, callId: 'toolu_open_failure', invocationNonce: 'nonce-open-failure',
    tool: 'space_get_view', output: 'ERROR: no saved view named notes.' });
  const openRoutes = retainedResultRoutes({ sessionId: open.id, callId: 'toolu_open_failure' });
  assert.ok(!openRoutes.some((r) => r.tool === 'file_query'), JSON.stringify(openRoutes));
});

test('routing a long output loads its bytes at most once, and not again while nothing changed', () => {
  // A long recall pages through the router on every page, and a text digest
  // routes the result it has just stored. The route is judged from the bytes
  // once; the same unchanged output is routed again from its metadata.
  const output = 'A long plain narrative line about the orchard walk.\n'.repeat(4_000);
  const sessionId = stored('toolu_long_routed', output);
  const db = eventlog.openEventLog();
  const prepare = db.prepare.bind(db);
  let payloadReads = 0;
  (db as { prepare: typeof db.prepare }).prepare = ((source: string) => {
    // One load of a stored output reads its row's inline payload once.
    if (/^\s*SELECT\s+output_full\b/i.test(source)) payloadReads += 1;
    return prepare(source);
  }) as typeof db.prepare;
  try {
    const first = retainedResultRoutes({ sessionId, callId: 'toolu_long_routed', exclude: ['recall_tool_result'] });
    assert.deepEqual(first.map((r) => r.tool), ['file_query']);
    assert.ok(payloadReads <= 1, `the first route loads the stored bytes at most once: ${payloadReads}`);
    payloadReads = 0;
    const again = retainedResultRoutes({ sessionId, callId: 'toolu_long_routed', exclude: ['recall_tool_result'] });
    assert.deepEqual(again, first);
    assert.equal(payloadReads, 0, 'an unchanged output is routed again without loading its bytes');
  } finally {
    (db as { prepare: typeof db.prepare }).prepare = prepare;
  }

  // A change to the stored output or its lifecycle is judged afresh.
  const called = eventlog.appendEvent({ sessionId, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_long_routed', tool: 'work_call', arguments: '{}',
  } });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'agent', type: 'tool_returned', parentEventId: called.id, data: {
    callId: 'toolu_long_routed', tool: 'work_call', ok: false,
  } });
  const afterFailure = retainedResultRoutes({ sessionId, callId: 'toolu_long_routed', exclude: ['recall_tool_result'] });
  assert.ok(!afterFailure.some((r) => r.tool === 'file_query'), JSON.stringify(afterFailure));
});

test('a preview formatted after its call returned never offers file_query for an output file_query refuses', async () => {
  // The host previews a long result for the model after the call has
  // returned. Whether the call is open is the durable lifecycle's answer, not
  // the formatter's: a returned derived-reader output is judged by the query
  // check itself, which refuses it.
  const { hostModelOutputPreview } = await import('./host-model-output-preview.js');
  const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'preview-after-return' });
  const called = eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_called', data: {
    callId: 'toolu_query_preview', tool: 'call_tool', effectiveTool: 'tool_output_query', accounting: 'top_level',
    arguments: JSON.stringify({ name: 'tool_output_query', args_json: '{"call_id":"toolu_elsewhere"}' }),
  } });
  const text = 'Matched line about the orchard walk.\n'.repeat(20_000);
  eventlog.writeToolOutput({ sessionId: s.id, callId: 'toolu_query_preview', tool: 'call_tool', output: text });
  eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_returned', parentEventId: called.id, data: {
    callId: 'toolu_query_preview', tool: 'call_tool', effectiveTool: 'tool_output_query', accounting: 'top_level',
  } });
  assert.equal(eventlog.resolveToolOutputForQuery(s.id, 'toolu_query_preview').status, 'failed',
    'precondition: file_query refuses a derived reader output');
  const preview = await hostModelOutputPreview(text, {
    identity: () => ({ sessionId: s.id, sourceUserSeq: 1 }),
    callId: 'toolu_query_preview', toolName: 'call_tool',
    arguments: { name: 'tool_output_query', args_json: '{"call_id":"toolu_elsewhere"}' },
  });
  assert.ok(preview.length < text.length, 'precondition: the preview is a digest, not the whole text');
  assert.match(preview, /recall_tool_result \{"call_id":"toolu_query_preview"/, 'the footer names the reader that serves it');
  assert.doesNotMatch(preview, /file_query \{/, preview.slice(-800));
  const routes = retainedResultRoutes({ sessionId: s.id, callId: 'toolu_query_preview' });
  assert.ok(!routes.some((r) => r.tool === 'file_query'), JSON.stringify(routes));
});

test('a route judged while the stored output could not be read is not remembered', () => {
  const sessionId = stored('toolu_busy_read', 'A plain narrative line about the orchard walk.\n'.repeat(200));
  const db = eventlog.openEventLog();
  const prepare = db.prepare.bind(db);
  let failNextPayloadRead = true;
  (db as { prepare: typeof db.prepare }).prepare = ((source: string) => {
    if (failNextPayloadRead && /^\s*SELECT\s+output_full\b/i.test(source)) {
      failNextPayloadRead = false;
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }
    return prepare(source);
  }) as typeof db.prepare;
  try {
    const during = retainedResultRoutes({ sessionId, callId: 'toolu_busy_read' });
    assert.ok(!failNextPayloadRead, 'precondition: the stored bytes could not be read');
    assert.deepEqual(during, []);
    const afterwards = retainedResultRoutes({ sessionId, callId: 'toolu_busy_read' });
    assert.deepEqual(afterwards.map((r) => r.tool), ['recall_tool_result', 'file_query'], JSON.stringify(afterwards));
  } finally {
    (db as { prepare: typeof db.prepare }).prepare = prepare;
  }
});
