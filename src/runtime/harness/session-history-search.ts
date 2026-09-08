import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, getSession, openEventLog } from './eventlog.js';
import { publicUserInputText } from './public-presentation.js';
import { pullRecentTurnsForSessions, type PriorTurn } from './session-transcript.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from './tool-output-format.js';
import { sameConversationAncestorSessionIds } from './accepted-source-session-branch.js';

const PUBLIC_TYPES = ['user_input_received', 'conversation_completed', 'awaiting_user_input'] as const;
const INDEX_EVENT_BATCH = 128;
const INDEX_SESSION_BATCH = 4;
/**
 * COLD RECALL. A no-cursor search drained the pending queue oldest-first, four
 * sessions per call, with no regard for what was being searched for. Looking up
 * a recent conversation therefore cost one model turn per four unrelated
 * sessions: the measured cold lookup spent five searches advancing an old
 * global index and stopped before the target was ever indexed.
 *
 * Indexing that the READ needs is part of the read. These bound how much of it
 * one search may complete behind the operation: relevant sessions first, and
 * enough of them that an ordinary recall finishes in one call rather than
 * making the model drain a backlog it never asked about.
 */
const INDEX_RELEVANT_SESSION_BATCH = 64;
const INDEX_RELEVANT_PROBE_LIMIT = 512;
/** Bounded sweeps of the event frontier when the search names terms. */
const INDEX_RELEVANT_SCAN_SWEEPS = 24;
const RECEIPT_VERSION = 1;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export class SessionHistorySearchError extends Error {}
function deny(text: string): never { throw new SessionHistorySearchError(text); }

export interface HistorySearchObserver { sessionId: string; sourceUserSeq: number }
interface SourceRow { id: string; seq: number; session_id: string; turn: number; data_json: string; created_at: string }
interface Observer extends HistorySearchObserver { principal: string; source: SourceRow; sourceSha256: string }
interface IndexState { scanned_through_seq: number; generation: number }
interface Projection { turns: PriorTurn[]; digest: string }
interface SearchQuery { query: string; after: string | null; before: string | null; limit: number; includeCurrentConversation: boolean }
export interface PublicHistorySearchSnapshot { text: string; throughSeq: number; turns: number; earlierBeforeSeq: null; beforeSourceSeq?: number }
export interface HistorySearchHit {
  session_id: string; source_user_seq: number; event_seq: number; role: 'user' | 'assistant'; occurred_at: string;
  excerpt: string; excerpt_truncated: boolean;
  through_seq: number; snapshot_sha256: string;
}
interface SearchReceipt {
  version: 1; id: string; observer: HistorySearchObserver; principal: string; sourceSha256: string;
  query: SearchQuery; throughSeq: number; generation: number; hits: HistorySearchHit[];
  nextBeforeEventSeq: number | null;
}
export interface HistorySearchCoverage {
  store: 'harness_chat_public'; observed_through_seq: number; indexed_through_seq: number;
  scanned_through_seq: number; pending_sessions: number; complete: boolean;
}

/** Byte-identical to the existing lossless reader's snapshot protocol. */
export function sessionHistorySnapshotDigest(input: { sessionId: string; throughSeq: number | null; maxTurns?: number; text: string }): string {
  return sha(JSON.stringify({ version: 1, sessionId: input.sessionId, throughSeq: input.throughSeq,
    maxTurns: input.maxTurns ?? null, text: input.text }));
}

function observerFor(input: HistorySearchObserver): Observer {
  if (!input.sessionId || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) deny('An exact accepted requesting source is required.');
  const session = getSession(input.sessionId);
  if (!session || session.kind !== 'chat') deny('History search requires an existing chat conversation.');
  const source = openEventLog().prepare(`SELECT id,seq,session_id,turn,data_json,created_at FROM events
    WHERE seq=? AND session_id=? AND type='user_input_received' AND role='user'`).get(input.sourceUserSeq, input.sessionId) as SourceRow | undefined;
  if (!source) deny('The accepted requesting source is missing.');
  let data: Record<string, unknown>;
  try { data = JSON.parse(source.data_json); } catch { return deny('The accepted requesting source is unreadable.'); }
  if (data.synthetic === true || !publicUserInputText(data)) deny('A public accepted user source is required.');
  if (data.userId != null && data.userId !== (session.userId || session.id)) deny('The accepted source principal contradicts its conversation owner.');
  return { ...input, principal: session.userId || session.id, source,
    sourceSha256: sha(JSON.stringify({ id: source.id, sessionId: source.session_id, seq: source.seq, data: source.data_json })) };
}

