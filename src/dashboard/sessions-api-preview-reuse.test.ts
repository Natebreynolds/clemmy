/** Preview reuse controls. Real private SQLite; no app, provider or live-home access.
 *
 * A session's list preview is reused until its own conversation changes: a
 * member row's updated_at, its event count or last seq, or the schema. The
 * event log is append-only in production (retention deletes whole rows), so
 * those marks are the whole truth; a store-wide generation here made every
 * unrelated write rebuild all 200 previews on each 10-s sidebar poll. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-preview-reuse-'));
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
/** A later message from another connection: the production shape of an
 * external change to a conversation (the daemon and a tool both append). */
function externalExchange(other: InstanceType<typeof Database>, id: string, request: string, reply: string): void {
  const next = (other.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events').get() as { seq: number }).seq;
  const insert = other.prepare(`INSERT INTO events (seq, id, session_id, turn, role, type, data_json, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`);
  const at = new Date().toISOString();
  insert.run(next, `ext-${next}`, id, 'user', 'user_input_received', JSON.stringify({ text: request }), at);
  insert.run(next + 1, `ext-${next + 1}`, id, 'Clem', 'conversation_completed', JSON.stringify({ sourceUserSeq: next, reply }), at);
}
function instrument(db: Db) {
  const prepare = db.prepare.bind(db);
  const pragma = db.pragma.bind(db);
  const wrapped = new WeakSet<object>();
  const reads: Array<{ id: string; args: unknown[] }> = [];
  const searchReads: string[] = [];
  let publicRead: (() => void) | undefined;
  let schemas: 'ok' | 'throw' | 'string' | 'negative' = 'ok';
  db.pragma = ((sql: string, options?: unknown) => {
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
    }
    return statement;
  }) as typeof db.prepare;
  return { reads, searchReads, reset: () => { reads.length = 0; searchReads.length = 0; }, count: (id: string) => reads.filter(r => r.id === id).length,
    onPublicRead: (fn?: () => void) => { publicRead = fn; },
    schemas: (value: typeof schemas) => { schemas = value; },
    restore: () => { db.prepare = prepare; db.pragma = pragma; } };
}
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });
test.afterEach(() => { log.closeEventLog(); });

