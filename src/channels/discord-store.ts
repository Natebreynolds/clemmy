import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';

const DISCORD_STATE_FILE = path.join(BASE_DIR, 'state', 'discord-state.json');

export interface DiscordSessionBinding {
  id: string;
  key: string;
  sessionId: string;
  channelId: string;
  userId: string;
  guildId?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

interface DiscordStateFile {
  sessions: DiscordSessionBinding[];
}

function loadState(): DiscordStateFile {
  if (!existsSync(DISCORD_STATE_FILE)) {
    return { sessions: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(DISCORD_STATE_FILE, 'utf-8')) as Partial<DiscordStateFile>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { sessions: [] };
  }
}

function saveState(state: DiscordStateFile): void {
  mkdirSync(path.dirname(DISCORD_STATE_FILE), { recursive: true });
  writeFileSync(DISCORD_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function buildSessionKey(channelId: string, userId: string, guildId?: string): string {
  return [guildId ?? 'dm', channelId, userId].join(':');
}

export function getOrCreateDiscordSessionId(input: {
  channelId: string;
  userId: string;
  guildId?: string;
}): string {
  const state = loadState();
  const key = buildSessionKey(input.channelId, input.userId, input.guildId);
  const now = new Date().toISOString();
  const existing = state.sessions.find((entry) => entry.key === key);

  if (existing) {
    existing.updatedAt = now;
    existing.lastMessageAt = now;
    saveState(state);
    return existing.sessionId;
  }

  state.sessions.push({
    id: randomUUID(),
    key,
    sessionId: `discord:${randomUUID()}`,
    channelId: input.channelId,
    userId: input.userId,
    guildId: input.guildId,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  });
  saveState(state);
  return state.sessions[state.sessions.length - 1].sessionId;
}

export function listDiscordSessions(limit = 30): DiscordSessionBinding[] {
  return loadState()
    .sessions
    .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
    .slice(0, limit);
}

export function countDiscordSessions(): number {
  return loadState().sessions.length;
}
