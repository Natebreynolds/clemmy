/**
 * Workspace publishing — export a Workspace as a STATIC, share-ready snapshot.
 *
 * The live Workspace is loopback-only by design (opaque authored view,
 * parent-owned authenticated data plane, gated actions). Publishing produces
 * the SHAREABLE counterpart: a self-contained directory the user (or Clem, via
 * her normal deploy flow + approval gates) can host anywhere — the answer to
 * "send my client the live dashboard" without ever exposing the daemon.
 *
 * Safety posture (BINDING):
 *  - SNAPSHOT-ONLY. The dataset is INLINED at export time; there is no data
 *    plane, no credentials, no daemon URL in the output. What you publish is
 *    exactly what anyone with the link can read — the tool text tells the
 *    model to say so.
 *  - Actions/refresh/compose/note are replaced by a static bridge shim that
 *    throws a clear "published snapshot" error, so a view authored against
 *    `window.clem` renders identically but cannot act.
 *  - `_meta` (runner provenance/errors — may reference local paths) is
 *    stripped from the inlined dataset.
 *  - The export lands under spaces/<slug>/publish/<ts>/ which is NEVER served
 *    by the view route (only the view/ subtree is).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidSpaceSlug, resolveInSpace, resolveSpaceDir, spaceStore } from './store.js';
import { readData, appendAudit } from './data-store.js';
import { injectWorkspaceBootstrap } from './view-html.js';

export interface PublishSnapshotOk {
  ok: true;
  dir: string;
  files: string[];
  bytes: number;
  rowsBySource: Record<string, number | null>;
}
export interface PublishSnapshotError { ok: false; error: string }
export type PublishSnapshotResult = PublishSnapshotOk | PublishSnapshotError;

/** The static stand-in for the live `window.clem` bridge. Same surface, so a
 *  view authored against clem.* renders identically — but data() resolves to
 *  the INLINED dataset and every side-effecting call throws a clear notice. */
function staticClemBridge(slug: string, datasetJson: string, publishedAt: string): string {
  const inlineJson = (value: unknown): string => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Workspace snapshot value is not JSON-serializable');
    // HTML parses classic-script contents before JavaScript does. Escaping every
    // "<" prevents external strings such as "</script><script>…" from ending
    // this element; the line separators keep the source portable to older JS
    // parsers. JSON.parse preserves the exact JSON shape (including "__proto__"
    // as an own key) instead of applying object-literal semantics.
    return json
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  };
  const S = inlineJson(slug);
  const T = inlineJson(publishedAt);
  const D = inlineJson(datasetJson);
  return `<script>(function(){var D=JSON.parse(${D});`
    + `function frozen(name){return async function(){throw new Error('This is a published snapshot of the "'+${S}+'" workspace (exported '+${T}+') — '+name+' is disabled. Open the live workspace in Clementine to act.');};}`
    + `window.clem={slug:${S},snapshot:true,publishedAt:${T},`
    + `data:async function(){return D;},`
    + `refresh:async function(){return {ok:true,snapshot:true,data:D};},`
    + `note:frozen('notes'),compose:frozen('compose'),action:frozen('actions')`
    + `};})();</script>`;
}

function countRows(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
}

/** Everything under view/ except other publish output; returns rel paths. */
function listViewFiles(viewDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(viewDir, '');
  return out;
}

export function buildPublishSnapshot(slug: string): PublishSnapshotResult {
  if (!isValidSpaceSlug(slug)) return { ok: false, error: `invalid workspace slug "${slug}"` };
  const rec = spaceStore.get(slug);
  if (!rec) return { ok: false, error: `no workspace named "${slug}"` };
  if (rec.status === 'archived') return { ok: false, error: `workspace "${slug}" is archived` };

  let viewDir: string;
  try {
    viewDir = resolveInSpace(slug, 'view');
  } catch {
    return { ok: false, error: 'could not resolve the view directory' };
  }
  if (!existsSync(path.join(viewDir, 'index.html'))) {
    return { ok: false, error: `workspace "${slug}" has no view/index.html to publish` };
  }

  // Inline the dataset, minus reserved provenance keys (may reference local
  // paths / runner error internals — not for public eyes).
  const raw = readData(slug);
  const dataset = Object.create(null) as Record<string, unknown>;
  const rowsBySource: Record<string, number | null> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      dataset[key] = value;
      rowsBySource[key] = countRows(value);
    }
  }
  const publishedAt = new Date().toISOString();
  const bridge = staticClemBridge(slug, JSON.stringify(dataset), publishedAt);

  const stamp = publishedAt.replace(/[:.]/g, '-');
  const exportDir = path.join(resolveSpaceDir(slug), 'publish', stamp);
  mkdirSync(exportDir, { recursive: true });

  const files = listViewFiles(viewDir);
  let bytes = 0;
  for (const rel of files) {
    const src = path.join(viewDir, rel);
    const dst = path.join(exportDir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.html?$/i.test(rel)) {
      const html = readFileSync(src, 'utf-8');
      const marker = `<meta name="clementine-snapshot" content="${publishedAt}">`;
      // The live route and static export use the same document-start injection
      // rule: clem exists before any authored inline or external script runs.
      const injected = injectWorkspaceBootstrap(html, bridge + marker);
      writeFileSync(dst, injected, 'utf-8');
      bytes += Buffer.byteLength(injected);
    } else {
      cpSync(src, dst);
      bytes += statSync(dst).size;
    }
  }

  try {
    appendAudit(slug, { method: 'PUBLISH', path: `/publish/${stamp}`, outcome: 'ok', bytes });
  } catch { /* audit is best-effort */ }
  return { ok: true, dir: exportDir, files, bytes, rowsBySource };
}
