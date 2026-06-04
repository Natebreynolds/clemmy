import { openMemoryDb, type ResourcePointerRow } from './db.js';
import { getRuntimeEnv } from '../config.js';

/**
 * Source-map / landscape memory (pointer-first).
 *
 * A navigational index of WHERE the user's data lives and WHEN to use it —
 * Drive folders, Airtable bases, CRM objects, mail labels — never the content
 * itself. The map is small + bounded (one row per distinct resource, deduped
 * by app+ref), so it can be injected every turn cheaply and lets Clem navigate
 * straight to the right source in both chat and long-running workflows.
 *
 * Two population paths, same storage:
 *   - reactive (Phase R) — minted by the reflection loop as Clem reads sources.
 *   - ingest   (Phase I) — opt-in per-connector structure crawlers (later).
 *
 * See docs/source-map-landscape-memory.md.
 */

/** Whether the landscape layer is active (flag-gated, default off). When off,
 *  nothing is minted and the injection renders nothing → behavior unchanged. */
export function isSourceMapEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SOURCE_MAP', 'off') || 'off').toLowerCase() === 'on';
}

export interface ResourcePointer {
  id: number;
  app: string;
  kind: string;
  ref: string;
  name: string;
  whatsHere: string | null;
  whenToUse: string | null;
  parentRef: string | null;
  trust: number | null;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

function rowToPointer(row: ResourcePointerRow): ResourcePointer {
  return {
    id: row.id,
    app: row.app,
    kind: row.kind,
    ref: row.ref,
    name: row.name,
    whatsHere: row.whats_here,
    whenToUse: row.when_to_use,
    parentRef: row.parent_ref,
    trust: row.trust,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mentionCount: row.mention_count,
  };
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/-+/g, '-').slice(0, 80);
}

/**
 * Canonical dedupe key for a resource. PREFER the provider's stable id
 * (`app:kind:<id>`) so the reactive path and the background-ingest path land
 * on the SAME row for the same resource; fall back to `app:kind:slug(name)`
 * when no id is known. This is the convergence guarantee: whenever both paths
 * have the provider id (always true for ingest; true for reactive when the
 * extractor surfaced it), they collapse to one pointer.
 */
export function canonicalRef(app: string, kind: string, providerId?: string | null, name?: string): string {
  const base = `${slug(app)}:${slug(kind || 'resource')}`;
  const id = (providerId ?? '').trim();
  if (id) return `${base}:${slug(id)}`;
  return `${base}:${slug(name ?? '')}`;
}

export interface UpsertResourceInput {
  app: string;
  kind: string;
  name: string;
  /** Provider's stable id (Drive folder id, Airtable base id, …). When present
   *  it anchors the canonical ref so reactive + ingest converge on one row. */
  providerId?: string;
  /** Explicit ref override. Normally omit and let providerId/name drive it. */
  ref?: string;
  whatsHere?: string;
  whenToUse?: string;
  parentRef?: string;
  trust?: number;
  source?: 'reactive' | 'ingest';
}

/**
 * Insert or update a resource pointer. Dedupes on (app, ref): a repeat sighting
 * bumps mention_count + last_seen and fills in any newly-learned description
 * (COALESCE — never clobbers an existing richer value with a blank).
 */
export function upsertResourcePointer(input: UpsertResourceInput): ResourcePointer {
  const app = input.app.trim();
  const name = input.name.trim();
  if (!app || !name) throw new Error('upsertResourcePointer: app and name are required');
  const kind = (input.kind || 'resource').trim();
  const ref = (input.ref && input.ref.trim()) || canonicalRef(app, kind, input.providerId, name);
  const db = openMemoryDb();
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM resource_pointers WHERE app = ? AND ref = ?')
    .get(app, ref) as ResourcePointerRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE resource_pointers
      SET name          = ?,
          kind          = ?,
          whats_here    = COALESCE(?, whats_here),
          when_to_use   = COALESCE(?, when_to_use),
          parent_ref    = COALESCE(?, parent_ref),
          trust         = COALESCE(?, trust),
          last_seen_at  = ?,
          mention_count = mention_count + 1
      WHERE id = ?
    `).run(
      name, kind,
      input.whatsHere ?? null, input.whenToUse ?? null, input.parentRef ?? null,
      typeof input.trust === 'number' ? input.trust : null,
      now, existing.id,
    );
    const refreshed = db.prepare('SELECT * FROM resource_pointers WHERE id = ?').get(existing.id) as ResourcePointerRow;
    return rowToPointer(refreshed);
  }

  const info = db.prepare(`
    INSERT INTO resource_pointers
      (app, kind, ref, name, whats_here, when_to_use, parent_ref, trust, source, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    app, kind, ref, name,
    input.whatsHere ?? null, input.whenToUse ?? null, input.parentRef ?? null,
    typeof input.trust === 'number' ? input.trust : null,
    input.source ?? 'reactive', now, now,
  );
  const inserted = db.prepare('SELECT * FROM resource_pointers WHERE id = ?').get(info.lastInsertRowid) as ResourcePointerRow;
  return rowToPointer(inserted);
}

