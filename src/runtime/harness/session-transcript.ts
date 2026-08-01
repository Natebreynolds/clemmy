/**
 * session-transcript — a neutral, event-log-backed reader for a session's recent
 * conversation turns, shared by the Discord cross-session prefix and the Claude
 * brain's within-session history injection. Lives in runtime/harness (a low-level
 * module) so claude-agent-brain.ts can import it without a cycle through the
 * channel layer (discord-harness.ts). The Claude brain writes both
 * user_input_received and conversation_completed to the event log, so this returns
 * the brain's own prior turns with no schema change.
 */
import { SessionStore } from '../../memory/session-store.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import {
  getSession as getHarnessSession,
  listSessions as listHarnessSessions,
  openEventLog,
  type EventRow,
  type SessionRow,
} from './eventlog.js';
import { resolveWriteEvidence } from './work-report.js';
import {
  publicCompletionText,
  publicReplyText,
  publicUserInputText,
  validTypedCompletionPresentation,
} from './public-presentation.js';

export interface PriorTurn { who: 'user' | 'assistant'; text: string; at: string }

/**
 * Render the IRREVERSIBLE external actions that already SUCCEEDED in this session,
 * so a brain returning to an existing chat KNOWS what it already did. The text
 * transcript (user_input/conversation_completed) does NOT include tool results, so
 * without this the brain is blind to its own completed sends — the 2026-06-29
 * double-send (it re-ran a send because the prior turn's text didn't record it,
 * and an errored turn emits no conversation_completed at all). Legacy write rows
 * retain their historical success meaning; new pre-dispatch reservations are
 * complete only after the exact call succeeds. Failed rows prove no dispatch and
 * orphaned/unsettled rows render separately as uncertain. Dedupe is by
 * (shape, target), newest first. '' when there is no write evidence.
 */
interface RawActionRow { seq: number; type: string; data_json: string }
interface RawTranscriptRow {
  seq: number;
  session_id: string;
  type: string;
  data_json: string;
  created_at: string;
  turn: number;
}

function uniqueSessionIds(sessionIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of sessionIds) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Inclusive global event-log cursor used to freeze a session-history view at
 * a handoff boundary. Event `seq` is global across harness sessions, so the
 * same cursor safely bounds workflow sibling sessions as well. */
function normalizeThroughSeq(throughSeq?: number): number | undefined {
  if (throughSeq === undefined) return undefined;
  if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) {
    throw new Error('throughSeq must be a positive safe event sequence');
  }
  return throughSeq;
}

function readRecentActionRowsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit: number,
  throughSeq?: number,
): RawActionRow[] {
  const rowLimit = Math.max(1, Math.trunc(limit));
  const boundedThroughSeq = normalizeThroughSeq(throughSeq);
  return db.prepare(
    `SELECT seq, type, data_json FROM events
       WHERE session_id = ?
         AND type IN (
           'external_write',
           'external_write_succeeded',
           'external_write_failed',
           'external_write_orphaned'
         )
         ${boundedThroughSeq === undefined ? '' : 'AND seq <= ?'}
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(...(boundedThroughSeq === undefined
    ? [sessionId, rowLimit]
    : [sessionId, boundedThroughSeq, rowLimit])) as RawActionRow[];
}

function renderRecentActionsForSessions(
  db: ReturnType<typeof openEventLog>,
  sessionIds: string[],
  limit = 20,
  scopeLabel = 'THIS conversation',
  throughSeq?: number,
): string {
  let rows: RawActionRow[];
  try {
    const rowLimit = Math.max(limit * 4, limit);
    rows = uniqueSessionIds(sessionIds)
      .flatMap((sessionId) => readRecentActionRowsForSession(db, sessionId, rowLimit, throughSeq))
      .sort((left, right) => right.seq - left.seq)
      .slice(0, rowLimit);
  } catch { return ''; }
  if (rows.length === 0) return '';

  const evidence: EventRow[] = [];
  for (const row of rows) {
    try {
      evidence.push({
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
      } as EventRow);
    } catch { /* skip malformed rows */ }
  }
  const resolved = resolveWriteEvidence(evidence);
  const renderLines = (events: EventRow[]): string[] => {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
      const d = event.data as { shapeKey?: string; toolName?: string; targets?: string[] };
      const shape = String(d.shapeKey ?? d.toolName ?? 'action');
      const targets = (d.targets ?? [])
        .filter((target): target is string => typeof target === 'string' && target.trim().length > 0);
      for (const target of (targets.length ? targets : ['(no target)'])) {
        const t = target.trim();
        const key = `${shape}::${t.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${shape} → ${t}`);
        if (lines.length >= limit) break;
      }
      if (lines.length >= limit) break;
    }
    return lines;
  };
  const confirmedLines = renderLines(resolved.confirmed);
  const uncertainLines = renderLines(resolved.uncertain);
  if (confirmedLines.length === 0 && uncertainLines.length === 0) return '';

  const scopeBody = scopeLabel === 'THIS conversation' ? 'this same session' : scopeLabel.toLowerCase();
  const blocks: string[] = [];
  if (confirmedLines.length > 0) {
    blocks.push([
      `ALREADY DONE in ${scopeLabel} — these external actions SUCCEEDED earlier in ${scopeBody}. Do NOT repeat any of them unless the user EXPLICITLY asks you to do it AGAIN. A prior turn that errored AFTER one of these still COUNTS as done — it was NOT cancelled:`,
      ...confirmedLines,
    ].join('\n'));
  }
  if (uncertainLines.length > 0) {
    blocks.push([
      `OUTCOME UNCERTAIN in ${scopeLabel} — these external actions were reserved or crossed a provider boundary, but completion was NOT confirmed. Do NOT repeat them blindly; verify the destination first:`,
      ...uncertainLines,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

export function renderRecentSessionActions(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 20,
  throughSeq?: number,
): string {
  return renderRecentActionsForSessions(db, [sessionId], limit, 'THIS conversation', throughSeq);
}

export function renderRecentActionsForHarnessHistory(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 20,
  throughSeq?: number,
): string {
  let row: SessionRow | null = null;
  try { row = getHarnessSession(sessionId); } catch { row = null; }
  if (!row) return renderRecentActionsForSessions(db, [sessionId], limit, 'THIS conversation', throughSeq);
  const relatedRows = relatedHarnessRowsForHistory(row);
  const workflowRunId = workflowRunIdFor(row);
  const isWorkflowAggregate = workflowRunId && relatedRows.length > 1;
  return renderRecentActionsForSessions(
    db,
    relatedRows.map((related) => related.id),
    limit,
    isWorkflowAggregate ? 'THIS workflow run' : 'THIS conversation',
    throughSeq,
  );
}

function readRecentTranscriptRowsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  maxTurns: number,
  throughSeq?: number,
): RawTranscriptRow[] {
  // Logical turns can contain an accepted source, an awaiting edge, a typed
  // terminal, and (on an upgraded database) one or more losing historical
  // terminals. Read bounded headroom so those audit rows do not crowd the
  // owning source out of a small transcript window.
  const rowLimit = Math.max(12, Math.trunc(maxTurns) * 6);
  const boundedThroughSeq = normalizeThroughSeq(throughSeq);
  return db.prepare(
    `SELECT seq, session_id, type, data_json, created_at, turn FROM events
       WHERE session_id = ?
         AND type IN ('user_input_received', 'conversation_completed', 'awaiting_user_input')
         ${boundedThroughSeq === undefined ? '' : 'AND seq <= ?'}
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(...(boundedThroughSeq === undefined
    ? [sessionId, rowLimit]
    : [sessionId, boundedThroughSeq, rowLimit])) as RawTranscriptRow[];
}

/**
 * Passive async outcomes are durable execution context, but they are not human
 * user turns. Keep them out of the conversational transcript while still
 * making them available to a brain after reopen or provider switch. Directives
 * used to trigger a proactive relay are intentionally excluded: replaying
 * those would re-issue control flow instead of restoring facts.
 */
function renderPassiveOutcomeContextForSessions(
  db: ReturnType<typeof openEventLog>,
  sessionIds: string[],
  maxOutcomes = 8,
  throughSeq?: number,
): string {
  const boundedThroughSeq = normalizeThroughSeq(throughSeq);
  const rows = uniqueSessionIds(sessionIds)
    .flatMap((sessionId) => db.prepare(
      `SELECT seq, session_id, type, data_json, created_at, turn FROM events
         WHERE session_id = ?
           AND type = 'user_input_received'
           ${boundedThroughSeq === undefined ? '' : 'AND seq <= ?'}
         ORDER BY seq DESC
         LIMIT ?`,
    ).all(...(boundedThroughSeq === undefined
      ? [sessionId, Math.max(16, maxOutcomes * 8)]
      : [sessionId, boundedThroughSeq, Math.max(16, maxOutcomes * 8)])) as RawTranscriptRow[])
    .sort((left, right) => right.seq - left.seq);

  const seen = new Set<string>();
  const outcomes: Array<{ seq: number; text: string }> = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      if (data.synthetic !== true || data.source !== 'outcome' || data.deliveryPhase !== 'passive') continue;
      const outcomeText = typeof data.text === 'string' ? data.text.trim() : '';
      if (!outcomeText) continue;
      const sourceKey = `${String(data.sourceLabel ?? '')}:${String(data.sourceId ?? '')}:${String(data.status ?? '')}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      outcomes.push({ seq: row.seq, text: outcomeText.slice(0, 2_000) });
      if (outcomes.length >= maxOutcomes) break;
    } catch { /* malformed private context never blocks transcript replay */ }
  }
  if (outcomes.length === 0) return '';
  outcomes.sort((left, right) => left.seq - right.seq);
  return [
    'Durable async outcomes (runtime context; not user-authored):',
    ...outcomes.map((outcome) => outcome.text),
  ].join('\n\n');
}

/** Read the recent user+assistant turns for ONE session, chronological order. */
export function pullRecentTurnsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  maxTurns: number,
  throughSeq?: number,
): PriorTurn[] {
  return pullRecentTurnsForSessions(db, [sessionId], maxTurns, throughSeq);
}

/** Read recent user+assistant turns across related sessions, chronological order. */
export function pullRecentTurnsForSessions(
  db: ReturnType<typeof openEventLog>,
  sessionIds: string[],
  maxTurns: number,
  throughSeq?: number,
): PriorTurn[] {
  const turnLimit = Math.max(1, Math.trunc(maxTurns));
  const rows = uniqueSessionIds(sessionIds)
    .flatMap((sessionId) => readRecentTranscriptRowsForSession(db, sessionId, turnLimit, throughSeq))
    .sort((left, right) => left.seq - right.seq);

  type ParsedRow = RawTranscriptRow & { data: Record<string, unknown> };
  type SourceRecord = {
    key: string;
    row: ParsedRow;
    userText: string;
  };
  type AssistantTurn = { seq: number; text: string; at: string };
  type TranscriptUnit = { order: number; turns: PriorTurn[] };

  const parsed: ParsedRow[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      parsed.push({ ...row, data: data as Record<string, unknown> });
    } catch { /* malformed private rows never block model history */ }
  }

  const sourceKey = (sessionId: string, seq: number): string => `${sessionId}:${seq}`;
  const positiveSeq = (value: unknown): number | null => (
    Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
  );
  const claimsTyped = (data: Record<string, unknown>): boolean => (
    Object.prototype.hasOwnProperty.call(data, 'presentation')
      || Object.prototype.hasOwnProperty.call(data, 'turnOutcome')
  );

  // Index every accepted source, including hidden synthetic control edges. A
  // synthetic source still owns its terminal; it simply does not render as a
  // human-authored USER line.
  const sources = new Map<string, SourceRecord>();
  for (const row of parsed) {
    if (row.type !== 'user_input_received') continue;
    const key = sourceKey(row.session_id, row.seq);
    sources.set(key, {
      key,
      row,
      userText: row.data.synthetic === true ? '' : publicUserInputText(row.data),
    });
  }

  // Elect the first valid terminal for each exact accepted source. A late
  // completion for A is attached to A's unit even when B was accepted and
  // completed first; losing rolling-upgrade rows remain in SQLite but never
  // become extra YOU turns.
  const assistantBySource = new Map<string, AssistantTurn>();
  const typedTurnKeys = new Set<string>();
  for (const row of parsed) {
    if (row.type !== 'conversation_completed') continue;
    const presentation = validTypedCompletionPresentation(row.data, row.session_id);
    if (!presentation) continue;
    const key = sourceKey(row.session_id, presentation.identity.sourceUserSeq);
    if (!sources.has(key)) continue; // exact source fell outside/corrupts this bounded view
    typedTurnKeys.add(`${row.session_id}:${presentation.identity.turn}`);
    const prior = assistantBySource.get(key);
    if (!prior || row.seq < prior.seq) {
      assistantBySource.set(key, {
        seq: row.seq,
        text: presentation.text,
        at: row.created_at,
      });
    }
  }

  const orphanAssistants: TranscriptUnit[] = [];
  const legacyCompletionTextsByTurn = new Map<string, Set<string>>();
  const exactOrUniqueLegacySource = (row: ParsedRow): SourceRecord | null => {
    const exactSeq = positiveSeq(row.data.sourceUserSeq);
    if (exactSeq !== null) {
      return sources.get(sourceKey(row.session_id, exactSeq)) ?? null;
    }
    const candidates = [...sources.values()].filter((source) => (
      source.row.session_id === row.session_id
      && source.row.turn === row.turn
      && source.row.seq < row.seq
      && !assistantBySource.has(source.key)
    ));
    return candidates.length === 1 ? candidates[0] : null;
  };

  // Legacy completions remain readable, but only a unique/exact association
  // may turn them into a pair. Partial typed rows fail closed and never fall
  // through to the legacy reply adapter.
  for (const row of parsed) {
    if (row.type !== 'conversation_completed' || claimsTyped(row.data)) continue;
    const completion = publicCompletionText(row.data, '');
    if (!completion) continue;
    const claimedSourceSeq = positiveSeq(row.data.sourceUserSeq);
    if (claimedSourceSeq !== null
      && assistantBySource.has(sourceKey(row.session_id, claimedSourceSeq))) {
      // A legacy-shaped retry can carry the exact source at top level during a
      // rolling upgrade. It cannot replace the already validated typed winner.
      continue;
    }
    const legacyTurnKey = `${row.session_id}:${row.turn}`;
    const legacyTexts = legacyCompletionTextsByTurn.get(legacyTurnKey) ?? new Set<string>();
    legacyTexts.add(normalizeTranscriptText(completion));
    legacyCompletionTextsByTurn.set(legacyTurnKey, legacyTexts);
    const source = exactOrUniqueLegacySource(row);
    if (source) {
      assistantBySource.set(source.key, {
        seq: row.seq,
        text: completion,
        at: row.created_at,
      });
    } else {
      orphanAssistants.push({
        order: row.seq,
        turns: [{ who: 'assistant', text: completion, at: row.created_at }],
      });
    }
  }

  // Awaiting rows are compatibility context, not a second public terminal.
  // Prefer an explicit source. Numeric-turn inference is allowed only when no
  // typed terminal owns that reused turn; otherwise retaining an extra question
  // is safer than hiding A's question because B happened to use the same number.
  for (const row of parsed) {
    if (row.type !== 'awaiting_user_input') continue;
    const question = publicReplyText(row.data.question, '');
    if (!question) continue;
    const exactSeq = positiveSeq(row.data.sourceUserSeq);
    const turnKey = `${row.session_id}:${row.turn}`;
    if (exactSeq === null
      && !typedTurnKeys.has(turnKey)
      && legacyCompletionTextsByTurn.get(turnKey)?.has(normalizeTranscriptText(question))) {
      continue;
    }
    let source = exactSeq === null
      ? null
      : sources.get(sourceKey(row.session_id, exactSeq)) ?? null;
    if (!source && exactSeq === null && !typedTurnKeys.has(turnKey)) {
      source = exactOrUniqueLegacySource(row);
    }
    if (source) {
      const completion = assistantBySource.get(source.key);
      if (completion) {
        // The terminal is authoritative for this exact source. Identical SDK
        // question rows are the common case; a stale differing edge is also not
        // allowed to become a second assistant answer.
        continue;
      }
      assistantBySource.set(source.key, {
        seq: row.seq,
        text: question,
        at: row.created_at,
      });
      continue;
    }
    orphanAssistants.push({
      order: row.seq,
      turns: [{ who: 'assistant', text: question, at: row.created_at }],
    });
  }

  const settled: TranscriptUnit[] = [...orphanAssistants];
  const unpaired: TranscriptUnit[] = [];
  for (const source of sources.values()) {
    const assistant = assistantBySource.get(source.key);
    const userTurn = source.userText
      ? [{ who: 'user' as const, text: source.userText, at: source.row.created_at }]
      : [];
    if (assistant) {
      settled.push({
        order: source.row.seq,
        turns: [
          ...userTurn,
          { who: 'assistant', text: assistant.text, at: assistant.at },
        ],
      });
    } else if (userTurn.length > 0) {
      // An accepted source with no terminal is the active edge. Put it after
      // every settled pair so the next model never sees USER A, USER B, YOU B.
      unpaired.push({ order: source.row.seq, turns: userTurn });
    }
  }

  settled.sort((left, right) => left.order - right.order);
  unpaired.sort((left, right) => left.order - right.order);
  const units = [...settled, ...unpaired].slice(-turnLimit);
  return units.flatMap((unit) => unit.turns);
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

const TURN_TRIM = 800;
// Cross-session continuation prefixes ride into EVERY turn's context on the
// Claude SDK lane — bound them (they were the last unbounded context input).
const CROSS_SESSION_PREFIX_MAX_CHARS = 2000;
const CROSS_SESSION_PREFIXES_TOTAL_MAX_CHARS = 6000;
const ASYNC_OUTCOME_REPORT_BACK_RE = /^\[(?:background task|workflow run) [^\]\n]+ (?:completed|failed|blocked|needs input|needs attention)\]/i;

/** Render prior turns as USER:/YOU: lines (per-turn 800-char trim). The caller
 *  adds any header. Used by both the cross-session prefix and the brain history. */
export function renderTranscriptTurns(turns: Array<{ who: 'user' | 'assistant'; text: string }>): string {
  return turns
    .map((t) => {
      const label = t.who === 'user' ? 'USER' : 'YOU';
      // ROOT-CAUSE guard (2026-07-01): NEVER replay a prior ASSISTANT turn that is shaped like a
      // printed tool call (`{"tool_call":…}`, `[Tool: X]`, `Tool call: …`). If narration ever
      // slipped into a stored reply, echoing it here as a `YOU:` exemplar teaches the model to
      // mimic the format — the self-reinforcing loop. Neutralize it (both this within-session
      // path and the cross-session prefix go through here, so ONE filter covers every replay).
      const safeText = t.who === 'assistant' && looksLikeToolCallShape(t.text)
        ? '(took a tool action)'
        : t.text;
      const trimmed = safeText.length > TURN_TRIM ? `${safeText.slice(0, TURN_TRIM)}…` : safeText;
      return `  ${label}: ${trimmed}`;
    })
    .join('\n');
}

function clipHistory(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 30))}\n...[session history truncated]`;
}

export function isPureAsyncOutcomeLegacyGhost(record: ReturnType<SessionStore['get']>): boolean {
  const turns = record.turns.filter((turn) => typeof turn.text === 'string' && turn.text.trim().length > 0);
  return turns.length > 0
    && turns.every((turn) => turn.role === 'user' && ASYNC_OUTCOME_REPORT_BACK_RE.test(turn.text.trim()));
}

export function renderCrossSessionPrefixesForModel(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 4,
  throughSeq?: number,
): string {
  const boundedThroughSeq = normalizeThroughSeq(throughSeq);
  let sessionIds = [sessionId];
  try {
    const row = getHarnessSession(sessionId);
    if (row) sessionIds = relatedHarnessRowsForHistory(row).map((related) => related.id);
  } catch {
    sessionIds = [sessionId];
  }
  try {
    const rowLimit = Math.max(1, limit);
    const rows = uniqueSessionIds(sessionIds)
      .flatMap((id) => db.prepare(
        `SELECT seq, data_json FROM events
         WHERE session_id = ?
           AND type = 'cross_session_prefix'
           ${boundedThroughSeq === undefined ? '' : 'AND seq <= ?'}
         ORDER BY seq ASC
         LIMIT ?`,
      ).all(...(boundedThroughSeq === undefined
        ? [id, rowLimit]
        : [id, boundedThroughSeq, rowLimit])) as Array<{ seq: number; data_json: string }>)
      .sort((left, right) => left.seq - right.seq)
      .slice(-rowLimit);
    const texts = rows.map((row) => {
      try {
        const data = JSON.parse(row.data_json) as { text?: unknown };
        // Per-prefix bound: a single runaway continuation blob must not blow
        // the turn context (these texts were previously unbounded).
        return typeof data.text === 'string' ? clipHistory(data.text.trim(), CROSS_SESSION_PREFIX_MAX_CHARS) : '';
      } catch {
        return '';
      }
    }).filter(Boolean);
    // Total bound keeps the NEWEST prefixes: rows are seq-ascending, and the
    // latest prefix carries the CURRENT resume's handoff context — drop the
    // oldest whole prefixes first, never the tail of the newest (review
    // finding: a head-keeping clip lost exactly the context that matters).
    const kept: string[] = [];
    let budget = CROSS_SESSION_PREFIXES_TOTAL_MAX_CHARS;
    for (let i = texts.length - 1; i >= 0; i--) {
      const cost = texts[i].length + (kept.length > 0 ? 2 : 0);
      if (cost > budget) {
        if (kept.length === 0) kept.unshift(clipHistory(texts[i], budget));
        else kept.unshift('[older session prefixes omitted]');
        break;
      }
      kept.unshift(texts[i]);
      budget -= cost;
    }
    return kept.join('\n\n');
  } catch {
    return '';
  }
}

const RELATED_SESSION_PAGE_SIZE = 500;
const RELATED_HISTORY_SESSION_LIMIT = 80;

function workflowRunIdFor(row: SessionRow): string {
  return typeof row.metadata?.workflowRunId === 'string' ? row.metadata.workflowRunId : '';
}

function relatedHarnessRowsForHistory(row: SessionRow): SessionRow[] {
  const workflowRunId = workflowRunIdFor(row);
  if (!workflowRunId) return [row];
  try {
    const rows: SessionRow[] = [];
    for (let offset = 0; ; offset += RELATED_SESSION_PAGE_SIZE) {
      const page = listHarnessSessions({ limit: RELATED_SESSION_PAGE_SIZE, offset, status: 'any' });
      rows.push(...page.filter((candidate) => workflowRunIdFor(candidate) === workflowRunId));
      if (page.length < RELATED_SESSION_PAGE_SIZE) break;
    }
    if (rows.length === 0) return [row];
    rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return rows.slice(-RELATED_HISTORY_SESSION_LIMIT);
  } catch {
    return [row];
  }
}

export function pullRecentTurnsForHarnessHistory(
  sessionId: string,
  maxTurns = 20,
  throughSeq?: number,
): PriorTurn[] {
  const row = getHarnessSession(sessionId);
  if (!row) return [];
  const relatedSessionIds = relatedHarnessRowsForHistory(row).map((session) => session.id);
  return pullRecentTurnsForSessions(openEventLog(), relatedSessionIds, maxTurns, throughSeq);
}

/**
 * Render a model-facing session history block that is stable across storage
 * backends. Harness sessions are canonical when present, so same-raw-id legacy
 * SessionStore ghosts cannot shadow the real transcript. Legacy sessions still
 * fall back to SessionStore. The harness path includes the external_write ledger
 * so a switched model/background worker sees irreversible actions that already
 * succeeded and does not repeat them.
 */
export function renderSessionHistoryForModel(
  sessionId: string,
  maxTurns = 12,
  maxChars = 12_000,
  throughSeq?: number,
): string {
  const boundedThroughSeq = normalizeThroughSeq(throughSeq);
  let harnessRow: SessionRow | null = null;
  try { harnessRow = getHarnessSession(sessionId); } catch { harnessRow = null; }

  if (harnessRow) {
    try {
      const db = openEventLog();
      const relatedRows = relatedHarnessRowsForHistory(harnessRow);
      const relatedSessionIds = relatedRows.map((row) => row.id);
      const workflowRunId = workflowRunIdFor(harnessRow);
      const isWorkflowAggregate = workflowRunId && relatedRows.length > 1;
      const prefix = renderCrossSessionPrefixesForModel(db, sessionId, 4, boundedThroughSeq);
      const actions = renderRecentActionsForSessions(
        db,
        relatedSessionIds,
        20,
        isWorkflowAggregate ? 'THIS workflow run' : 'THIS conversation',
        boundedThroughSeq,
      );
      const asyncOutcomes = renderPassiveOutcomeContextForSessions(
        db,
        relatedSessionIds,
        8,
        boundedThroughSeq,
      );
      const turns = pullRecentTurnsForSessions(db, relatedSessionIds, maxTurns, boundedThroughSeq);
      const transcriptTitle = isWorkflowAggregate
        ? `Recent transcript for workflow run ${workflowRunId} (including ${relatedRows.length} step sessions):`
        : `Recent transcript for ${sessionId}:`;
      const parts = [
        prefix,
        actions,
        asyncOutcomes,
        turns.length > 0
          ? `${transcriptTitle}\n${renderTranscriptTurns(turns)}`
          : '',
      ].filter(Boolean);
      if (parts.length > 0) return clipHistory(parts.join('\n\n'), maxChars);
    } catch {
      // Fall through to legacy store if the harness read is unavailable.
    }
  }

  // A harness event cursor has no meaning in the legacy SessionStore. Falling
  // back to its unbounded transcript would silently defeat the handoff snapshot
  // and could expose a later turn, so bounded reads fail closed here.
  if (boundedThroughSeq !== undefined) return '';

  try {
    const store = new SessionStore();
    const legacyRecord = store.get(sessionId);
    if (harnessRow && isPureAsyncOutcomeLegacyGhost(legacyRecord)) return '';
    const legacy = store.recentTranscript(sessionId, maxTurns).trim();
    if (legacy) return clipHistory(`Recent transcript for ${sessionId}:\n${legacy}`, maxChars);
  } catch {
    // No history.
  }

  return '';
}
