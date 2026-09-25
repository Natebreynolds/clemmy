/**
 * The app behind an external write, for a label in the chat: its name and web
 * address, read from the toolkit catalog the daemon already caches (no SDK,
 * no network). A write's provider action (the toolkit slug, then the action)
 * is matched to the longest catalog slug it begins with, so a toolkit whose slug
 * has its own underscores still resolves. No match names no app: this is a
 * display label only and never decides what a write is or may do.
 */
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { BASE_DIR } from '../../config.js';

export interface ToolkitIdentity { name: string; url?: string }

interface CatalogEntry { slug?: unknown; name?: unknown; appUrl?: unknown }

const CATALOG_CACHE_FILE = path.join(BASE_DIR, 'state', 'composio-catalog-cache.json');

let loaded: { mtimeMs: number; bySlug: Map<string, ToolkitIdentity>; slugs: string[] } | null = null;
let override: CatalogEntry[] | null = null;

function index(entries: CatalogEntry[]): { bySlug: Map<string, ToolkitIdentity>; slugs: string[] } {
  const bySlug = new Map<string, ToolkitIdentity>();
  for (const entry of entries) {
    const slug = typeof entry.slug === 'string' ? entry.slug.trim().toLowerCase() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!slug || !name) continue;
    const url = typeof entry.appUrl === 'string' && /^https:\/\//i.test(entry.appUrl) ? entry.appUrl : undefined;
    bySlug.set(slug, { name, ...(url ? { url } : {}) });
  }
  return { bySlug, slugs: [...bySlug.keys()].sort((a, b) => b.length - a.length) };
}

function catalog(): { bySlug: Map<string, ToolkitIdentity>; slugs: string[] } | null {
  if (override) return index(override);
  try {
    const { mtimeMs } = statSync(CATALOG_CACHE_FILE);
    if (loaded && loaded.mtimeMs === mtimeMs) return loaded;
    const parsed = JSON.parse(readFileSync(CATALOG_CACHE_FILE, 'utf-8')) as { data?: unknown };
    const entries = Array.isArray(parsed.data) ? parsed.data as CatalogEntry[] : [];
    loaded = { mtimeMs, ...index(entries) };
    return loaded;
  } catch {
    return null;
  }
}

/** The app a provider action belongs to, or null when the catalog has none. */
export function appForWriteAction(action: string): ToolkitIdentity | null {
  const key = action.trim().toLowerCase();
  if (!key) return null;
  const found = catalog();
  if (!found) return null;
  for (const slug of found.slugs) {
    if (key.startsWith(`${slug}_`)) return found.bySlug.get(slug) ?? null;
  }
  return null;
}

/** Test seam: a fixed catalog instead of the cache file; null restores it. */
export function __setToolkitCatalogForTests(entries: CatalogEntry[] | null): void {
  override = entries;
  loaded = null;
}
