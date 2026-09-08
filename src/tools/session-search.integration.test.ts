import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-session-search-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const search = await import('../runtime/harness/session-history-search.js');
const { registerSessionTools } = await import('./session-tools.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { TOOL_REGISTRY } = await import('./tool-registry.js');
const { projectHarnessEventForPublic } = await import('../runtime/harness/public-presentation.js');
const { presentationEventFromCompletionData } = await import('../runtime/harness/turn-outcome.js');
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (input: Record<string, unknown>) => Promise<Result>;
function handlers(sessionId?: string, sourceUserSeq?: number) {
  const tools = new Map<string, Handler>();
  registerSessionTools({ tool(name: string, ...rest: unknown[]) {
    tools.set(name, input => withToolOutputContext({ sessionId, sourceUserSeq, toolName: name, callId: `fixture-${name}` }, () => (rest.at(-1) as Handler)(input)) as Promise<Result>);
  } } as never);
  return tools;
}
const text = (result: Result) => result.content[0].text!;
const json = (result: Result) => { assert.ok(!result.isError, text(result)); return JSON.parse(text(result)) as ReturnType<typeof search.searchSessionHistory>; };
function session(id: string, principal = 'fixture-owner') { return log.createSession({ id, kind: 'chat', userId: principal, channel: 'desktop' }); }
function user(sessionId: string, value: string, turn = 1) { return log.appendEvent({ sessionId, turn, role: 'user', type: 'user_input_received', data: { text: value } }); }
function answer(sessionId: string, source: ReturnType<typeof user>, value: string) { return log.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'conversation_completed', data: { sourceUserSeq: source.seq, reply: value } }); }
function typedAnswer(sessionId: string, source: ReturnType<typeof user>, value: string, key: string) {
  const outcomeId = `brain:${key}`;
  const data = { sourceUserSeq: source.seq, attemptId: key, terminalKey: outcomeId, presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId,
    audience: 'user', phase: 'final', identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq, attemptId: key }, status: 'done', kind: 'answer', text: value, resumable: false },
    turnOutcome: { version: 2, id: outcomeId, status: 'done', resumable: false }, reply: value };
  assert.equal(presentationEventFromCompletionData(data)?.text, value, 'the historical competing writer fixture is a fully valid public terminal');
  // Historical migration fixture deliberately retains competing typed rows;
  // the current writer prevents their creation, the reader must elect one.
  log.openEventLog().prepare(`INSERT INTO events(id,session_id,turn,role,type,data_json,created_at) VALUES(?,?,?,'host','conversation_completed',?,?)`)
    .run(key, sessionId, source.turn, JSON.stringify(data), source.createdAt);
}
function reset() { log.resetEventLog(); }
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

test('natural-language source without locators discovers same-principal long-tail text and reads exact pages after restart', async () => {
  reset();
  const target = session('conversation-authored');
  const source = user(target.id, 'Compose a synthetic long draft.');
  const body = `The exact first line.\n${'Retained words with punctuation! '.repeat(1_100)}TAIL-ORCHID-927.\nFinal line?`;
  const completed = answer(target.id, source, body);
  const requester = session('conversation-recaller');
  const accepted = user(requester.id, 'Recall the synthetic orchid draft we worked on earlier. Return its exact body; make no changes.');
  const tools = handlers(requester.id, accepted.seq);
  assert.equal((await tools.get('session_history')!({ session_id: target.id })).isError, true, 'no exact source locator yet');
  const found = json(await tools.get('session_search')!({ query: 'TAIL-ORCHID-927' }));
  assert.equal(found.coverage.complete, true);
  assert.equal(found.hits.length, 1);
  const hit = found.hits[0];
  assert.equal(hit.session_id, target.id);
  assert.equal(hit.source_user_seq, source.seq);
  assert.equal(hit.event_seq, completed.seq);
  assert.equal(hit.excerpt_truncated, true);
  assert.ok(!hit.excerpt.includes('TAIL-ORCHID'), 'the match occurs beyond both prior 800-byte and current excerpt windows');
  assert.equal(hit.through_seq, completed.seq);
  const receiptEvents = log.listEvents(requester.id, { types: ['session_history_search_recorded'] });
  assert.equal(receiptEvents.length, 1);
  assert.equal(projectHarnessEventForPublic(receiptEvents[0]), null, 'private receipt mirror is not public chat text');
  log.closeEventLog();
  const after = user(target.id, 'AFTER-SNAPSHOT-DO-NOT-EXPOSE', 2);
  answer(target.id, after, 'New content is outside the earlier lookup.');
  const history = handlers(requester.id, accepted.seq).get('session_history')!;
  let offset: number | null = 0, assembled = '', pages = 0;
  do {
    const result = await history({ session_id: hit.session_id, through_seq: hit.through_seq,
      snapshot_sha256: hit.snapshot_sha256, search_receipt_id: found.search_receipt_id, offset_chars: offset, max_chars: 12_000 });
    assert.ok(!result.isError, text(result));
    const split = text(result).indexOf('\n\n');
    const header = JSON.parse(text(result).slice(0, split));
    assembled += text(result).slice(split + 2);
    offset = header.next_offset_chars; pages++;
    assert.equal(header.snapshot_sha256, hit.snapshot_sha256);
    assert.ok(pages < 10);
  } while (offset !== null);
  assert.ok(pages > 2);
  assert.ok(assembled.includes(body));
  assert.ok(!assembled.includes('AFTER-SNAPSHOT'));
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number }).n, 0);
  assert.ok(TOOL_REGISTRY.find(tool => tool.name === 'session_search')?.lanes.includes('sdk-brain'));
});

