import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ConversationTurn, SessionRecord } from '../types.js';
import { ASSISTANT_PAUSED_PLACEHOLDER } from '../runtime/provider.js';

const SESSION_DIR = path.join(BASE_DIR, 'state');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');
// Sessions like `console:home` are a persistent rolling chat for the
// user — we MUST keep enough turns to make months of normal use feel
// continuous. The previous cap of 40 silently dropped older content
// every time the session went past ~40 messages, which is well within
// a single afternoon for a real working session. Bumped to 400 (≈ 5+
// months of typical use at the observed ~80 turns/week). Anything
// pushed past the cap is archived to a daily vault note (see
// archiveDroppedTurnsToVault) so it remains FTS-recallable instead
// of vanishing into /dev/null.
const MAX_TURNS_PER_SESSION = 400;
// Vault subfolder for archived session turns. Lives under the
// existing Daily Notes tree so the vault reindexer picks it up
// automatically without any new wiring.
const SESSION_ARCHIVE_VAULT_REL = path.join('vault', '01-Daily-Notes');

function isPersistableTurn(turn: ConversationTurn): boolean {
  // Drop the "Clementine paused without a final reply" placeholder —
  // a runtime error sentinel, not real conversation. Storing it costs
  // a slot in the turn window AND clutters the brief / transcript
  // with "Clementine paused" entries that displace real history.
  if (turn.role === 'assistant' && turn.text.trim() === ASSISTANT_PAUSED_PLACEHOLDER) {
    return false;
  }
  return true;
}

function archiveDroppedTurnsToVault(sessionId: string, dropped: ConversationTurn[]): void {
  if (dropped.length === 0) return;
  try {
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(BASE_DIR, SESSION_ARCHIVE_VAULT_REL);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${day}-chat-archive-${safeSession}.md`);
    const header = existsSync(filePath)
      ? ''
      : `---\nkind: chat-archive\nsessionId: ${sessionId}\nday: ${day}\n---\n\n# Chat archive · ${sessionId} · ${day}\n\nTurns rotated out of the live session ring buffer. Searchable via vault FTS / semantic recall.\n\n`;
    const body = dropped
      .map((turn) => `## ${turn.role} · ${turn.createdAt}\n\n${turn.text}\n`)
      .join('\n');
    appendFileSync(filePath, `${header}${body}\n`, 'utf-8');
  } catch {
    // Best-effort. Archive failure must never block the chat turn —
    // the canonical session is still being persisted; this is just
    // the durable recall path.
  }
}

function ensureSessionDir(): void {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function loadSessions(): Record<string, SessionRecord> {
  ensureSessionDir();
  if (!existsSync(SESSION_FILE)) return {};

  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as Record<string, SessionRecord>;
  } catch {
    return {};
  }
}

function saveSessions(data: Record<string, SessionRecord>): void {
  ensureSessionDir();
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

export class SessionStore {
  list(limit = 20): SessionRecord[] {
    return Object.values(loadSessions())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  /**
   * Read-only filter of this user's sessions, newest first. Backs the chat
   * cross-session seed (continuity when a user starts a fresh session, or the
   * same user moves between surfaces that share a userId). Does NOT merge with
   * the harness eventlog store or unify session ids — it just queries the
   * existing chat sessions map by userId.
   */
  listByUser(userId: string, limit = 20): SessionRecord[] {
    if (!userId) return [];
    return Object.values(loadSessions())
      .filter((s) => s.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  get(sessionId: string): SessionRecord {
    const sessions = loadSessions();
    const existing = sessions[sessionId];
    if (existing) return existing;

    const now = new Date().toISOString();
    return {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
  }

  upsert(session: SessionRecord): void {
    const sessions = loadSessions();
    sessions[session.id] = session;
    saveSessions(sessions);
  }

  appendTurn(sessionId: string, turn: ConversationTurn, userId?: string, channel?: string): SessionRecord {
    const session = this.get(sessionId);
    session.userId = userId ?? session.userId;
    session.channel = channel ?? session.channel;
    if (!isPersistableTurn(turn)) {
      // Don't store error placeholders. The channel already rendered
      // the text to the user; nothing is lost in their view, and we
      // keep the turn window dense with real content.
      session.updatedAt = new Date().toISOString();
      this.upsert(session);
      return session;
    }
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS_PER_SESSION) {
      // Archive the rotated turns to the vault before dropping so the
      // conversation remains FTS-recallable. Previously these were
      // silently lost — see commit history for the "I had a chat
      // earlier and the agent can't find it" failure mode.
      const overflow = session.turns.length - MAX_TURNS_PER_SESSION;
      const dropped = session.turns.slice(0, overflow);
      archiveDroppedTurnsToVault(session.id, dropped);
      session.turns = session.turns.slice(-MAX_TURNS_PER_SESSION);
    }
    session.updatedAt = new Date().toISOString();
    this.upsert(session);
    return session;
  }

  recentTranscript(sessionId: string, maxTurns = 12): string {
    const session = this.get(sessionId);
    const turns = session.turns.slice(-maxTurns);
    if (turns.length === 0) return '';

    return turns
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
      .join('\n');
  }
}
