/**
 * Workspace publishing — export a Workspace as a STATIC, share-ready snapshot.
 *
 * The live Workspace is loopback-only by design (auth-gated, same-origin data
 * plane, gated actions). Publishing produces the SHAREABLE counterpart: a
 * self-contained directory the user (or Clem, via her normal deploy flow +
 * approval gates) can host anywhere — the answer to "send my client the live
 * dashboard" without ever exposing the daemon.
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
  const S = JSON.stringify(slug);
  const T = JSON.stringify(publishedAt);
  return `<script>(function(){var D=${datasetJson};`
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
  const dataset: Record<string, unknown> = {};
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
      const withMarker = html.includes('<head>') ? html.replace('<head>', `<head>${marker}`) : marker + html;
      const injected = withMarker.includes('</body>')
        ? withMarker.replace('</body>', `${bridge}</body>`)
        : withMarker + bridge;
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
