import type Database from 'better-sqlite3';
import { openEventLog } from './eventlog.js';

/**
 * The writes in one turn that a provider (or a command) answered with its own
 * refusal: the settlement ledger's `provider_refused_envelope` rows, whatever
 * lane carried them. A change of plan after one of these is the owner's call,
 * so the consent gate and the card read them; nothing here decides anything.
 */
export interface TurnAnsweredRefusal {
  logicalToolCallId: string;
  toolName: string;
  providerStatus: string | null;
  /** The provider's reply, bounded. Data for the card's checker, never instructions. */
  reply: string;
  /** The refused call's arguments, bounded, so the card can say what changed. */
  refusedArguments: string;
}

const REPLY_MAX_CHARS = 600;
const ARGUMENTS_MAX_CHARS = 600;

function bounded(value: unknown, max: number): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value !== undefined && value !== null) {
    try { text = JSON.stringify(value) ?? ''; } catch { text = ''; }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function eventData(db: Database.Database, sessionId: string, callId: string, type: 'tool_called' | 'tool_returned'): Record<string, unknown> | null {
  const row = db.prepare(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = ? AND json_extract(data_json, '$.callId') = ?
     ORDER BY seq DESC LIMIT 1
  `).get(sessionId, type, callId) as { data_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Answered refusals of writes in this turn, oldest first, other than `exceptLogicalToolCallId`. */
export function answeredRefusalsInTurn(input: {
  sessionId: string;
  sourceUserSeq: number;
  exceptLogicalToolCallId?: string;
  db?: Database.Database;
}): TurnAnsweredRefusal[] {
  try {
    const db = input.db ?? openEventLog();
    const rows = db.prepare(`
      SELECT s.logical_tool_call_id AS id, l.tool_name AS toolName, s.provider_status AS providerStatus
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.mutating = 1
         AND s.outcome_kind = 'uncertain_write'
         AND s.outcome_detail = 'provider_refused_envelope'
       ORDER BY s.settled_at, s.logical_tool_call_id
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ id: string; toolName: string; providerStatus: string | null }>;
    return rows
      .filter((row) => row.id !== input.exceptLogicalToolCallId)
      .map((row) => {
        const returned = eventData(db, input.sessionId, row.id, 'tool_returned');
        const called = eventData(db, input.sessionId, row.id, 'tool_called');
        return {
          logicalToolCallId: row.id,
          toolName: row.toolName,
          providerStatus: row.providerStatus,
          reply: bounded(returned?.result ?? returned?.preview, REPLY_MAX_CHARS),
          refusedArguments: bounded(called?.args ?? called?.arguments, ARGUMENTS_MAX_CHARS),
        };
      });
  } catch {
    return [];
  }
}

/**
 * The writes in this turn that went through, oldest first, by operation. A
 * card raised partway through a request reads them, so its question can say
 * what is already done before it asks for the next thing. Display only.
 */
export function writesDoneInTurn(input: {
  sessionId: string;
  sourceUserSeq: number;
  db?: Database.Database;
}): string[] {
  try {
    const db = input.db ?? openEventLog();
    const rows = db.prepare(`
      SELECT l.tool_name AS toolName
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.mutating = 1
         AND s.outcome_kind = 'succeeded'
       ORDER BY s.settled_at, s.logical_tool_call_id
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ toolName: string }>;
    return rows.map((row) => row.toolName).filter((name) => typeof name === 'string' && name.trim().length > 0).slice(-6);
  } catch {
    return [];
  }
}