export function listResourcePointers(options: { app?: string; limit?: number } = {}): ResourcePointer[] {
  const db = openMemoryDb();
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const rows = (options.app
    ? db.prepare('SELECT * FROM resource_pointers WHERE app = ? ORDER BY last_seen_at DESC LIMIT ?').all(options.app, limit)
    : db.prepare('SELECT * FROM resource_pointers ORDER BY last_seen_at DESC LIMIT ?').all(limit)) as ResourcePointerRow[];
  return rows.map(rowToPointer);
}

export function countResourcePointers(): number {
  try {
    const db = openMemoryDb();
    return (db.prepare('SELECT COUNT(*) AS c FROM resource_pointers').get() as { c: number }).c;
  } catch {
    return 0;
  }
}

// Lexical relevance of a resource to the current objective, in [0,1]. Coarse
// token overlap over name + whats_here + when_to_use — enough to promote the
// on-objective resources into the limited prompt slots. Synchronous + cheap.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'use', 'when', 'where', 'data', 'your']);
function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}
function relevance(objective: Set<string>, p: ResourcePointer): number {
  if (objective.size === 0) return 0;
  const t = tokens(`${p.name} ${p.whatsHere ?? ''} ${p.whenToUse ?? ''} ${p.app}`);
  if (t.size === 0) return 0;
  let hits = 0;
  for (const tok of t) if (objective.has(tok)) hits += 1;
  return hits / t.size;
}

const SOURCE_MAP_LINE_MAX = 180;
const SOURCE_MAP_BLOCK_MAX = 1400;

/**
 * Render the landscape as a compact, grouped-by-app block for the per-turn
 * context. Pointer-only (where + what + when), hard token-budget, objective-
 * scoped (on-objective resources first). Returns '' when off or empty.
 */
export function renderSourceMapForContext(limit = 24, maxChars = SOURCE_MAP_BLOCK_MAX, objective?: string): string {
  if (!isSourceMapEnabled()) return '';
  let pointers: ResourcePointer[];
  try {
    pointers = listResourcePointers({ limit: 200 });
  } catch {
    return '';
  }
  if (pointers.length === 0) return '';

  const obj = tokens(objective?.trim() ?? '');
  // Rank: objective relevance first (when an objective exists), then recency.
  const ranked = [...pointers].sort((a, b) => {
    if (obj.size > 0) {
      const rd = relevance(obj, b) - relevance(obj, a);
      if (Math.abs(rd) > 0.001) return rd;
    }
    return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
  }).slice(0, limit);

  const header = 'Data landscape — where the user\'s data lives. Navigate straight to the relevant source (fetch its content on demand); don\'t rediscover.';
  const clip = (s: string): string => (s.length <= SOURCE_MAP_LINE_MAX ? s : `${s.slice(0, SOURCE_MAP_LINE_MAX - 1)}…`);

  // Group by app for readability, preserving the ranked order across groups.
  const byApp = new Map<string, ResourcePointer[]>();
  for (const p of ranked) {
    const arr = byApp.get(p.app) ?? [];
    arr.push(p);
    byApp.set(p.app, arr);
  }

  const lines: string[] = [];
  let used = header.length;
  outer: for (const [app, group] of byApp) {
    const appLine = `${app}:`;
    if (used + 1 + appLine.length > maxChars) break;
    lines.push(appLine);
    used += 1 + appLine.length;
    for (const p of group) {
      const what = p.whatsHere ? ` — ${p.whatsHere}` : '';
      const when = p.whenToUse ? ` (use for: ${p.whenToUse})` : '';
      const line = clip(`  - ${p.kind} \`${p.name}\`${what}${when}`);
      if (used + 1 + line.length > maxChars) break outer;
      lines.push(line);
      used += 1 + line.length;
    }
  }
  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}