test('index uses canonical elected public text and never returns foreign, synthetic, malformed typed, or tool payload candidates', async () => {
  reset();
  const target = session('public-source');
  const accepted = user(target.id, 'Public candidate.');
  const db = log.openEventLog();
  const terminalTrigger = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_events_one_terminal_per_user_source'").get() as { sql: string }).sql;
  db.exec('DROP TRIGGER trg_events_one_terminal_per_user_source');
  typedAnswer(target.id, accepted, 'ELECTED-SIGNAL is the public answer.', 'typed-winner');
  typedAnswer(target.id, accepted, 'LOSER-SECRET must stay out.', 'typed-loser');
  db.prepare(`INSERT INTO events(id,session_id,turn,role,type,data_json,created_at) VALUES('malformed',?,1,'host','conversation_completed',?,?)`)
    .run(target.id, JSON.stringify({ sourceUserSeq: accepted.seq, presentation: { text: 'MALFORMED-SECRET' }, reply: 'MALFORMED-SECRET' }), accepted.createdAt);
  db.exec(terminalTrigger);
  log.appendEvent({ sessionId: target.id, turn: 1, role: 'tool', type: 'tool_returned', data: { text: 'TOOL-PRIVATE-SECRET' } });
  const synthetic = log.appendEvent({ sessionId: target.id, turn: 2, role: 'system', type: 'user_input_received', data: { synthetic: true, text: 'SYNTHETIC-SECRET instruction' } });
  answer(target.id, synthetic, 'SYNTHETIC-SECRET result');
  log.appendEvent({ sessionId: target.id, turn: 2, role: 'system', type: 'cross_session_prefix', data: { text: 'PREFIX-PRIVATE-SECRET internal context' } });
  log.appendEvent({ sessionId: target.id, turn: 2, role: 'system', type: 'external_write', data: { shapeKey: 'HOST-ACTION-PRIVATE', targets: ['PRIVATE-ACCOUNT-TARGET'] } });
  const inconsistent = log.appendEvent({ sessionId: target.id, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'INCONSISTENT-TARGET-SECRET', userId: 'different-principal' } });
  answer(target.id, inconsistent, 'INCONSISTENT-TARGET-SECRET reply');
  const foreign = session('foreign-session', 'different-principal');
  const foreignSource = user(foreign.id, 'ELECTED-SIGNAL FOREIGN-PRIVATE-SECRET');
  answer(foreign.id, foreignSource, 'FOREIGN-PRIVATE-SECRET');
  const requester = session('requester');
  const source = user(requester.id, 'Recall the earlier public candidate.');
  const tool = handlers(requester.id, source.seq).get('session_search')!;
  for (const query of ['ELECTED-SIGNAL', 'LOSER-SECRET', 'MALFORMED-SECRET', 'TOOL-PRIVATE-SECRET', 'SYNTHETIC-SECRET', 'FOREIGN-PRIVATE-SECRET', 'INCONSISTENT-TARGET-SECRET']) {
    const result = json(await tool({ query }));
    assert.equal(result.hits.length, query === 'ELECTED-SIGNAL' ? 1 : 0, query);
    if (result.hits.length) {
      const redeemed = await handlers(requester.id, source.seq).get('session_history')!({ session_id: target.id, search_receipt_id: result.search_receipt_id });
      assert.ok(!redeemed.isError, text(redeemed));
      assert.match(text(redeemed), /ELECTED-SIGNAL/);
      assert.doesNotMatch(text(redeemed), /LOSER|MALFORMED|TOOL-PRIVATE|SYNTHETIC|FOREIGN-PRIVATE|PREFIX-PRIVATE|HOST-ACTION|PRIVATE-ACCOUNT|INCONSISTENT-TARGET/,
        'the actual receipt read must have the same public scope as the index, not legacy prefix/action context');
    }
  }
  const indexed = (db.prepare('SELECT content FROM session_history_documents_v1 WHERE session_id=?').all(target.id) as Array<{ content: string }>).map(row => row.content).join('\n');
  assert.doesNotMatch(indexed, /LOSER|MALFORMED|TOOL-PRIVATE|SYNTHETIC/);
});

