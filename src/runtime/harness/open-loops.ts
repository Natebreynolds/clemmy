/**
 * Open loops: questions Clem asked THIS principal in OTHER recent conversations
 * that are still unanswered.
 *
 * Live 2026-09-15: three messages from one phone arrived as three new chats
 * (the client sent no session id). Each turn started blank, Clem asked a
 * question, and the next message — plausibly the answer — landed in another
 * blank room. Task continuity is exact-session and prospective memory is
 * captured rules, so nothing carried "what I asked you and what it was
 * about" across conversations. This module does, as bounded context: the
 * model reasons about whether the current message answers one of them; the
 * harness never decides that for it.
 *
 * Principal = the session's channel + audience id, the same identity the
 * accepted-source selector keys continuity on. Advisory only, best-effort,
 * never throws.
 */
import { openEventLog } from './eventlog.js';

export interface OpenLoop {
  sessionId: string;
  askedAt: string;
  question: string;
  options: string[];
  /** The request the question was asked about (that conversation's latest user input before the ask). */
  about: string | null;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 3;
const MAX_QUESTION_CHARS = 240;
const MAX_ABOUT_CHARS = 160;
const CANDIDATE_SESSIONS = 24;
/** The loop-control marker is host protocol, never text a person should read. */
const ASK_MARKER_RE = /^\s*ASK:\s*/i;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function stripAskMarker(text: string): string {
  return text.replace(ASK_MARKER_RE, '');
}

export function openLoopsForSession(
  sessionId: string,
  options: { now?: number; windowMs?: number; limit?: number } = {},
): OpenLoop[] {
  try {
    const db = openEventLog();
    const self = db.prepare('SELECT channel, user_id FROM sessions WHERE id = ?').get(sessionId) as
      | { channel: string | null; user_id: string | null }
      | undefined;
    if (!self || !self.channel) return [];
    const now = options.now ?? Date.now();
    const since = new Date(now - (options.windowMs ?? DEFAULT_WINDOW_MS)).toISOString();
    const siblings = db.prepare(`
      SELECT id FROM sessions
       WHERE channel = ? AND COALESCE(user_id, '') = ? AND id != ? AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT ?
    `).all(self.channel, self.user_id ?? '', sessionId, since, CANDIDATE_SESSIONS) as Array<{ id: string }>;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const loops: OpenLoop[] = [];
    for (const { id } of siblings) {
      const ask = db.prepare(`
        SELECT seq, created_at, data_json FROM events
         WHERE session_id = ? AND type = 'awaiting_user_input'
         ORDER BY seq DESC LIMIT 1
      `).get(id) as { seq: number; created_at: string; data_json: string } | undefined;
      if (!ask || ask.created_at < since) continue;
      const answered = db.prepare(`
        SELECT 1 AS ok FROM events
         WHERE session_id = ? AND type = 'user_input_received' AND seq > ? LIMIT 1
      `).get(id, ask.seq);
      if (answered) continue;
      let data: { question?: unknown; options?: unknown } = {};
      try { data = JSON.parse(ask.data_json) as typeof data; } catch { continue; }
      const question = typeof data.question === 'string' ? stripAskMarker(data.question).trim() : '';
      if (!question) continue;
      const about = db.prepare(`
        SELECT data_json FROM events
         WHERE session_id = ? AND type = 'user_input_received' AND seq < ?
         ORDER BY seq DESC LIMIT 1
      `).get(id, ask.seq) as { data_json: string } | undefined;
      let aboutText: string | null = null;
      if (about) {
        try {
          const parsed = JSON.parse(about.data_json) as { text?: unknown };
          if (typeof parsed.text === 'string' && parsed.text.trim()) aboutText = clip(parsed.text, MAX_ABOUT_CHARS);
        } catch { /* advisory */ }
      }
      loops.push({
        sessionId: id,
        askedAt: ask.created_at,
        question: clip(question, MAX_QUESTION_CHARS),
        options: Array.isArray(data.options) ? data.options.filter((o): o is string => typeof o === 'string').slice(0, 4) : [],
        about: aboutText,
      });
      if (loops.length >= limit) break;
    }
    return loops;
  } catch {
    return [];
  }
}

/** Render as data plus one floor. What to do with it is the model's call. */
export function renderOpenLoops(loops: readonly OpenLoop[]): string {
  if (loops.length === 0) return '';
  const lines = loops.map((loop) => {
    const about = loop.about ? ` — about: "${loop.about}"` : '';
    const options = loop.options.length > 0 ? ` (options offered: ${loop.options.map((o) => `"${clip(o, 60)}"`).join(', ')})` : '';
    return `- You asked: "${loop.question}"${options}${about}`;
  });
  return [
    '[open with you — questions you asked this person in other recent conversations, still unanswered, newest first. '
    + 'If this message answers one, that is the work to continue here: pick it up from the answer without asking again, '
    + 're-establishing from live sources anything that conversation knew, since its details are not in view. '
    + 'If it is unrelated, ignore them.]',
    ...lines,
  ].join('\n');
}
