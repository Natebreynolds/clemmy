/** Reconstructed round 19 controls. Real private SQLite; no app, provider or live-home access. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-preview-reuse-reconstructed-'));
for (const name of ['HOME', 'CLEMENTINE_HOME', 'CLEMMY_HOME']) process.env[name] = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const { claimSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
const { buildUnifiedSessionList, getUnifiedSessionDetail } = await import('./sessions-api.js');
const { default: Database } = await import('better-sqlite3');
type Db = ReturnType<typeof log.openEventLog>;
let serial = 0;

function accepted(label: string, options: { empty?: boolean } = {}) {
  const n = ++serial;
  const id = `preview-reuse-${label}-${n}`;
  const continuity = { provider: 'desktop', scopeId: null, conversationId: id, audienceId: `owner-${n}` };
  const row = log.createSession({ id, kind: 'chat', channel: 'desktop', userId: continuity.audienceId,
    title: `Fixture ${label}`, metadata: { source: 'desktop', channelId: id, userId: continuity.audienceId, tags: [id] } });
  const select = () => claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: row.id,
    durableSourceId: `preview-run-${++serial}`, continuity,
    receipt: { requestId: `preview-request-${serial}`, runId: `preview-run-${serial}`, inputHash: String(serial).padStart(64, '0') } }).selection;
  assert.equal(select().sessionId, row.id);
  let replySeq: number | undefined;
  if (!options.empty) replySeq = exchange(row.id, `${label} request`, `${label} answer`);
  const list = (extra = {}, diagnostics = {}) => buildUnifiedSessionList({ tag: row.id, includeArchived: true, limit: 500, ...extra }, diagnostics);
  return { id, row, list, select, continuity, replySeq };
}
function exchange(id: string, request: string, reply: string): number {
  const source = log.appendEvent({ sessionId: id, turn: 1, role: 'user', type: 'user_input_received', data: { text: request } });
  return log.appendEvent({ sessionId: id, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, reply } }).seq;
}
function changeReply(db: Db, seq: number, text: string) {
  db.prepare("UPDATE events SET data_json = json_set(data_json, '$.reply', ?) WHERE seq = ?").run(text, seq);
}
function instrument(db: Db) {
  const prepare = db.prepare.bind(db);
  const pragma = db.pragma.bind(db);
  const wrapped = new WeakSet<object>();
  const reads: Array<{ id: string; args: unknown[] }> = [];
  const searchReads: string[] = [];
  let publicRead: (() => void) | undefined;
  let totalRead: (() => void) | undefined;
  let counters: 'ok' | 'throw' | 'string' | 'negative' = 'ok';
  let versions: 'ok' | 'throw' | 'string' | 'negative' = 'ok';
  let schemas: 'ok' | 'throw' | 'string' | 'negative' = 'ok';
  db.pragma = ((sql: string, options?: unknown) => {
    if (sql === 'data_version' && !db.inTransaction) {
      if (versions === 'throw') throw new Error('fixture data_version unavailable');
      if (versions === 'string') return '1';
      if (versions === 'negative') return -1;
    }
    if (sql === 'schema_version' && !db.inTransaction) {
      if (schemas === 'throw') throw new Error('fixture schema_version unavailable');
      if (schemas === 'string') return '1';
      if (schemas === 'negative') return -1;
    }
    return pragma(sql, options as { simple?: boolean });
  }) as typeof db.pragma;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!wrapped.has(statement)) {
      wrapped.add(statement);
      if (/SELECT \* FROM events WHERE session_id/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const result = all(...args);
          if (args.includes('user_input_received') && args.includes('conversation_completed')) {
            reads.push({ id: String(args[0]), args });
            publicRead?.();
          }
          return result;
        }) as typeof statement.all;
      }
      if (/SELECT \* FROM events NOT INDEXED\s+WHERE seq IN/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          searchReads.push(String(args.at(-1)));
          return all(...args);
        }) as typeof statement.all;
      }
      if (/SELECT\s+total_changes\(\)/i.test(sql)) {
        const get = statement.get.bind(statement);
        statement.get = ((...args: unknown[]) => {
          if (counters === 'throw') throw new Error('fixture counter unavailable');
          const result = get(...args);
          totalRead?.();
          if (counters === 'string') return { changes: '1' };
          if (counters === 'negative') return { changes: -1 };
          return result;
        }) as typeof statement.get;
      }
    }
    return statement;
  }) as typeof db.prepare;
  return { reads, searchReads, reset: () => { reads.length = 0; searchReads.length = 0; }, count: (id: string) => reads.filter(r => r.id === id).length,
    onPublicRead: (fn?: () => void) => { publicRead = fn; }, onTotalRead: (fn?: () => void) => { totalRead = fn; },
    counters: (value: typeof counters) => { counters = value; }, versions: (value: typeof versions) => { versions = value; },
    schemas: (value: typeof schemas) => { schemas = value; },
    restore: () => { db.prepare = prepare; db.pragma = pragma; } };
}
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });
test.afterEach(() => { log.closeEventLog(); });

test('unchanged accepted chat previews reuse only scalar output; public nine-type 1000 window and fresh detail/search remain', () => {
  const f = accepted('warm');
  const db = log.openEventLog(); const m = instrument(db);
  try {
    const first = f.list();
    assert.equal(first.length, 1); assert.equal(first[0]!.preview, 'warm answer'); assert.equal(first[0]!.turnCount, 2);
    assert.equal(m.count(f.id), 1);
    const args = m.reads[0]!.args;
    assert.equal(args.at(-1), 1000);
    assert.deepEqual(args.slice(1, -1), ['user_input_received', 'conversation_completed', 'conversation_superseded',
      'conversation_check_in', 'plan_revision_published', 'workflow_saved', 'clem_message', 'approval_requested',
      // An answer delivered first carries its later review ruling (8453a6879).
      'completion_review_settled']);
    m.reset(); const proofPhases: string[] = [];
    assert.deepEqual(f.list({}, { observer: (phase: string) => proofPhases.push(phase) }), first);
    assert.equal(m.count(f.id), 0, 'a warmed unchanged preview must avoid the public payload query');
    assert.ok(proofPhases.includes('catalog_lineage_proofs'), 'accepted lineage proofs remain fresh on a cache hit');
    first[0]!.preview = 'caller mutation';
    assert.equal(f.list()[0]!.preview, 'warm answer', 'no summary object is shared with callers');
    m.reset(); assert.equal(getUnifiedSessionDetail(`harness:${f.id}`)!.turns.length, 2);
    assert.equal(m.count(f.id), 1, 'detail still reconstructs public events');
    m.reset();
    let searchPhases = 0;
    assert.equal(f.list({ q: 'warm request' }, { observer: (phase: string) => { if (phase === 'catalog_search') searchPhases++; } }).length, 1);
    assert.equal(searchPhases, 1, 'search is evaluated afresh rather than caching a catalog result');
    assert.equal(m.searchReads.filter(id => id === f.id).length, 1);
    assert.equal(m.count(f.id), 0, 'search does not consume or replace the public preview cache');
    f.list({ q: 'warm request' });
    assert.equal(m.searchReads.filter(id => id === f.id).length, 2, 'each search redeems its own public payload window');
  } finally { m.restore(); }
});

test('same-connection and external UPDATE/DELETE invalidate even with unchanged MAX(seq); unrelated writes invalidate conservatively', () => {
  const f = accepted('mutation'); const db = log.openEventLog(); const other = new Database(log.HARNESS_DB_PATH);
  const m = instrument(db);
  try {
    log.appendEvent({ sessionId: f.id, turn: 0, role: 'system', type: 'turn_model_routed', data: { note: 'nonpublic tail' } });
    const max = () => db.prepare('SELECT MAX(seq) AS n FROM events').get();
    const originalMax = max(); f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    changeReply(db, f.replySeq!, 'same connection changed'); m.reset();
    assert.equal(f.list()[0]!.preview, 'same connection changed'); assert.equal(m.count(f.id), 1); assert.deepEqual(max(), originalMax);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    changeReply(other, f.replySeq!, 'external changed'); m.reset();
    assert.equal(f.list()[0]!.preview, 'external changed'); assert.equal(m.count(f.id), 1); assert.deepEqual(max(), originalMax);
    f.list(); other.prepare('DELETE FROM events WHERE seq = ?').run(f.replySeq!); m.reset();
    assert.equal(f.list()[0]!.preview, 'mutation request'); assert.equal(f.list()[0]!.turnCount, 1);
    assert.equal(m.count(f.id), 1); assert.deepEqual(max(), originalMax);
    f.list(); db.exec('CREATE TABLE preview_unrelated (value INTEGER)'); db.prepare('INSERT INTO preview_unrelated VALUES (?)').run(1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 1, 'unknown same-connection writes clear rather than guess relevance');
    f.list(); other.prepare('UPDATE preview_unrelated SET value = ?').run(2); m.reset(); f.list();
    assert.equal(m.count(f.id), 1, 'unknown external commits clear rather than guess relevance');
    const source = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received'").get(f.id) as { seq: number };
    db.prepare('DELETE FROM events WHERE seq = ?').run(source.seq); m.reset();
    assert.equal(f.list()[0]!.turnCount, 0); assert.equal(m.count(f.id), 1); assert.deepEqual(max(), originalMax);
  } finally { m.restore(); other.close(); }
});

test('metadata, principal, and accepted Stop lineage changes are freshly elected; forged pointers cannot reuse private history', () => {
  const f = accepted('lineage'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list(); log.updateSession(f.id, { status: 'cancelled' });
    const child = f.select(); assert.equal(child.disposition, 'branched'); exchange(child.sessionId, 'next request', 'next answer');
    const joined = f.list()[0]!; assert.equal(joined.executionSessionId, child.sessionId); assert.equal(joined.turnCount, 4);
    assert.equal(joined.preview, 'next answer'); m.reset(); f.list(); assert.equal(m.count(f.id), 0); assert.equal(m.count(child.sessionId), 0);
    db.prepare("UPDATE sessions SET metadata_json = json_set(metadata_json, '$.pinned', json('true'), '$.tags', json(?)) WHERE id = ?")
      .run(JSON.stringify([f.id, 'changed-tag']), f.id);
    assert.equal(f.list({ tag: 'changed-tag' })[0]!.pinned, true);
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('foreign-owner', child.sessionId);
    const split = f.list()[0]!; assert.equal(split.executionSessionId, undefined); assert.equal(split.turnCount, 2); assert.equal(split.preview, 'lineage answer');
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(f.continuity.audienceId, child.sessionId);
    assert.equal(f.list()[0]!.turnCount, 4);
    const forged = log.createSession({ id: `forged-${f.id}`, kind: 'chat', channel: 'desktop', userId: f.continuity.audienceId,
      metadata: { ...log.getSession(child.sessionId)!.metadata } });
    exchange(forged.id, 'forged request', 'forged answer');
    db.prepare('UPDATE accepted_source_session_pointers SET head_session_id = ? WHERE root_session_id = ?').run(forged.id, f.id);
    const rejected = f.list().find(row => row.id === `harness:${f.id}`)!;
    assert.equal(rejected.executionSessionId, undefined); assert.equal(rejected.turnCount, 2); assert.equal(rejected.preview, 'lineage answer');
    assert.doesNotMatch(JSON.stringify(getUnifiedSessionDetail(`harness:${f.id}`)!.turns), /forged|next answer/);
  } finally { m.restore(); }
});

test('preexisting transactions never reuse or retain uncommitted values; rollback and later commit are observed', () => {
  const f = accepted('transaction'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    db.exec('BEGIN');
    try {
      m.reset(); assert.equal(f.list()[0]!.preview, 'transaction answer'); assert.equal(m.count(f.id), 1);
      changeReply(db, f.replySeq!, 'uncommitted answer'); m.reset();
      assert.equal(f.list()[0]!.preview, 'uncommitted answer'); assert.equal(m.count(f.id), 1);
      m.reset(); f.list(); assert.equal(m.count(f.id), 1, 'transaction values cannot become warm cache hits');
    } finally { db.exec('ROLLBACK'); }
    m.reset(); assert.equal(f.list()[0]!.preview, 'transaction answer'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    db.transaction(() => changeReply(db, f.replySeq!, 'committed answer'))(); m.reset();
    assert.equal(f.list()[0]!.preview, 'committed answer'); assert.equal(m.count(f.id), 1);
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); m.restore(); }
});

test('unavailable or malformed counters fall back; original reader and malformed JSON exceptions still propagate', () => {
  const f = accepted('errors'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list();
    for (const mode of ['throw', 'string', 'negative'] as const) {
      m.counters(mode); m.reset(); assert.equal(f.list()[0]!.preview, 'errors answer'); f.list();
      assert.equal(m.count(f.id), 2, `counter mode ${mode} must never authorize reuse`);
    }
    m.counters('ok');
    for (const mode of ['throw', 'string', 'negative'] as const) {
      m.versions(mode); m.reset(); assert.equal(f.list()[0]!.preview, 'errors answer'); f.list();
      assert.equal(m.count(f.id), 2, `data_version mode ${mode} must never authorize reuse`);
    }
    m.versions('ok');
    for (const mode of ['throw', 'string', 'negative'] as const) {
      m.schemas(mode); m.reset(); assert.equal(f.list()[0]!.preview, 'errors answer'); f.list();
      assert.equal(m.count(f.id), 2, `schema_version mode ${mode} must never authorize reuse`);
    }
    m.schemas('ok'); f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    changeReply(db, f.replySeq!, 'reader failing');
    m.onPublicRead(() => { throw new Error('fixture original projector error'); });
    assert.throws(() => f.list(), /fixture original projector error/, 'cache plumbing cannot catch original projection failures');
    m.onPublicRead(); assert.equal(f.list()[0]!.preview, 'reader failing');
    // A legacy public message can contain malformed JSON. Terminal-specific
    // expression indexes correctly reject corruption of a completion instead.
    const legacy = log.appendEvent({ sessionId: f.id, turn: 0, role: 'Clem', type: 'clem_message', data: { text: 'legacy fixture' } });
    const saved = db.prepare('SELECT data_json FROM events WHERE seq = ?').get(legacy.seq) as { data_json: string };
    f.list();
    db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{malformed', legacy.seq);
    assert.throws(() => f.list(), SyntaxError, 'a changed malformed public payload cannot be hidden by a warm scalar');
    db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(saved.data_json, legacy.seq);
    assert.equal(f.list()[0]!.turnCount, 3);
  } finally { m.restore(); }
});

test('external commits during MISS hydration and between warmed HIT checks cannot store or return an old scalar', () => {
  const miss = accepted('miss-race'); const db = log.openEventLog(); const other = new Database(log.HARNESS_DB_PATH);
  const m = instrument(db);
  try {
    let fired = false;
    m.onPublicRead(() => { if (!fired) { fired = true; changeReply(other, miss.replySeq!, 'after miss commit'); } });
    assert.equal(miss.list()[0]!.preview, 'miss-race answer', 'original read may finish at its pre-commit snapshot');
    m.onPublicRead(); assert.equal(fired, true); m.reset();
    assert.equal(miss.list()[0]!.preview, 'after miss commit'); assert.equal(m.count(miss.id), 1, 'raced MISS must not populate the later generation');
    m.reset(); miss.list(); assert.equal(m.count(miss.id), 0);
    let reads = 0; fired = false;
    m.onTotalRead(() => { if (++reads === 3) { fired = true; changeReply(other, miss.replySeq!, 'after hit commit'); } });
    m.reset(); assert.equal(miss.list()[0]!.preview, 'after hit commit'); assert.equal(fired, true);
    assert.equal(m.count(miss.id), 1, 'a commit between warmed-hit generation checks falls back to the original projector');
    m.onTotalRead(); m.reset(); assert.equal(miss.list()[0]!.preview, 'after hit commit'); assert.equal(m.count(miss.id), 1);
    m.reset(); miss.list(); assert.equal(m.count(miss.id), 0);
  } finally { m.restore(); other.close(); }
});

test('a commit after accepted-row snapshot acquisition forbids reuse for that request', () => {
  const f = accepted('snapshot-race'); const db = log.openEventLog(); const other = new Database(log.HARNESS_DB_PATH);
  const m = instrument(db);
  try {
    f.list(); let fired = false; m.reset();
    const changed = f.list({}, { observer: (phase: string) => {
      if (phase === 'catalog_collect' && !fired) { fired = true; changeReply(other, f.replySeq!, 'after snapshot commit'); }
    } });
    assert.equal(fired, true); assert.equal(changed[0]!.preview, 'after snapshot commit'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 1, 'the raced snapshot cannot authorize storage for a later request');
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
  } finally { m.restore(); other.close(); }
});

test('verified empty chats can reuse zero; legacy and workflow paths still read fresh; close/reopen uses a new DB identity', () => {
  const f = accepted('empty', { empty: true }); const db = log.openEventLog(); const m = instrument(db);
  try {
    assert.equal(f.list()[0]!.turnCount, 0); assert.equal(f.list()[0]!.preview, ''); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    const legacy = log.createSession({ id: `legacy-${f.id}`, kind: 'chat', channel: 'desktop', metadata: { tags: [`legacy-${f.id}`] } });
    exchange(legacy.id, 'legacy request', 'legacy answer');
    const legacyList = () => buildUnifiedSessionList({ tag: legacy.id }); legacyList(); m.reset(); legacyList(); assert.equal(m.count(legacy.id), 1);
    const workflow = log.createSession({ id: `workflow-${f.id}`, kind: 'workflow', channel: 'workflow', userId: 'owner',
      metadata: { tags: [`workflow-${f.id}`], workflowRunId: `run-${f.id}`, workflowName: 'Fixture flow', stepId: 'only' } });
    exchange(workflow.id, 'workflow request', 'workflow answer');
    const workflowList = () => buildUnifiedSessionList({ tag: workflow.id }); workflowList(); m.reset(); workflowList(); assert.equal(m.count(workflow.id), 1);
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
  } finally { m.restore(); }
  log.closeEventLog(); const replacement = log.openEventLog(); assert.notEqual(replacement, db);
  const reopened = instrument(replacement);
  try { assert.equal(f.list()[0]!.turnCount, 0); assert.equal(reopened.count(f.id), 1); reopened.reset(); f.list(); assert.equal(reopened.count(f.id), 0); }
  finally { reopened.restore(); }
});

test('the actual oldest 1000 public-event window stays unchanged when later or outside-window events exist', () => {
  const f = accepted('bounded-window', { empty: true });
  for (let n = 0; n < 502; n++) exchange(f.id, `window request ${n}`, `window answer ${n}`);
  const db = log.openEventLog(); const m = instrument(db);
  try {
    const first = f.list()[0]!; assert.equal(first.turnCount, 1000); assert.equal(first.preview, 'window answer 499');
    m.reset(); assert.equal(f.list()[0]!.preview, first.preview); assert.equal(m.count(f.id), 0);
    const outside = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'conversation_completed' ORDER BY seq DESC LIMIT 1")
      .get(f.id) as { seq: number };
    changeReply(db, outside.seq, 'outside the retained oldest window'); m.reset();
    assert.equal(f.list()[0]!.preview, first.preview); assert.equal(f.list()[0]!.turnCount, 1000); assert.equal(m.count(f.id), 1);
    assert.equal(getUnifiedSessionDetail(`harness:${f.id}`)!.turns.length, 1000);
  } finally { m.restore(); }
});

test('the scalar cache evicts its least recently used entry at 256 rather than retaining an unbounded catalog', () => {
  const fixtures = Array.from({ length: 257 }, (_, n) => accepted(`capacity-${n}`, { empty: true }));
  const db = log.openEventLog(); const m = instrument(db);
  try {
    for (const f of fixtures) f.list();
    const newest = fixtures.at(-1)!; m.reset(); newest.list(); assert.equal(m.count(newest.id), 0);
    const oldest = fixtures[0]!; m.reset(); oldest.list(); assert.equal(m.count(oldest.id), 1, 'the 257th insert evicted the oldest scalar');
    m.reset(); newest.list(); assert.equal(m.count(newest.id), 0, 'reading a hit refreshes its LRU position');
    const nextOldest = fixtures[1]!; m.reset(); nextOldest.list(); assert.equal(m.count(nextOldest.id), 1);
  } finally { m.restore(); }
});

test('an oversized lineage key retains the ordinary projector instead of caching unbounded identifiers', () => {
  const id = `preview-large-key-${'x'.repeat(8193)}`;
  const continuity = { provider: 'desktop', scopeId: null, conversationId: 'preview-large-key', audienceId: 'large-key-owner' };
  log.createSession({ id, kind: 'chat', channel: 'desktop', userId: continuity.audienceId, title: 'Long identity fixture',
    metadata: { source: 'desktop', channelId: continuity.conversationId, userId: continuity.audienceId, tags: ['preview-large-key'] } });
  assert.equal(claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: id, durableSourceId: 'preview-large-key-run', continuity,
    receipt: { requestId: 'preview-large-key-request', runId: 'preview-large-key-run', inputHash: 'a'.repeat(64) } }).selection.sessionId, id);
  exchange(id, 'long key request', 'long key answer');
  const db = log.openEventLog(); const m = instrument(db);
  try {
    const list = () => buildUnifiedSessionList({ tag: 'preview-large-key' });
    assert.equal(list()[0]!.preview, 'long key answer'); m.reset();
    assert.equal(list()[0]!.turnCount, 2); assert.equal(m.count(id), 1, 'a key larger than 16 KiB is never reused');
  } finally { m.restore(); }
});

test('same-connection DDL invalidates even when data_version and total_changes stay unchanged', () => {
  const f = accepted('schema-only'); const db = log.openEventLog(); const m = instrument(db);
  const dataCounters = () => ({ version: db.pragma('data_version', { simple: true }),
    changes: (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes });
  try {
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    const before = dataCounters(); const schemaBefore = db.pragma('schema_version', { simple: true });
    db.exec('CREATE TABLE preview_schema_only (value INTEGER)');
    assert.deepEqual(dataCounters(), before, 'pure DDL is not covered by either data counter');
    assert.notEqual(db.pragma('schema_version', { simple: true }), schemaBefore);
    m.reset(); assert.equal(f.list()[0]!.preview, 'schema-only answer');
    assert.equal(m.count(f.id), 1, 'main-schema DDL must force the original public reader');
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    const beforeDrop = dataCounters(); db.exec('DROP TABLE preview_schema_only');
    assert.deepEqual(dataCounters(), beforeDrop);
    m.reset(); assert.equal(f.list()[0]!.turnCount, 2); assert.equal(m.count(f.id), 1);
  } finally { m.restore(); }
});