test('fresh lookup rejects an accepted source whose explicit principal differs from its durable conversation', async () => {
  reset();
  const target = session('owned-history'); const authored = user(target.id, 'Owned work.'); answer(target.id, authored, 'PRINCIPAL-CANARY');
  const requester = session('contradictory-source');
  const source = log.appendEvent({ sessionId: requester.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Recall earlier work.', userId: 'foreign-owner' } });
  const result = await handlers(requester.id, source.seq).get('session_search')!({ query: 'PRINCIPAL-CANARY' });
  assert.equal(result.isError, true); assert.match(text(result), /principal contradicts/); assert.doesNotMatch(text(result), /PRINCIPAL-CANARY/);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM session_history_search_receipts_v1').get() as { n: number }).n, 0);
});

test('prior failed recall attempts in the current conversation do not shadow the older target; current history remains an explicit option', async () => {
  reset();
  const target = session('actual-earlier-work'); const authored = user(target.id, 'Compose the earlier work.');
  answer(target.id, authored, 'ORCHID-SELF-SHADOW the actual earlier body.');
  const requester = session('repeat-recall');
  const failed = user(requester.id, 'Find ORCHID-SELF-SHADOW.');
  answer(requester.id, failed, 'I could not find ORCHID-SELF-SHADOW yet.');
  const pendingEarlier = user(requester.id, 'ORCHID-SELF-SHADOW pending earlier work.', 2);
  const current = user(requester.id, 'Try ORCHID-SELF-SHADOW again. SELF-CURRENT-QUERY-SENTINEL', 3);
  const tool = handlers(requester.id, current.seq).get('session_search')!;
  const found = json(await tool({ query: 'ORCHID-SELF-SHADOW', limit: 1 }));
  assert.equal(found.hits[0].session_id, target.id);
  const lateEarlier = answer(requester.id, pendingEarlier, 'ORCHID-SELF-SHADOW LATE-EARLIER-COMPLETION is legitimate prior work.');
  user(requester.id, 'ORCHID-SELF-SHADOW LATER-REQUEST-SENTINEL', 4);
  const included = json(await tool({ query: 'ORCHID-SELF-SHADOW', limit: 1, include_current_conversation: true }));
  assert.equal(included.hits[0].session_id, requester.id);
  assert.ok(included.hits[0].source_user_seq < current.seq);
  assert.equal(included.hits[0].event_seq, lateEarlier.seq, 'late completion of an earlier source remains visible');
  assert.doesNotMatch(included.hits[0].excerpt, /SELF-CURRENT|LATER-REQUEST/);
  const read = await handlers(requester.id, current.seq).get('session_history')!({ session_id: requester.id, search_receipt_id: included.search_receipt_id });
  assert.ok(!read.isError, text(read));
  assert.match(text(read), /LATE-EARLIER-COMPLETION/);
  assert.doesNotMatch(text(read), /SELF-CURRENT|LATER-REQUEST/, 'the actual full receipt snapshot has the same source exclusion as its hits');
  assert.ok(text(read).includes(included.hits[0].excerpt), 'the exact hit is present in the redeemed full snapshot');
  assert.equal(JSON.parse(text(read).split('\n\n')[0]).source_before_seq, current.seq);
  assert.ok(included.next_cursor);
  assert.equal((await tool({ query: 'ORCHID-SELF-SHADOW', limit: 1, cursor: included.next_cursor })).isError, true,
    'a cursor cannot silently change its inclusion scope');
});

test('receipts deny forged IDs, unmatched sessions, altered snapshots, new sources, and changed principals', async () => {
  reset();
  const target = session('bound-target');
  const old = user(target.id, 'Cedar project.'); answer(target.id, old, 'CEDAR-RECEIPT exact body.');
  const other = session('not-returned'); user(other.id, 'Unrelated safe text.');
  const foreign = session('foreign-target', 'foreign'); user(foreign.id, 'Never expose.');
  const requester = session('bound-reader'); const accepted = user(requester.id, 'Recall the cedar project.');
  const tools = handlers(requester.id, accepted.seq); const result = json(await tools.get('session_search')!({ query: 'CEDAR-RECEIPT' }));
  const hit = result.hits[0];
  const base = { session_id: hit.session_id, through_seq: hit.through_seq, snapshot_sha256: hit.snapshot_sha256, search_receipt_id: result.search_receipt_id };
  const history = tools.get('session_history')!;
  for (const change of [{ search_receipt_id: 'history-search-forged' }, { session_id: other.id }, { session_id: foreign.id },
    { through_seq: hit.through_seq + 1 }, { snapshot_sha256: '0'.repeat(64) }, { max_turns: 1 }]) {
    assert.equal((await history({ ...base, ...change })).isError, true, JSON.stringify(change));
  }
  const next = user(requester.id, 'A later request.', 2);
  assert.equal((await handlers(requester.id, next.seq).get('session_history')!(base)).isError, true);
  assert.equal((await handlers().get('session_search')!({ query: 'CEDAR' })).isError, true);
  log.openEventLog().prepare('UPDATE sessions SET user_id=? WHERE id=?').run('changed-owner', target.id);
  assert.equal((await history(base)).isError, true);
  log.openEventLog().prepare('UPDATE sessions SET user_id=? WHERE id=?').run('fixture-owner', target.id);
  assert.ok(!(await history(base)).isError, 'unchanged exact old source remains a valid read observer');
  log.openEventLog().prepare('UPDATE sessions SET user_id=? WHERE id=?').run('changed-reader', requester.id);
  assert.equal((await history(base)).isError, true);
});

test('source, retained text and table-only receipt tampering fail closed across reopen', async () => {
  reset();
  const target = session('tamper-target'); const old = user(target.id, 'Compose original.');
  const completed = answer(target.id, old, 'TAMPER-CANARY original body.');
  const requester = session('tamper-reader'); const accepted = user(requester.id, 'Recall the original.');
  const tools = handlers(requester.id, accepted.seq); const found = json(await tools.get('session_search')!({ query: 'TAMPER-CANARY' }));
  const hit = found.hits[0], base = { session_id: target.id, through_seq: hit.through_seq, snapshot_sha256: hit.snapshot_sha256, search_receipt_id: found.search_receipt_id };
  const history = tools.get('session_history')!; const db = log.openEventLog();
  const original = db.prepare('SELECT data_json FROM events WHERE seq=?').get(completed.seq) as { data_json: string };
  db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(JSON.stringify({ sourceUserSeq: old.seq, reply: 'TAMPER-CANARY changed body.' }), completed.seq);
  assert.equal((await history(base)).isError, true);
  db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(original.data_json, completed.seq);
  const requesterBytes = db.prepare('SELECT data_json FROM events WHERE seq=?').get(accepted.seq) as { data_json: string };
  db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(JSON.stringify({ text: 'Forged accepted source.' }), accepted.seq);
  assert.equal((await history(base)).isError, true);
  db.prepare('UPDATE events SET data_json=? WHERE seq=?').run(requesterBytes.data_json, accepted.seq);
  const row = db.prepare('SELECT receipt_json FROM session_history_search_receipts_v1 WHERE receipt_id=?').get(found.search_receipt_id) as { receipt_json: string };
  const forged = JSON.parse(row.receipt_json); forged.query.query = 'changed';
  const bytes = JSON.stringify(forged); db.prepare('UPDATE session_history_search_receipts_v1 SET receipt_json=?,receipt_sha256=? WHERE receipt_id=?')
    .run(bytes, createHash('sha256').update(bytes).digest('hex'), found.search_receipt_id);
  log.closeEventLog();
  assert.equal((await history(base)).isError, true, 'rehashing the materialized row cannot replace its durable mirror');
});

test('complete time-window pages use event time, explicit boundaries and a stable query; changed index invalidates only search cursors', async () => {
  reset();
  const target = session('morning-history');
  for (let i = 0; i < 5; i++) {
    const source = user(target.id, `Morning work ${i}.`, i + 1);
    const event = answer(target.id, source, `MORNING-ITEM-${i}`);
    log.openEventLog().prepare('UPDATE events SET created_at=? WHERE seq IN (?,?)').run(`2026-09-05T${i === 4 ? '21' : '16'}:0${i}:00.000Z`, source.seq, event.seq);
  }
  const requester = session('morning-reader'); const accepted = user(requester.id, 'What did we work on this morning?');
  const tool = handlers(requester.id, accepted.seq).get('session_search')!;
  const query = { query: 'MORNING-ITEM', after: '2026-09-05T00:00:00-07:00', before: '2026-09-05T12:00:00-07:00', limit: 2 };
  const first = json(await tool(query)); assert.equal(first.hits.length, 2); assert.ok(first.next_cursor);
  log.closeEventLog();
  const second = json(await tool({ ...query, cursor: first.next_cursor }));
  assert.equal(second.hits.length, 2); assert.equal(second.next_cursor, null);
  const all = [...first.hits, ...second.hits];
  assert.equal(new Set(all.map(hit => hit.event_seq)).size, 4);
  assert.ok(all.every(hit => !hit.excerpt.includes('ITEM-4')));
  assert.equal((await tool({ ...query, query: 'different', cursor: first.next_cursor })).isError, true);
  const other = session('later-indexed'); const newlyFound = user(other.id, 'A new public conversation.');
  const newAnswer = answer(other.id, newlyFound, 'MORNING-ITEM-NEW newly indexed exact public answer.');
  log.openEventLog().prepare('UPDATE events SET created_at=? WHERE seq IN (?,?)').run('2026-09-05T16:22:00.000Z', newlyFound.seq, newAnswer.seq);
  const newer = user(requester.id, 'New search.', 2);
  search.searchSessionHistory({ sessionId: requester.id, sourceUserSeq: newer.seq, query: '' });
  const stale = await tool({ ...query, cursor: first.next_cursor });
  assert.equal(stale.isError, true);
  assert.match(text(stale), /restart the search without a cursor/);
  const refreshed = json(await tool(query));
  assert.equal(refreshed.hits.length, 2, 'a no-cursor call acquires a fresh snapshot within the same accepted source');
  assert.ok(refreshed.coverage.observed_through_seq > first.coverage.observed_through_seq);
  assert.equal(refreshed.hits[0].session_id, other.id);
  const refreshedHistory = await handlers(requester.id, accepted.seq).get('session_history')!({ session_id: other.id, search_receipt_id: refreshed.search_receipt_id });
  assert.ok(!refreshedHistory.isError, text(refreshedHistory));
  assert.match(text(refreshedHistory), /MORNING-ITEM-NEW newly indexed exact public answer/);
  const hit = first.hits[0];
  assert.ok(!(await handlers(requester.id, accepted.seq).get('session_history')!({ session_id: hit.session_id, search_receipt_id: first.search_receipt_id })).isError,
    'a changed search index cannot revoke unchanged exact history snapshot bytes');
});

test('incremental coverage is explicit, converges without raw tool scans, and reopening preserves progress', () => {
  reset();
  const db = log.openEventLog(); const noise = session('noise');
  const insert = db.prepare(`INSERT INTO events(id,session_id,turn,role,type,data_json,created_at) VALUES(?,?,1,'tool','tool_returned',?,'2026-09-05T00:00:00Z')`);
  db.transaction(() => { for (let i = 0; i < 2_000; i++) insert.run(`noise-${i}`, noise.id, JSON.stringify({ text: 'private raw '.repeat(300) })); })();
  for (let i = 0; i < 12; i++) { const target = session(`backfill-${i}`); const source = user(target.id, `RECALL-SET item ${i}`); answer(target.id, source, `RECALL-SET response ${i}`); }
  const requester = session('backfill-reader'); const source = user(requester.id, 'Recall the set.');
  // Unfiltered browsing retains bounded incremental projection; a named
  // recall deliberately sweeps more relevant sessions within the same call.
  const query = '';
  let result = search.searchSessionHistory({ sessionId: requester.id, sourceUserSeq: source.seq, query, limit: 20 });
  assert.equal(result.coverage.complete, false); assert.ok(result.coverage.pending_sessions > 0);
  const cursor = (db.prepare('SELECT scanned_through_seq FROM session_history_index_state_v1').get() as { scanned_through_seq: number }).scanned_through_seq;
  log.closeEventLog();
  assert.equal((log.openEventLog().prepare('SELECT scanned_through_seq FROM session_history_index_state_v1').get() as { scanned_through_seq: number }).scanned_through_seq, cursor);
  let advances = 0;
  while (!result.coverage.complete) { result = search.searchSessionHistory({ sessionId: requester.id, sourceUserSeq: source.seq, query, limit: 20 }); assert.ok(++advances < 5); }
  const args = ['user_input_received', 'conversation_completed', 'awaiting_user_input'].flatMap(type => [type, 0, source.seq, 128]);
  const plan = (log.openEventLog().prepare(`EXPLAIN QUERY PLAN ${search.SESSION_HISTORY_INDEX_CURSOR_SQL}`).all(...args, 128) as Array<{ detail: string }>).map(row => row.detail);
  assert.equal(plan.filter(detail => /SEARCH events USING INDEX idx_events_type_seq/.test(detail)).length, 3, plan.join('\n'));
  assert.ok(!plan.some(detail => /^SCAN events/.test(detail)));
  const docs = log.openEventLog().prepare('SELECT COUNT(*) AS n FROM session_history_documents_v1').get() as { n: number };
  assert.equal(docs.n, 25, 'only retained real public exchanges are indexed, including the requester which is excluded from its own results');
  assert.equal(result.hits.length, 20); assert.ok(result.next_cursor, 'the remaining four matches are navigable, not silently dropped');
  const last = search.searchSessionHistory({ sessionId: requester.id, sourceUserSeq: source.seq, query, limit: 20, cursor: result.next_cursor });
  assert.equal(last.hits.length, 4);
});

test('large search pages remain valid transport JSON and every omitted hit is reachable by its exact cursor', async () => {
  reset();
  const target = session('transport-target');
  for (let i = 0; i < 20; i++) {
    const source = user(target.id, `Compose item ${i}.`, i + 1);
    answer(target.id, source, `TRANSPORT-CANARY-${i}\n${'line\n'.repeat(300)}`);
  }
  const requester = session('transport-reader');
  const accepted = user(requester.id, 'Find the earlier synthetic transport work.');
  const tool = handlers(requester.id, accepted.seq).get('session_search')!;
  const seen: number[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const response = await tool({ query: 'TRANSPORT-CANARY', limit: 20, cursor });
    assert.ok(text(response).length < 20_000);
    const result = json(response);
    assert.equal(result.coverage.complete, true);
    seen.push(...result.hits.map(hit => hit.event_seq));
    cursor = result.next_cursor;
    assert.ok(++pages < 5);
  } while (cursor);
  assert.ok(pages > 1, 'the page budget really caused a navigable continuation');
  assert.equal(seen.length, 20);
  assert.equal(new Set(seen).size, 20);
});

test('optional backfill command requires an explicit home and resumes bounded durable coverage without conversation or effect writes', () => {
  reset();
  for (let i = 0; i < 9; i++) { const target = session(`cli-backfill-${i}`); user(target.id, `CLI-RECALL item ${i}`); }
  const countBefore = (log.openEventLog().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  log.closeEventLog();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-session-history-index.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30_000,
  });
  const missing = run(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /explicit\/home/);
  const first = run('--home', fixtureHome, '--max-batches', '1'); assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout.trim()).coverage.complete, false);
  const second = run('--home', fixtureHome, '--max-batches', '10'); assert.equal(second.status, 0, second.stderr);
  const progress = second.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(progress.at(-1).coverage.complete, true);
  assert.equal(progress.length, 2);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, countBefore);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number }).n, 0);
  assert.deepEqual(log.openEventLog().prepare('PRAGMA foreign_key_check').all(), []);
});
