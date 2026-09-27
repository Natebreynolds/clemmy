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
  // A digest footer is written while its call is still open (no return yet).
  // file_query will read it once the call settles, so the router must not
  // withhold it for that; only a derived reader's unmapped output is withheld.
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
