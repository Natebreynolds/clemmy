/**
 * Per-session tool hot-set — a small capped LRU of the built-in tools a session
 * has actually reached for (via tool_search hits, and later call_tool dispatch).
 *
 * Phase 0 of SCHEMA-ON-DEMAND-PLAN-2026-07-07.md. It feeds resolveHotSet()
 * (tool-catalog.ts): a tool the model searched for THIS turn is promoted to a
 * first-class schema NEXT turn, so repeated use of a discovered tool stops paying
 * the search round-trip. Dormant until the Codex schema-on-demand lane is enabled;
 * recording hits now is harmless (write-only, best-effort).
 *
 * Persistence: a single small JSON state file under the Clementine home
 * (CLEMENTINE_HOME-aware), so the hot-set survives a daemon restart. The path is
 * resolved lazily on each load so a test can point CLEMENTINE_HOME at a temp dir
 * before the first call and never touch real state.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pino from 'pino';

const logger = pino({ name: 'clementine-next.tool-hotset' });

/** Most-recent-first names a session has reached for, capped per session. */
const PER_SESSION_CAP = 16;
/** Cap the number of sessions retained so the state file can't grow unbounded. */
const MAX_SESSIONS = 200;

interface HotSetState {
  /** sessionId → most-recent-first tool names. */
  sessions: Record<string, string[]>;
  /** most-recently-touched-first session ids (for MAX_SESSIONS eviction). */
  order: string[];
}

let cache: HotSetState | null = null;

function stateFilePath(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return path.join(base, 'state', 'tool-hotset.json');
}

function load(): HotSetState {
  if (cache) return cache;
  try {
    const file = stateFilePath();
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HotSetState>;
      cache = {
        sessions: raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {},
        order: Array.isArray(raw?.order) ? raw!.order! : [],
      };
      return cache;
    }
  } catch (err) {
    logger.warn({ err }, 'tool-hotset: failed to read state; starting empty');
  }
  cache = { sessions: {}, order: [] };
  return cache;
}

function persist(state: HotSetState): void {
  try {
    const file = stateFilePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err }, 'tool-hotset: failed to persist state (best-effort)');
  }
}

/** Record that `name` was reached for in `sessionId`. Best-effort; never throws. */
export function recordToolHit(sessionId: string | undefined | null, name: string): void {
  const sid = (sessionId ?? '').trim();
  const tool = (name ?? '').trim();
  if (!sid || !tool) return;
  try {
    const state = load();
    const prev = state.sessions[sid] ?? [];
    const next = [tool, ...prev.filter((n) => n !== tool)].slice(0, PER_SESSION_CAP);
    state.sessions[sid] = next;
    state.order = [sid, ...state.order.filter((s) => s !== sid)];
    if (state.order.length > MAX_SESSIONS) {
      for (const evicted of state.order.slice(MAX_SESSIONS)) delete state.sessions[evicted];
      state.order = state.order.slice(0, MAX_SESSIONS);
    }
    persist(state);
  } catch (err) {
    logger.warn({ err }, 'tool-hotset: recordToolHit failed (best-effort)');
  }
}

/** The session's hot-set, most-recent-first (empty when unknown). Never throws. */
export function getHotSet(sessionId: string | undefined | null): string[] {
  const sid = (sessionId ?? '').trim();
  if (!sid) return [];
  try {
    return [...(load().sessions[sid] ?? [])];
  } catch {
    return [];
  }
}

/** Test-only: drop the in-memory cache so a fresh CLEMENTINE_HOME is picked up. */
export function _resetHotSetForTest(): void {
  cache = null;
}
