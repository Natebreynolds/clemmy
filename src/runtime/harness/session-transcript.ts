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
  type SessionRow,
} from './eventlog.js';

export interface PriorTurn { who: 'user' | 'assistant'; text: string; at: string }

/**
 * Render the IRREVERSIBLE external actions that already SUCCEEDED in this session,
 * so a brain returning to an existing chat KNOWS what it already did. The text
 * transcript (user_input/conversation_completed) does NOT include tool results, so
 * without this the brain is blind to its own completed sends — the 2026-06-29
 * double-send (it re-ran a send because the prior turn's text didn't record it,
 * and an errored turn emits no conversation_completed at all). Reads external_write
 * events, netting out explicit external_write_failed compensation rows; deduped
 * by (shape, target), newest first. '' when nothing was sent.
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

function readRecentActionRowsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit: number,
): RawActionRow[] {
  const rowLimit = Math.max(1, Math.trunc(limit));
  return db.prepare(
    `SELECT seq, type, data_json FROM events
       WHERE session_id = ?
         AND type IN ('external_write', 'external_write_failed')
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(sessionId, rowLimit) as RawActionRow[];
}

function renderRecentActionsForSessions(
  db: ReturnType<typeof openEventLog>,
  sessionIds: string[],
  limit = 20,
  scopeLabel = 'THIS conversation',
): string {
  let rows: RawActionRow[];
  try {
    const rowLimit = Math.max(limit * 4, limit);
    rows = uniqueSessionIds(sessionIds)
      .flatMap((sessionId) => readRecentActionRowsForSession(db, sessionId, rowLimit))
      .sort((left, right) => right.seq - left.seq)
      .slice(0, rowLimit);
  } catch { return ''; }
  if (rows.length === 0) return '';
  const seen = new Set<string>();
  const failed = new Map<string, number>();
  const lines: string[] = [];
  for (const row of rows) {
    try {
      const d = JSON.parse(row.data_json) as { shapeKey?: string; toolName?: string; targets?: string[] };
      const shape = String(d.shapeKey ?? d.toolName ?? 'action');
      const targets = (d.targets ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      for (const t of (targets.length ? targets : ['(no target)'])) {
        const key = `${shape}::${t.toLowerCase()}`;
        if (row.type === 'external_write_failed') {
          failed.set(key, (failed.get(key) ?? 0) + 1);
          continue;
        }
        const failedCount = failed.get(key) ?? 0;
        if (failedCount > 0) {
          if (failedCount === 1) failed.delete(key);
          else failed.set(key, failedCount - 1);
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${shape} → ${t}`);
        if (lines.length >= limit) break;
      }
      if (lines.length >= limit) break;
    } catch { /* skip malformed rows */ }
  }
  if (lines.length === 0) return '';
  const scopeBody = scopeLabel === 'THIS conversation' ? 'this same session' : scopeLabel.toLowerCase();
  return [
    `ALREADY DONE in ${scopeLabel} — these external actions SUCCEEDED earlier in ${scopeBody}. Do NOT repeat any of them unless the user EXPLICITLY asks you to do it AGAIN. A prior turn that errored AFTER one of these still COUNTS as done — it was NOT cancelled:`,
    ...lines,
  ].join('\n');
}

export function renderRecentSessionActions(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 20,
): string {
  return renderRecentActionsForSessions(db, [sessionId], limit);
}

export function renderRecentActionsForHarnessHistory(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 20,
): string {
  let row: SessionRow | null = null;
  try { row = getHarnessSession(sessionId); } catch { row = null; }
  if (!row) return renderRecentActionsForSessions(db, [sessionId], limit);
  const relatedRows = relatedHarnessRowsForHistory(row);
  const workflowRunId = workflowRunIdFor(row);
  const isWorkflowAggregate = workflowRunId && relatedRows.length > 1;
  return renderRecentActionsForSessions(
    db,
    relatedRows.map((related) => related.id),
    limit,
    isWorkflowAggregate ? 'THIS workflow run' : 'THIS conversation',
  );
}

function readRecentTranscriptRowsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  maxTurns: number,
): RawTranscriptRow[] {
  const rowLimit = Math.max(1, Math.trunc(maxTurns) * 3);
  return db.prepare(
    `SELECT seq, session_id, type, data_json, created_at, turn FROM events
       WHERE session_id = ?
         AND type IN ('user_input_received', 'conversation_completed', 'awaiting_user_input')
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(sessionId, rowLimit) as RawTranscriptRow[];
}

/** Read the recent user+assistant turns for ONE session, chronological order. */
export function pullRecentTurnsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  maxTurns: number,
): PriorTurn[] {
  return pullRecentTurnsForSessions(db, [sessionId], maxTurns);
}

/** Read recent user+assistant turns across related sessions, chronological order. */
export function pullRecentTurnsForSessions(
  db: ReturnType<typeof openEventLog>,
  sessionIds: string[],
  maxTurns: number,
): PriorTurn[] {
  const turnLimit = Math.max(1, Math.trunc(maxTurns));
  // Read the last 2*maxTurns events (user inputs + agent completions) so we have
  // headroom to filter and reorder chronologically.
  const rows = uniqueSessionIds(sessionIds)
    .flatMap((sessionId) => readRecentTranscriptRowsForSession(db, sessionId, turnLimit))
    .sort((left, right) => right.seq - left.seq);
  const completionTextByTurn = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.type !== 'conversation_completed') continue;
    try {
      const data = JSON.parse(row.data_json) as { summary?: string; reply?: string };
      const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : '';
      const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : '';
      const text = normalizeTranscriptText(reply || summary);
      if (!text) continue;
      const turnKey = `${row.session_id}:${row.turn}`;
      const set = completionTextByTurn.get(turnKey) ?? new Set<string>();
      set.add(text);
      completionTextByTurn.set(turnKey, set);
    } catch { /* skip malformed rows */ }
  }
  const turns: PriorTurn[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { text?: string; summary?: string; reply?: string; question?: string };
      if (row.type === 'user_input_received' && typeof data.text === 'string') {
        turns.push({ who: 'user', text: data.text, at: row.created_at });
      } else if (row.type === 'conversation_completed') {
        const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : '';
        const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : '';
        const text = reply || summary;
        if (text) turns.push({ who: 'assistant', text, at: row.created_at });
      } else if (row.type === 'awaiting_user_input') {
        const question = typeof data.question === 'string' && data.question.trim() ? data.question.trim() : '';
        if (!question) continue;
        // Claude SDK ask_user_question writes both awaiting_user_input (from the
        // tool) and a paired conversation_completed(reason='awaiting_user_input').
        // Include unpaired questions so pause/resume context survives brain
        // switches, but do not double-render the paired SDK case.
        const completionTexts = completionTextByTurn.get(`${row.session_id}:${row.turn}`);
        if (completionTexts?.has(normalizeTranscriptText(question))) continue;
        turns.push({ who: 'assistant', text: question, at: row.created_at });
      }
    } catch { /* skip malformed rows */ }
  }
  // Newest last (chronological); cap to maxTurns of each kind.
  turns.reverse();
  return turns.slice(-turnLimit * 2);
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
): string {
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
         ORDER BY seq ASC
         LIMIT ?`,
      ).all(id, rowLimit) as Array<{ seq: number; data_json: string }>)
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
    return clipHistory(texts.join('\n\n'), CROSS_SESSION_PREFIXES_TOTAL_MAX_CHARS);
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

export function pullRecentTurnsForHarnessHistory(sessionId: string, maxTurns = 20): PriorTurn[] {
  const row = getHarnessSession(sessionId);
  if (!row) return [];
  const relatedSessionIds = relatedHarnessRowsForHistory(row).map((session) => session.id);
  return pullRecentTurnsForSessions(openEventLog(), relatedSessionIds, maxTurns);
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
): string {
  let harnessRow: SessionRow | null = null;
  try { harnessRow = getHarnessSession(sessionId); } catch { harnessRow = null; }

  if (harnessRow) {
    try {
      const db = openEventLog();
      const relatedRows = relatedHarnessRowsForHistory(harnessRow);
      const relatedSessionIds = relatedRows.map((row) => row.id);
      const workflowRunId = workflowRunIdFor(harnessRow);
      const isWorkflowAggregate = workflowRunId && relatedRows.length > 1;
      const prefix = renderCrossSessionPrefixesForModel(db, sessionId);
      const actions = renderRecentActionsForSessions(
        db,
        relatedSessionIds,
        20,
        isWorkflowAggregate ? 'THIS workflow run' : 'THIS conversation',
      );
      const turns = pullRecentTurnsForSessions(db, relatedSessionIds, maxTurns);
      const transcriptTitle = isWorkflowAggregate
        ? `Recent transcript for workflow run ${workflowRunId} (including ${relatedRows.length} step sessions):`
        : `Recent transcript for ${sessionId}:`;
      const parts = [
        prefix,
        actions,
        turns.length > 0
          ? `${transcriptTitle}\n${renderTranscriptTurns(turns)}`
          : '',
      ].filter(Boolean);
      if (parts.length > 0) return clipHistory(parts.join('\n\n'), maxChars);
    } catch {
      // Fall through to legacy store if the harness read is unavailable.
    }
  }

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
