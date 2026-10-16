import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveSafeCliProbe } from '../../runtime/cli-discovery.js';
import { retireConnectedCliPin } from './connected-cli-bin.js';
import { readCliHealthEntries, readConnectedCliState, withConnectedCliStateLock,
  writeCliHealthEntries, writeConnectedCliState } from './connected-cli-state.js';
import { CLI_CATALOG, type CliAuthProbe, type CliCatalogEntry } from './catalog-entries.js';

export * from './catalog-entries.js';

export interface CatalogSearchResult extends CliCatalogEntry {
  /** Match score 0..1 — higher = better. UI sorts by this descending. */
  score: number;
}

/**
 * Substring + token search across name, command, vendor, tags, and
 * description. The dashboard's user types a partial name and we surface
 * matches sorted by relevance. No fuzzy matching — keeping it predictable
 * so "salesforce" returns Salesforce CLI deterministically.
 */
export function searchCatalog(query: string): CatalogSearchResult[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const results: CatalogSearchResult[] = [];
  for (const entry of CLI_CATALOG) {
    let score = 0;
    const name = entry.name.toLowerCase();
    const cmd = entry.command.toLowerCase();
    const vendor = entry.vendor.toLowerCase();
    const desc = entry.description.toLowerCase();
    // Strongest signals first: exact command match > exact name > prefix
    // matches > tag membership > description hit.
    if (cmd === q) score = Math.max(score, 1.0);
    if (name === q) score = Math.max(score, 0.95);
    if (cmd.startsWith(q)) score = Math.max(score, 0.85);
    if (name.startsWith(q)) score = Math.max(score, 0.8);
    for (const t of entry.tags) {
      const tag = t.toLowerCase();
      if (tag === q) score = Math.max(score, 0.78);
      else if (tag.startsWith(q)) score = Math.max(score, 0.7);
      else if (tag.includes(q)) score = Math.max(score, 0.55);
    }
    if (vendor.includes(q)) score = Math.max(score, 0.5);
    if (name.includes(q)) score = Math.max(score, 0.45);
    if (desc.includes(q)) score = Math.max(score, 0.3);
    if (score > 0) results.push({ ...entry, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

export function findCatalogEntry(id: string): CliCatalogEntry | undefined {
  return CLI_CATALOG.find((e) => e.id === id);
}

// ─── Install status (is the CLI on $PATH right now) ────────────────

function whichOnPath(command: string): string | undefined {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch { /* skip */ }
  }
  return undefined;
}

export interface CatalogEntryStatus extends CliCatalogEntry {
  installed: boolean;
  installedAt?: string;
  /** Path the command resolves to on $PATH, when installed. */
  resolvedPath?: string;
}

export function statusForEntry(entry: CliCatalogEntry): CatalogEntryStatus {
  const resolved = whichOnPath(entry.command);
  const safe = resolved ? resolveSafeCliProbe(entry.command, resolved) : null;
  const connected = readConnectedClis()[entry.id];
  return {
    ...entry,
    installed: Boolean(safe && !safe.skipped),
    installedAt: connected?.installedAt,
    resolvedPath: safe?.path ?? resolved,
  };
}

export function statusForSearchResults(query: string): Array<CatalogEntryStatus & { score: number }> {
  return searchCatalog(query).map((entry) => ({ ...statusForEntry(entry), score: entry.score }));
}

// ─── Connected-CLI record (links to the agent) ──────────────────────

export interface ConnectedCliRecord {
  id: string;
  command: string;
  vendor: string;
  name: string;
  installedAt: string;
  /** Host connection incarnation, never an authentication/account grant. */
  connectionRevision?: string;
  authDocsUrl: string;
  authCommand?: string;
  /** Denormalized from the catalog at record time (same as authCommand). */
  authProbe?: CliAuthProbe;
  authHeadless?: boolean;
}

export function readConnectedClis(): Record<string, ConnectedCliRecord> {
  return readConnectedCliState().entries;
}

/** Same file as readConnectedClis but returns the forgotten ids list.
 *  Kept as a separate function so callers don't have to know about the
 *  full file shape. Returns [] when file is missing or malformed. */
export function readForgottenCliIds(): string[] {
  return readConnectedCliState().forgotten;
}

/**
 * Mark a catalog entry as connected (typically called right after the
 * install runner reports success). Idempotent — a second call updates
 * installedAt to "now".
 */
export function recordConnectedCli(entry: CliCatalogEntry): ConnectedCliRecord {
  return withConnectedCliStateLock(() => recordConnectedCliLocked(entry, false));
}

function recordConnectedCliLocked(entry: CliCatalogEntry, reconnect: boolean): ConnectedCliRecord {
  const state = readConnectedCliState();
  const health = readCliHealthEntries();
  const previous = state.entries[entry.id];
  const record: ConnectedCliRecord = {
    id: entry.id,
    command: entry.command,
    vendor: entry.vendor,
    name: entry.name,
    installedAt: new Date().toISOString(),
    connectionRevision: randomUUID(),
    authDocsUrl: entry.authDocsUrl,
    authCommand: entry.authCommand,
    ...(entry.authProbe ? { authProbe: entry.authProbe } : {}),
    ...(entry.authHeadless !== undefined ? { authHeadless: entry.authHeadless } : {}),
  };
  // Retire only this old observation, not credentials or another CLI's pin.
  retireConnectedCliPin(previous, health[entry.id]);
  if (Object.hasOwn(health, entry.id)) {
    delete health[entry.id];
    writeCliHealthEntries(health);
  }
  state.entries[entry.id] = record;
  if (reconnect) state.forgotten = state.forgotten.filter(id => id !== entry.id);
  writeConnectedCliState(state);
  return record;
}

/**
 * Drop a connected-CLI record AND remember that the user explicitly
 * forgot it, so the auto-promote loop doesn't immediately re-add it on
 * the next refresh. The binary on PATH is untouched — this just clears
 * Clementine's note that the user wants this surfaced as connected.
 */
export function forgetConnectedCli(id: string): void {
  withConnectedCliStateLock(() => {
    const state = readConnectedCliState();
    const health = readCliHealthEntries();
    const previous = state.entries[id];
    const hadEntry = Object.hasOwn(state.entries, id);
    if (hadEntry) delete state.entries[id];
    const alreadyForgotten = state.forgotten.includes(id);
    if (!alreadyForgotten) state.forgotten.push(id);
    // Keep old ownership available if unlink fails. All cooperative writers
    // share this lock; no old sync can interleave with retirement/publication.
    retireConnectedCliPin(previous, health[id]);
    if (Object.hasOwn(health, id)) {
      delete health[id];
      writeCliHealthEntries(health);
    }
    if (hadEntry || !alreadyForgotten) writeConnectedCliState(state);
  });
}

/**
 * Reconnect a previously-forgotten catalog CLI. Drops it from the
 * forgotten list and records the connection. Used by the dashboard's
 * "Reconnect" button when the user wants a CLI back after explicitly
 * disconnecting it earlier.
 */
export function reconnectCli(id: string): ConnectedCliRecord | null {
  const entry = findCatalogEntry(id);
  if (!entry) return null;
  return withConnectedCliStateLock(() => recordConnectedCliLocked(entry, true));
}

/**
 * Auto-promotion sweep — for every catalog entry whose binary resolves
 * on PATH but isn't yet in the connected list AND wasn't explicitly
 * forgotten, write a connected record. Idempotent + fast (one PATH
 * resolution + one file write per missing entry).
 *
 * Why this exists: previously a user who installed Salesforce CLI via
 * `npm install -g @salesforce/cli` BEFORE installing Clementine got
 * `sf` on PATH but not in connected-clis.json. The agent could still
 * find it via the global CLI scan, but the dashboard wouldn't surface
 * it as a first-class integration and the agent missed the auth-
 * command hint. This closes the gap: any installed catalog CLI
 * becomes connected automatically, without making the user click
 * through the install flow.
 *
 * Disconnect semantics preserved: an id in `forgotten[]` is skipped
 * by this sweep. The user has to call reconnectCli(id) explicitly.
 *
 * Returns the list of promoted ids for logging + UI feedback.
 */
export function autoPromoteInstalledClis(): { promoted: string[]; skipped: string[] } {
  const connected = readConnectedClis();
  const forgotten = new Set(readForgottenCliIds());
  const promoted: string[] = [];
  const skipped: string[] = [];
  for (const entry of CLI_CATALOG) {
    if (connected[entry.id]) continue; // already connected
    if (forgotten.has(entry.id)) { skipped.push(entry.id); continue; }
    const resolved = whichOnPath(entry.command);
    if (!resolved) continue;
    const safe = resolveSafeCliProbe(entry.command, resolved);
    if (!safe || safe.skipped) continue;
    // Installed AND eligible — promote.
    const outcome = withConnectedCliStateLock(() => {
      const latest = readConnectedCliState();
      if (latest.forgotten.includes(entry.id)) return 'forgotten';
      if (Object.hasOwn(latest.entries, entry.id)) return 'connected';
      recordConnectedCliLocked(entry, false);
      return 'promoted';
    });
    if (outcome === 'promoted') promoted.push(entry.id);
    if (outcome === 'forgotten') skipped.push(entry.id);
  }
  return { promoted, skipped };
}