test('unchanged accepted chat previews reuse only scalar output; public ten-type 1000 window and fresh detail/search remain', () => {
  const f = accepted('warm');
  const db = log.openEventLog(); const m = instrument(db);
  try {
    const first = f.list();
    assert.equal(first.length, 1); assert.equal(first[0]!.preview, 'warm answer'); assert.equal(first[0]!.turnCount, 2);
    assert.equal(m.count(f.id), 1);
    const args = m.reads[0]!.args;
    assert.equal(args.at(-1), 1000);
    // A question's own answers ride on its reopened turn (1dd119752).
    assert.deepEqual(args.slice(1, -1), ['user_input_received', 'conversation_completed', 'awaiting_user_input', 'conversation_superseded',
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

test('a message appended on this or another connection replaces the preview; a retention delete does too; writes elsewhere keep it', () => {
  const f = accepted('mutation'); const db = log.openEventLog(); const other = new Database(log.HARNESS_DB_PATH);
  const m = instrument(db);
  try {
    log.appendEvent({ sessionId: f.id, turn: 0, role: 'system', type: 'turn_model_routed', data: { note: 'nonpublic tail' } });
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    exchange(f.id, 'second request', 'same connection changed'); m.reset();
    assert.equal(f.list()[0]!.preview, 'same connection changed'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    externalExchange(other, f.id, 'third request', 'external changed'); m.reset();
    assert.equal(f.list()[0]!.preview, 'external changed'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    // Retention removes whole rows; a removed last reply changes the count.
    const last = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'conversation_completed' ORDER BY seq DESC LIMIT 1").get(f.id) as { seq: number };
    other.prepare('DELETE FROM events WHERE seq = ?').run(last.seq); m.reset();
    assert.equal(f.list()[0]!.preview, 'third request'); assert.equal(m.count(f.id), 1);
    // Writes to other sessions and other tables are not this conversation.
    const neighbour = accepted('neighbour'); f.list(); m.reset(); neighbour.list(); exchange(neighbour.id, 'noise', 'noise answer');
    db.exec('CREATE TABLE IF NOT EXISTS preview_unrelated (value INTEGER)'); db.prepare('INSERT INTO preview_unrelated VALUES (?)').run(1);
    other.prepare('UPDATE preview_unrelated SET value = ?').run(2);
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0, 'a write elsewhere in the store keeps this conversation\'s preview');
    const source = db.prepare("SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received' ORDER BY seq LIMIT 1").get(f.id) as { seq: number };
    db.prepare('DELETE FROM events WHERE seq = ?').run(source.seq); m.reset();
    assert.equal(m.count(f.id), 0); f.list(); assert.equal(m.count(f.id), 1, 'a deleted first message is a changed conversation');
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

test('inside a preexisting transaction nothing is reused or stored; the committed value is reused after it', () => {
  const f = accepted('transaction'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    db.exec('BEGIN');
    try {
      m.reset(); assert.equal(f.list()[0]!.preview, 'transaction answer'); assert.equal(m.count(f.id), 1);
      exchange(f.id, 'uncommitted request', 'uncommitted answer'); m.reset();
      assert.equal(f.list()[0]!.preview, 'uncommitted answer'); assert.equal(m.count(f.id), 1);
      m.reset(); f.list(); assert.equal(m.count(f.id), 1, 'transaction values cannot become warm cache hits');
    } finally { db.exec('ROLLBACK'); }
    m.reset(); assert.equal(f.list()[0]!.preview, 'transaction answer');
    assert.equal(m.count(f.id), 0, 'the rolled-back conversation is the one that was cached');
    db.transaction(() => exchange(f.id, 'committed request', 'committed answer'))(); m.reset();
    assert.equal(f.list()[0]!.preview, 'committed answer'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); m.restore(); }
});

test('an unavailable or malformed schema version never authorizes reuse; original reader exceptions still propagate', () => {
  const f = accepted('errors'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list();
    for (const mode of ['throw', 'string', 'negative'] as const) {
      m.schemas(mode); m.reset(); assert.equal(f.list()[0]!.preview, 'errors answer'); f.list();
      assert.equal(m.count(f.id), 2, `schema_version mode ${mode} must never authorize reuse`);
    }
    m.schemas('ok'); f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    exchange(f.id, 'failing request', 'reader failing');
    m.onPublicRead(() => { throw new Error('fixture original projector error'); });
    assert.throws(() => f.list(), /fixture original projector error/, 'cache plumbing cannot catch original projection failures');
    m.onPublicRead(); assert.equal(f.list()[0]!.preview, 'reader failing');
    assert.equal(f.list()[0]!.turnCount, 4);
  } finally { m.restore(); }
});

test('a message landing from another connection during hydration or between polls is never hidden by the stored scalar', () => {
  const f = accepted('race'); const db = log.openEventLog(); const other = new Database(log.HARNESS_DB_PATH);
  const m = instrument(db);
  try {
    let fired = false;
    m.onPublicRead(() => { if (!fired) { fired = true; externalExchange(other, f.id, 'during request', 'after miss commit'); } });
    const hydrated = f.list()[0]!.preview;
    assert.ok(hydrated === 'race answer' || hydrated === 'after miss commit', 'the original read finishes at its own snapshot');
    m.onPublicRead(); assert.equal(fired, true); m.reset();
    assert.equal(f.list()[0]!.preview, 'after miss commit'); assert.equal(m.count(f.id), 1, 'a raced MISS is keyed on the marks it read, so the newer conversation is projected again');
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    externalExchange(other, f.id, 'between request', 'after hit commit'); m.reset();
    assert.equal(f.list()[0]!.preview, 'after hit commit'); assert.equal(m.count(f.id), 1);
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
  } finally { m.restore(); other.close(); }
});

test('empty, legacy and workflow previews reuse like accepted chats; close/reopen uses a new DB identity', () => {
  const f = accepted('empty', { empty: true }); const db = log.openEventLog(); const m = instrument(db);
  try {
    assert.equal(f.list()[0]!.turnCount, 0); assert.equal(f.list()[0]!.preview, ''); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    const legacy = log.createSession({ id: `legacy-${f.id}`, kind: 'chat', channel: 'desktop', metadata: { tags: [`legacy-${f.id}`] } });
    exchange(legacy.id, 'legacy request', 'legacy answer');
    const legacyList = () => buildUnifiedSessionList({ tag: legacy.id }); legacyList(); m.reset(); legacyList(); assert.equal(m.count(legacy.id), 0);
    exchange(legacy.id, 'legacy again', 'legacy changed'); m.reset(); assert.equal(legacyList()[0]!.preview, 'legacy changed'); assert.equal(m.count(legacy.id), 1);
    const workflow = log.createSession({ id: `workflow-${f.id}`, kind: 'workflow', channel: 'workflow', userId: 'owner',
      metadata: { tags: [`workflow-${f.id}`], workflowRunId: `run-${f.id}`, workflowName: 'Fixture flow', stepId: 'only' } });
    exchange(workflow.id, 'workflow request', 'workflow answer');
    const workflowList = () => buildUnifiedSessionList({ tag: workflow.id }); workflowList(); m.reset(); workflowList(); assert.equal(m.count(workflow.id), 0);
    exchange(workflow.id, 'workflow again', 'workflow changed'); m.reset(); assert.equal(workflowList()[0]!.preview, 'workflow changed'); assert.equal(m.count(workflow.id), 1);
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
  } finally { m.restore(); }
  log.closeEventLog(); const replacement = log.openEventLog(); assert.notEqual(replacement, db);
  const reopened = instrument(replacement);
  try { assert.equal(f.list()[0]!.turnCount, 0); assert.equal(reopened.count(f.id), 1); reopened.reset(); f.list(); assert.equal(reopened.count(f.id), 0); }
  finally { reopened.restore(); }
});

test('the oldest 1000 public-event window stays the preview when later events land outside it', () => {
  const f = accepted('bounded-window', { empty: true });
  for (let n = 0; n < 502; n++) exchange(f.id, `window request ${n}`, `window answer ${n}`);
  const db = log.openEventLog(); const m = instrument(db);
  try {
    const first = f.list()[0]!; assert.equal(first.turnCount, 1000); assert.equal(first.preview, 'window answer 499');
    m.reset(); assert.equal(f.list()[0]!.preview, first.preview); assert.equal(m.count(f.id), 0);
    exchange(f.id, 'outside request', 'outside the retained oldest window'); m.reset();
    assert.equal(f.list()[0]!.preview, first.preview); assert.equal(f.list()[0]!.turnCount, 1000);
    assert.equal(m.count(f.id), 1, 'a changed conversation is projected again even when its window is unchanged');
    assert.equal(getUnifiedSessionDetail(`harness:${f.id}`)!.turns.length, 1000);
  } finally { m.restore(); }
});

test('the scalar cache evicts its least recently used entry at 512 rather than retaining an unbounded catalog', () => {
  const fixtures = Array.from({ length: 513 }, (_, n) => accepted(`capacity-${n}`, { empty: true }));
  const db = log.openEventLog(); const m = instrument(db);
  try {
    for (const f of fixtures) f.list();
    const newest = fixtures.at(-1)!; m.reset(); newest.list(); assert.equal(m.count(newest.id), 0);
    const oldest = fixtures[0]!; m.reset(); oldest.list(); assert.equal(m.count(oldest.id), 1, 'the 513th insert evicted the oldest scalar');
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

test('same-connection DDL invalidates even when the conversation itself is unchanged', () => {
  const f = accepted('schema-only'); const db = log.openEventLog(); const m = instrument(db);
  try {
    f.list(); m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    const schemaBefore = db.pragma('schema_version', { simple: true });
    db.exec('CREATE TABLE preview_schema_only (value INTEGER)');
    assert.notEqual(db.pragma('schema_version', { simple: true }), schemaBefore);
    m.reset(); assert.equal(f.list()[0]!.preview, 'schema-only answer');
    assert.equal(m.count(f.id), 1, 'main-schema DDL must force the original public reader');
    m.reset(); f.list(); assert.equal(m.count(f.id), 0);
    db.exec('DROP TABLE preview_schema_only');
    m.reset(); assert.equal(f.list()[0]!.turnCount, 2); assert.equal(m.count(f.id), 1);
  } finally { m.restore(); }
});