function indexState(): IndexState {
  return openEventLog().prepare('SELECT scanned_through_seq,generation FROM session_history_index_state_v1 WHERE singleton=1').get() as IndexState;
}

/** This indexed union reads only a bounded number of event locators from each
 * public type. It never walks tool-result payloads to find the next chat row. */
export const SESSION_HISTORY_INDEX_CURSOR_SQL = PUBLIC_TYPES.map(() => `SELECT * FROM (
  SELECT seq,session_id FROM events INDEXED BY idx_events_type_seq
  WHERE type=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?
)`).join(' UNION ALL ') + ' ORDER BY seq LIMIT ?';

function canonicalProjection(sessionId: string, throughSeq: number): Projection {
  const db = openEventLog();
  const session = getSession(sessionId);
  const principal = session?.userId || sessionId;
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id=? AND seq<=?
    AND type IN ('user_input_received','conversation_completed','awaiting_user_input')`).get(sessionId, throughSeq) as { n: number }).n;
  // The SAME projector as session_history elects owning completions. A raw
  // reply/summary, losing terminal, tool result, or synthetic source is never
  // independently interpreted by the search index.
  const visibleSources = new Set((db.prepare(`SELECT seq,data_json FROM events WHERE session_id=? AND type='user_input_received' AND role='user' AND seq<=?`)
    .all(sessionId, throughSeq) as Array<{ seq: number; data_json: string }>).flatMap(row => {
      try { const data = JSON.parse(row.data_json); return data.synthetic !== true && (data.userId == null || data.userId === principal) && publicUserInputText(data) ? [row.seq] : []; }
      catch { return []; }
    }));
  const turns = pullRecentTurnsForSessions(db, [sessionId], Math.max(1, count), throughSeq, true)
    .filter(turn => turn.identity?.sourceUserSeq && visibleSources.has(turn.identity.sourceUserSeq));
  return { turns, digest: sha(JSON.stringify(turns)) };
}

/** Receipt search and receipt read use ONE public projection. The legacy
 * explicitly named history reader also renders action/prefix compatibility
 * context; that broader representation is not granted by a search receipt. */
function publicHistorySnapshot(sessionId: string, throughSeq: number, projection: Projection, beforeSourceSeq?: number): PublicHistorySearchSnapshot {
  // Opted-in current history obeys the SAME source predicate as hit selection.
  // A completion that arrives late for an earlier source remains legitimate
  // prior work; current/later source exchanges never enter this read snapshot.
  const turns = beforeSourceSeq === undefined ? projection.turns
    : projection.turns.filter(turn => turn.identity!.sourceUserSeq! < beforeSourceSeq);
  const text = turns.length ? `Public conversation for ${sessionId}${beforeSourceSeq === undefined ? '' : ` (sources before ${beforeSourceSeq})`}:\n${turns.map(turn => (
    `[session_id=${sessionId} source_seq=${turn.identity!.sourceUserSeq} event_seq=${turn.identity!.eventSeq} at=${turn.at}]\n${turn.who === 'user' ? 'USER' : 'YOU'}: ${turn.text}`
  )).join('\n\n')}` : '';
  return { text, throughSeq, turns: turns.length, earlierBeforeSeq: null, ...(beforeSourceSeq === undefined ? {} : { beforeSourceSeq }) };
}

/** Bounded locator batches, then at most four affected chat projections. Each
 * affected session reads public event types only; no full global event scan,
 * startup backfill, provider, model, or discarded text budget is involved. */
/**
 * Which QUEUED sessions plausibly contain the terms being searched for.
 *
 * The index cannot answer this — that is the whole problem — so this probes the
 * raw public events directly, scoped to the SAME principal the search is scoped
 * to, and bounded. It decides ORDER only: nothing here widens what the caller
 * may read, and a session it misses is still indexed by the ordinary path.
 */
function relevantPendingSessionIds(
  db: ReturnType<typeof openEventLog>,
  relevance: { principal: string; terms: readonly string[] } | null,
): Set<string> {
  if (!relevance || relevance.terms.length === 0) return new Set();
  try {
    const typePlaceholders = PUBLIC_TYPES.map(() => '?').join(',');
    const termClause = relevance.terms.map(() => 'lower(e.data_json) LIKE ?').join(' OR ');
    const rows = db.prepare(`
      SELECT DISTINCT p.session_id AS session_id
        FROM session_history_index_pending_v1 p
        JOIN sessions s ON s.id = p.session_id
        JOIN events e ON e.session_id = p.session_id
       WHERE s.kind = 'chat'
         AND COALESCE(NULLIF(s.user_id,''), s.id) = ?
         AND e.type IN (${typePlaceholders})
         AND (${termClause})
       LIMIT ?
    `).all(
      relevance.principal,
      ...PUBLIC_TYPES,
      ...relevance.terms.map((term) => `%${term}%`),
      INDEX_RELEVANT_PROBE_LIMIT,
    ) as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  } catch {
    return new Set();   // ordering only; never fail the read
  }
}

/** Terms worth probing for: ordinary words, lowercased, bounded. */
export function historyRelevanceTerms(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(
    query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [],
  )].slice(0, 8);
}

export function advanceSessionHistoryIndex(
  throughSeq: number,
  relevance: { principal: string; terms: readonly string[] } | null = null,
): HistorySearchCoverage {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) deny('Invalid history index boundary.');
  const db = openEventLog();
  return db.transaction(() => {
    const before = indexState();
    if (throughSeq < before.scanned_through_seq) return historySearchCoverage(throughSeq);
    // SCAN FRONTIER. One pass covers at most INDEX_EVENT_BATCH public events, so
    // a relevant conversation sitting past that frontier was never even QUEUED
    // and the model had to spend another turn to reach it. A search that names
    // terms carries the frontier forward until it has covered the observed
    // range or spent its bounded sweep — the work belongs to the read, not to
    // the model's turn budget. With no terms this is exactly one pass, as before.
    const cursor = db.prepare(SESSION_HISTORY_INDEX_CURSOR_SQL);
    const queue = db.prepare(`INSERT INTO session_history_index_pending_v1(session_id,first_seq,through_seq) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`);
    const sweeps = (relevance?.terms.length ?? 0) > 0 ? INDEX_RELEVANT_SCAN_SWEEPS : 1;
    let scannedFrom = before.scanned_through_seq;
    let next = scannedFrom;
    for (let sweep = 0; sweep < sweeps; sweep += 1) {
      const args = PUBLIC_TYPES.flatMap(type => [type, scannedFrom, throughSeq, INDEX_EVENT_BATCH]);
      const changed = cursor.all(...args, INDEX_EVENT_BATCH) as Array<{ seq: number; session_id: string }>;
      for (const row of changed) {
        if (getSession(row.session_id)?.kind === 'chat') queue.run(row.session_id, row.seq, row.seq);
      }
      next = changed.length === INDEX_EVENT_BATCH ? changed.at(-1)!.seq : throughSeq;
      if (next === scannedFrom || next >= throughSeq) { next = changed.length === INDEX_EVENT_BATCH ? next : throughSeq; break; }
      scannedFrom = next;
    }
    db.prepare('UPDATE session_history_index_state_v1 SET scanned_through_seq=? WHERE singleton=1').run(next);
    // Relevant pending sessions are projected FIRST, and more of them, so the
    // answer the caller is actually looking for does not queue behind an
    // unrelated backlog. With no query terms this is exactly the old
    // oldest-first behaviour and the old batch size.
    const relevant = relevantPendingSessionIds(db, relevance);
    const pending = relevant.size > 0
      ? db.prepare(`SELECT session_id,through_seq FROM session_history_index_pending_v1
             ORDER BY (CASE WHEN session_id IN (${[...relevant].map(() => '?').join(',')}) THEN 0 ELSE 1 END),
                      first_seq, session_id
             LIMIT ?`).all(...relevant, INDEX_RELEVANT_SESSION_BATCH) as Array<{ session_id: string; through_seq: number }>
      : db.prepare('SELECT session_id,through_seq FROM session_history_index_pending_v1 ORDER BY first_seq,session_id LIMIT ?')
          .all(INDEX_SESSION_BATCH) as Array<{ session_id: string; through_seq: number }>;
    const insert = db.prepare(`INSERT INTO session_history_documents_v1(event_seq,session_id,source_user_seq,role,occurred_at,content) VALUES(?,?,?,?,?,?)`);
    for (const row of pending) {
      const projection = canonicalProjection(row.session_id, row.through_seq);
      db.prepare('DELETE FROM session_history_documents_v1 WHERE session_id=?').run(row.session_id);
      for (const turn of projection.turns) {
        insert.run(turn.identity!.eventSeq, row.session_id, turn.identity!.sourceUserSeq, turn.who, turn.at, turn.text);
      }
      db.prepare(`INSERT INTO session_history_index_sessions_v1(session_id,through_seq,projection_sha256) VALUES(?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET through_seq=excluded.through_seq,projection_sha256=excluded.projection_sha256`)
        .run(row.session_id, row.through_seq, projection.digest);
      db.prepare('DELETE FROM session_history_index_pending_v1 WHERE session_id=?').run(row.session_id);
    }
    if (next !== before.scanned_through_seq || pending.length) db.prepare('UPDATE session_history_index_state_v1 SET generation=generation+1 WHERE singleton=1').run();
    return historySearchCoverage(throughSeq);
  }).immediate();
}

function historySearchCoverage(throughSeq: number): HistorySearchCoverage {
  const state = indexState();
  const pending = openEventLog().prepare('SELECT COUNT(*) AS n,MIN(first_seq) AS earliest FROM session_history_index_pending_v1').get() as { n: number; earliest: number | null };
  const indexed = Math.min(throughSeq, state.scanned_through_seq, pending.earliest === null ? Number.MAX_SAFE_INTEGER : pending.earliest - 1);
  return { store: 'harness_chat_public', observed_through_seq: throughSeq, indexed_through_seq: indexed,
    scanned_through_seq: Math.min(state.scanned_through_seq, throughSeq), pending_sessions: pending.n,
    complete: indexed === throughSeq };
}

function normalizeQuery(input: { query?: string; after?: string | null; before?: string | null; limit?: number; includeCurrentConversation?: boolean }): SearchQuery {
  const date = (value: string | null | undefined): string | null => {
    if (value == null) return null;
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return deny('Use an ISO time with an explicit timezone.');
    return new Date(value).toISOString();
  };
  const after = date(input.after), before = date(input.before);
  if (after && before && after >= before) deny('The history window must end after it starts.');
  const limit = input.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) deny('Search page size must be between 1 and 20.');
  const query = (input.query ?? '').trim();
  if (query.length > 2_000) deny('The search query is too long.');
  if (input.includeCurrentConversation !== undefined && typeof input.includeCurrentConversation !== 'boolean') deny('Current-conversation inclusion must be an explicit boolean.');
  return { query, after, before, limit, includeCurrentConversation: input.includeCurrentConversation ?? false };
}

/** Treat query text as data, never as FTS operators. All lexical terms must
 * match; an empty query is an explicit recent/time-window listing. */
function ftsQuery(query: string): string {
  return [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function loadReceipt(id: string, observer: Observer): SearchReceipt {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM session_history_search_receipts_v1 WHERE receipt_id=?').get(id) as {
    session_id: string; source_user_seq: number; receipt_json: string; receipt_sha256: string; receipt_event_id: string;
  } | undefined;
  if (!row || row.session_id !== observer.sessionId || row.source_user_seq !== observer.sourceUserSeq || sha(row.receipt_json) !== row.receipt_sha256) deny('History lookup receipt is missing, stale, or belongs to another accepted source.');
  const mirror = db.prepare(`SELECT session_id,parent_event_id,data_json FROM events WHERE id=? AND type='session_history_search_recorded' AND role='host'`).get(row.receipt_event_id) as {
    session_id: string; parent_event_id: string | null; data_json: string;
  } | undefined;
  let receipt: SearchReceipt;
  try {
    receipt = JSON.parse(row.receipt_json) as SearchReceipt;
    const data = mirror ? JSON.parse(mirror.data_json) : null;
    if (!mirror || mirror.session_id !== observer.sessionId || mirror.parent_event_id !== observer.source.id
      || data.receiptJson !== row.receipt_json || data.receiptSha256 !== row.receipt_sha256) deny('History receipt and its durable source mirror differ.');
  } catch { return deny('History lookup receipt is unreadable or invalid.'); }
  if (receipt.version !== RECEIPT_VERSION || receipt.id !== id || receipt.principal !== observer.principal
    || receipt.observer.sessionId !== observer.sessionId || receipt.observer.sourceUserSeq !== observer.sourceUserSeq
    || receipt.sourceSha256 !== observer.sourceSha256) deny('History lookup source or principal changed.');
  return receipt;
}

export function searchSessionHistory(input: HistorySearchObserver & {
  query?: string; after?: string | null; before?: string | null; limit?: number; cursor?: string | null; includeCurrentConversation?: boolean;
}): { version: 1; search_receipt_id: string; hits: HistorySearchHit[]; next_cursor: string | null; coverage: HistorySearchCoverage; order: 'newest_event_first' } {
  const db = openEventLog();
  return db.transaction(() => {
    const observer = observerFor(input);
    const query = normalizeQuery(input);
    const prior = input.cursor ? loadReceipt(input.cursor, observer) : null;
    if (prior && JSON.stringify(prior.query) !== JSON.stringify(query)) deny('Repeat the exact query and time window for this search cursor.');
    if (prior && prior.nextBeforeEventSeq === null) deny('This search page is already complete.');
    // A no-cursor call deliberately starts a new observation snapshot, while
    // retaining the SAME accepted-source/principal authority. This lets a
    // model recover from an expired index cursor without asking the user to
    // send a new message. A prior receipt remains bound to its old snapshot.
    const throughSeq = prior?.throughSeq
      ?? (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq;
    const coverage = prior
      ? historySearchCoverage(throughSeq)
      : advanceSessionHistoryIndex(throughSeq, {
          principal: observer.principal,
          terms: historyRelevanceTerms(query.query),
        });
    const state = indexState();
    if (prior && prior.generation !== state.generation) deny('The search index changed; restart the search without a cursor. Existing exact history receipts remain readable.');
    const lexical = ftsQuery(query.query);
    if (query.query && !lexical) deny('Use searchable words or an empty query for a time-window listing.');
    const clauses = ["s.kind='chat'", "COALESCE(NULLIF(s.user_id,''),s.id)=?", 'd.event_seq<=?'];
    const args: unknown[] = [observer.principal, throughSeq];
    // Never let this request (or a later source in its conversation) answer
    // its own history lookup, even when current-conversation history is opted in.
    clauses.push('NOT (d.session_id=? AND d.source_user_seq>=?)');
    args.push(observer.sessionId, observer.sourceUserSeq);
    if (!query.includeCurrentConversation) {
      const currentConversation = [observer.sessionId, ...sameConversationAncestorSessionIds({ sessionId: observer.sessionId, principalId: observer.principal })];
      clauses.push(`d.session_id NOT IN (${currentConversation.map(() => '?').join(',')})`);
      args.push(...currentConversation);
    }
    if (prior) { clauses.push('d.event_seq<?'); args.push(prior.nextBeforeEventSeq); }
    if (query.after) { clauses.push('d.occurred_at>=?'); args.push(query.after); }
    if (query.before) { clauses.push('d.occurred_at<?'); args.push(query.before); }
    if (lexical) { clauses.push('session_history_documents_fts_v1 MATCH ?'); args.push(lexical); }
    const candidates = db.prepare(`SELECT d.*,p.through_seq,p.projection_sha256 FROM session_history_documents_v1 d
      JOIN sessions s ON s.id=d.session_id JOIN session_history_index_sessions_v1 p ON p.session_id=d.session_id
      ${lexical ? 'JOIN session_history_documents_fts_v1 ON session_history_documents_fts_v1.rowid=d.event_seq' : ''}
      WHERE ${clauses.join(' AND ')} ORDER BY d.event_seq DESC LIMIT ?`).all(...args, query.limit + 1) as Array<{
        event_seq: number; session_id: string; source_user_seq: number; role: 'user' | 'assistant'; occurred_at: string;
        content: string; through_seq: number; projection_sha256: string;
      }>;
    const hits: HistorySearchHit[] = [];
    const snapshots = new Map<string, { throughSeq: number; digest: string; projection: Projection }>();
    for (const row of candidates.slice(0, query.limit)) {
      let snapshot = snapshots.get(row.session_id);
      if (!snapshot) {
        // Re-read current canonical bytes before issuing access: the index is
        // only a locator, never an authority for private/raw or modified text.
        const boundary = Math.min(throughSeq, row.through_seq);
        const projection = canonicalProjection(row.session_id, boundary);
        if (boundary === row.through_seq && projection.digest !== row.projection_sha256) deny('The retained public transcript changed; its search projection needs rebuilding.');
        const history = publicHistorySnapshot(row.session_id, boundary, projection,
          row.session_id === observer.sessionId ? observer.sourceUserSeq : undefined);
        snapshot = { throughSeq: boundary, digest: sessionHistorySnapshotDigest({ sessionId: row.session_id, ...history }), projection };
        snapshots.set(row.session_id, snapshot);
      }
      const canonical = snapshot.projection.turns.find(turn => turn.identity?.eventSeq === row.event_seq
        && turn.identity.sourceUserSeq === row.source_user_seq && turn.who === row.role && turn.text === row.content);
      if (!canonical) deny('The history search candidate does not match its canonical public source.');
      const hit: HistorySearchHit = { session_id: row.session_id, source_user_seq: row.source_user_seq, event_seq: row.event_seq, role: row.role,
        occurred_at: row.occurred_at, excerpt: row.content.slice(0, 600), excerpt_truncated: row.content.length > 600,
        through_seq: snapshot.throughSeq, snapshot_sha256: snapshot.digest };
      if (JSON.stringify([...hits, hit]).length > DEFAULT_TOOL_RESULT_MAX_CHARS - 4_096) {
        if (hits.length === 0) deny('The history locator exceeds the result transport page budget.');
        break;
      }
      hits.push(hit);
    }
    const id = `history-search-${randomUUID()}`;
    const receipt: SearchReceipt = { version: 1, id, observer: { sessionId: observer.sessionId, sourceUserSeq: observer.sourceUserSeq },
      principal: observer.principal, sourceSha256: observer.sourceSha256, query, throughSeq, generation: state.generation, hits,
      nextBeforeEventSeq: candidates.length > hits.length ? hits.at(-1)!.event_seq : null };
    const bytes = JSON.stringify(receipt), digest = sha(bytes);
    const event = appendEvent({ sessionId: observer.sessionId, turn: observer.source.turn, role: 'host',
      type: 'session_history_search_recorded', parentEventId: observer.source.id, data: { receiptJson: bytes, receiptSha256: digest } });
    db.prepare(`INSERT INTO session_history_search_receipts_v1(receipt_id,session_id,source_user_seq,receipt_json,receipt_sha256,receipt_event_id) VALUES(?,?,?,?,?,?)`)
      .run(id, observer.sessionId, observer.sourceUserSeq, bytes, digest, event.id);
    return { version: 1 as const, search_receipt_id: id, hits, next_cursor: receipt.nextBeforeEventSeq === null ? null : id, coverage, order: 'newest_event_first' as const };
  }).immediate();
}

/** Receipts grant only this current source a READ of an exact same-principal
 * public snapshot. They are reusable for lossless pages, never later sources,
 * another principal, task continuation, provider selection, or effects. */
export function redeemSessionHistorySearch(input: HistorySearchObserver & {
  receiptId: string; targetSessionId: string; throughSeq?: number; snapshotSha256?: string; maxTurns?: number;
}): { throughSeq: number; snapshotSha256: string; history: PublicHistorySearchSnapshot } {
  const observer = observerFor(input);
  const receipt = loadReceipt(input.receiptId, observer);
  const target = getSession(input.targetSessionId);
  if (!target || (target.userId || target.id) !== observer.principal) deny('The target history belongs to another principal.');
  const hit = receipt.hits.find(candidate => candidate.session_id === input.targetSessionId
    && (input.throughSeq === undefined || candidate.through_seq === input.throughSeq)
    && (input.snapshotSha256 === undefined || candidate.snapshot_sha256 === input.snapshotSha256));
  if (!hit || input.maxTurns !== undefined) deny('The requested history snapshot was not returned by this exact search.');
  const history = publicHistorySnapshot(input.targetSessionId, hit.through_seq, canonicalProjection(input.targetSessionId, hit.through_seq),
    input.targetSessionId === observer.sessionId ? observer.sourceUserSeq : undefined);
  if (sessionHistorySnapshotDigest({ sessionId: input.targetSessionId, ...history }) !== hit.snapshot_sha256) deny('The retained history snapshot changed; search again before reading.');
  return { throughSeq: hit.through_seq, snapshotSha256: hit.snapshot_sha256, history };
}
