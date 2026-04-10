import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ConversationTurn, SessionRecord } from '../types.js';

const SESSION_DIR = path.join(BASE_DIR, 'state');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');
const MAX_TURNS_PER_SESSION = 40;

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
    session.turns.push(turn);
    session.turns = session.turns.slice(-MAX_TURNS_PER_SESSION);
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
