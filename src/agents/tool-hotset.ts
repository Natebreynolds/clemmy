/**
 * Per-session tool hot-set — a small capped LRU of the built-in tools a session
 * has actually reached for (via tool_search hits, and later call_tool dispatch).
 *
 * Static schema-on-demand hot set. It feeds resolveHotSet()
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
// Only ACTUALLY-dispatched tools are promoted. Three is enough to remove repeat
// dispatcher friction without letting a long conversation slowly reconstruct
// the old 60-schema always-loaded surface.
const PER_SESSION_CAP = 3;
/** Cap the number of sessions retained so the state file can't grow unbounded. */
const MAX_SESSIONS = 200;

/** One carried tool and the accepted request in which it last succeeded. */
interface HotSetEntry { name: string; source: number | null }

interface HotSetState {
  /** sessionId → most-recent-first tools (legacy rows are bare names). */
  sessions: Record<string, Array<string | HotSetEntry>>;
  /** sessionId → the accepted requests a tool list was last built for. */
  sources?: Record<string, number[]>;
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
        sources: raw && typeof raw.sources === 'object' && raw.sources ? raw.sources : {},
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

function entryOf(value: string | HotSetEntry): HotSetEntry {
  return typeof value === 'string' ? { name: value, source: null } : value;
}

/**
 * Record that `name` SUCCEEDED in `sessionId` during accepted request
 * `sourceUserSeq`. Only a tool that worked is carried into later turns: a
 * failed or unused one costs every request it rides on (live 2026-10-16: a
 * web read that returned 404 stayed in a chat's tool block, and its schema
 * made every later request in that chat fail). Best-effort; never throws.
 */
export function recordToolHit(sessionId: string | undefined | null, name: string, sourceUserSeq?: number): void {
  const sid = (sessionId ?? '').trim();
  const tool = (name ?? '').trim();
  if (!sid || !tool) return;
  try {
    const state = load();
    const prev = (state.sessions[sid] ?? []).map(entryOf);
    const source = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq as number) > 0 ? sourceUserSeq as number : null;
    const next = [{ name: tool, source }, ...prev.filter((entry) => entry.name !== tool)].slice(0, PER_SESSION_CAP);
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

/**
 * Note that a tool list is being built for accepted request `sourceUserSeq`
 * and return the requests whose successes are still carried: this one and the
 * one before it. A tool not used successfully in either drops off the list.
 * Never throws; without a request it returns null (no filtering).
 */
export function liveHotSetSources(
  sessionId: string | undefined | null,
  sourceUserSeq: number | null | undefined,
): ReadonlySet<number> | null {
  const sid = (sessionId ?? '').trim();
  if (!sid || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq as number) <= 0) return null;
  const source = sourceUserSeq as number;
  try {
    const state = load();
    state.sources ??= {};
    const known = state.sources[sid] ?? [];
    if (!known.includes(source)) {
      state.sources[sid] = [...known, source].sort((a, b) => a - b).slice(-2);
      for (const id of Object.keys(state.sources)) {
        if (!state.sessions[id] && id !== sid) delete state.sources[id];
      }
      persist(state);
    }
    const recent = (state.sources[sid] ?? []).filter((seq) => seq <= source).slice(-2);
    return new Set(recent.length > 0 ? recent : [source]);
  } catch {
    return new Set([source]);
  }
}

/** A tool whose call failed stops being carried. Best-effort; never throws. */
export function forgetToolHit(sessionId: string | undefined | null, name: string): void {
  const sid = (sessionId ?? '').trim();
  const tool = (name ?? '').trim();
  if (!sid || !tool) return;
  try {
    const state = load();
    const prev = (state.sessions[sid] ?? []).map(entryOf);
    if (!prev.some((entry) => entry.name === tool)) return;
    state.sessions[sid] = prev.filter((entry) => entry.name !== tool);
    persist(state);
  } catch (err) {
    logger.warn({ err }, 'tool-hotset: forgetToolHit failed (best-effort)');
  }
}

/** The session's hot-set, most-recent-first (empty when unknown). With
 * `liveSources`, only tools that last succeeded in one of those accepted
 * requests are returned; an entry with no recorded request is not carried.
 * Never throws. */
export function getHotSet(
  sessionId: string | undefined | null,
  liveSources?: ReadonlySet<number>,
): string[] {
  const sid = (sessionId ?? '').trim();
  if (!sid) return [];
  try {
    return (load().sessions[sid] ?? []).map(entryOf)
      .filter((entry) => !liveSources || (entry.source !== null && liveSources.has(entry.source)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Test-only: drop the in-memory cache so a fresh CLEMENTINE_HOME is picked up. */
export function _resetHotSetForTest(): void {
  cache = null;
}
