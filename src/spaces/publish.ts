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
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import path from 'node:path';
import { isValidSpaceSlug, resolveInSpace, resolveSpaceDir, spaceStore } from './store.js';
import { appendAudit, withSourceRecordAliases } from './data-store.js';
import { injectWorkspaceBootstrap } from './view-html.js';
import { clemViewDesignLayer } from './view-design-layer.js';
import { withWorkspaceSnapshotRead } from './workspace-snapshot.js';

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
  // `window.__SPACE_DATA__` is the synchronous seed the live route also plants,
  // so a view that renders straight from the global keeps working once exported.
  return `<script>(function(){var D=JSON.parse(${D});window.__SPACE_DATA__=D;`
    + `function frozen(name){return async function(){throw new Error('This is a published snapshot of the "'+${S}+'" workspace (exported '+${T}+') — '+name+' is disabled. Open the live workspace in Clementine to act.');};}`
    + `window.clem={slug:${S},snapshot:true,publishedAt:${T},`
    + `data:async function(){return D;},`
    + `refresh:async function(){return {ok:true,snapshot:true,data:D};},`
    + `note:frozen('notes'),compose:frozen('compose'),action:frozen('actions')`
    + `};var K=window.__clemKit;if(K){window.clem.fmt=K.fmt;window.clem.ui=K.ui;window.clem.sources=K.sources;window.clem.theme=K.theme;window.clem.pick=K.pick;window.clem.rows=K.rows;window.clem.mail=K.mail;try{delete window.__clemKit;}catch(_){}}`
    + `})();</script>`;
}

function countRows(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return null;
}

class PublishCaptureError extends Error {}

function nodeExists(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function directNode(file: string, realRoot: string, relative: string, directory: boolean) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new PublishCaptureError(`Cannot publish "${relative}": it must be a direct ${directory ? 'directory' : 'regular file'} without links.`);
  }
  const resolved = path.relative(realRoot, realpathSync(file));
  if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
    throw new PublishCaptureError(`Cannot publish "${relative}": it escaped the Workspace snapshot.`);
  }
  return stat;
}

function openValidatedFile(file: string, realRoot: string, relative: string, expected?: Stats): { fd: number; stat: Stats } {
  const before = directNode(file, realRoot, relative, false);
  if (expected && (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size
    || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs)) {
    throw new PublishCaptureError(`Cannot publish "${relative}": the prevalidated snapshot file changed.`);
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new PublishCaptureError(`Cannot publish "${relative}": the snapshot file changed while opening.`);
    }
    return { fd, stat: opened };
  } catch (error) { closeSync(fd); throw error; }
}

function validateRetainedFile(file: string, realRoot: string, relative: string, fd: number, opened: Stats): void {
  const after = directNode(file, realRoot, relative, false);
  const retained = fstatSync(fd);
  if (after.dev !== opened.dev || after.ino !== opened.ino || retained.size !== opened.size
    || retained.mtimeMs !== opened.mtimeMs || retained.ctimeMs !== opened.ctimeMs
    || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
    throw new PublishCaptureError(`Cannot publish "${relative}": the snapshot file changed during capture.`);
  }
}

function captureFile(file: string, realRoot: string, relative: string, expected?: Stats): Buffer {
  const { fd, stat } = openValidatedFile(file, realRoot, relative, expected);
  try {
    const bytes = readFileSync(fd);
    validateRetainedFile(file, realRoot, relative, fd, stat);
    if (bytes.length !== stat.size) throw new PublishCaptureError(`Cannot publish "${relative}": the file capture is incomplete.`);
    return bytes;
  } finally { closeSync(fd); }
}

function copyValidatedAsset(file: string, destination: string, realRoot: string, relative: string, expected: Stats, buffer: Buffer): number {
  const { fd, stat } = openValidatedFile(file, realRoot, relative, expected);
  let output: number | undefined;
  try {
    output = openSync(destination, 'wx', stat.mode & 0o777);
    let copied = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        const size = writeSync(output, buffer, written, count - written);
        if (size === 0) throw new PublishCaptureError(`Could not write the captured "${relative}" asset.`);
        written += size;
      }
      copied += count;
    }
    validateRetainedFile(file, realRoot, relative, fd, stat);
    if (copied !== stat.size) throw new PublishCaptureError(`Cannot publish "${relative}": the asset capture is incomplete.`);
    return copied;
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(fd);
  }
}

let captureObserverForTests: (() => void) | null = null;
export function _setPublishCaptureObserverForTests(observer: (() => void) | null): void {
  captureObserverForTests = observer;
}

/** Capture direct view files under the cooperative Space snapshot owner. */
function prevalidateViewFiles(viewDir: string): Map<string, Stats> {
  const root = realpathSync(viewDir);
  const out = new Map<string, Stats>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(abs);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directNode(abs, root, `view/${r}`, true);
        walk(abs, r);
      } else {
        const { fd, stat: opened } = openValidatedFile(abs, root, `view/${r}`);
        closeSync(fd);
        out.set(r, opened);
      }
    }
  };
  walk(viewDir, '');
  return out;
}

export function buildPublishSnapshot(slug: string): PublishSnapshotResult {
  if (!isValidSpaceSlug(slug)) return { ok: false, error: `invalid workspace slug "${slug}"` };
  try {
    const spaceDir = resolveSpaceDir(slug);
    if (!nodeExists(spaceDir)) throw new PublishCaptureError(`no workspace named "${slug}"`);
    // Reject a linked root before the owner can inspect a recovery journal.
    directNode(spaceDir, realpathSync(path.dirname(spaceDir)), 'Workspace', true);
    return withWorkspaceSnapshotRead(slug, () => buildPublishSnapshotUnderOwner(slug, spaceDir));
  } catch (error) {
    return { ok: false, error: error instanceof PublishCaptureError ? error.message
      : 'Could not capture the Workspace snapshot. Verify its direct files and saved dataset before publishing.' };
  }
}

function buildPublishSnapshotUnderOwner(slug: string, spaceDir: string): PublishSnapshotResult {
      directNode(spaceDir, realpathSync(path.dirname(spaceDir)), 'Workspace', true);
      const root = realpathSync(spaceDir);
      const manifest = resolveInSpace(slug, 'space.json');
      if (!nodeExists(manifest)) throw new PublishCaptureError(`no workspace named "${slug}"`);
      captureFile(manifest, root, 'space.json');
      const rec = spaceStore.get(slug);
      if (!rec) throw new PublishCaptureError(`no workspace named "${slug}"`);
      if (rec.status === 'archived') throw new PublishCaptureError(`workspace "${slug}" is archived`);
      const viewDir = resolveInSpace(slug, 'view');
      directNode(viewDir, root, 'view', true);
      const dataFile = resolveInSpace(slug, 'data.json');
      let raw: unknown = {};
      if (nodeExists(dataFile)) {
        const data = captureFile(dataFile, root, 'data.json');
        try { raw = JSON.parse(data.toString('utf8')); } catch {
          throw new PublishCaptureError('Cannot publish "data.json": the saved dataset is corrupt. Restore it before publishing.');
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new PublishCaptureError('Cannot publish "data.json": the saved dataset must be a JSON object.');
        }
      }
      captureObserverForTests?.();
      const capturedFiles = prevalidateViewFiles(viewDir);
      if (!capturedFiles.has('index.html')) throw new PublishCaptureError(`workspace "${slug}" has no view/index.html to publish`);
      const publishDir = path.join(spaceDir, 'publish');
      if (nodeExists(publishDir)) directNode(publishDir, root, 'publish', true);

  // Inline the dataset, minus reserved provenance keys (may reference local
  // paths / runner error internals — not for public eyes).
  const dataset = Object.create(null) as Record<string, unknown>;
  const rowsBySource: Record<string, number | null> = {};
  const aliased = withSourceRecordAliases(raw);
  if (aliased && typeof aliased === 'object' && !Array.isArray(aliased)) {
    for (const [key, value] of Object.entries(aliased as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      dataset[key] = value;
      rowsBySource[key] = countRows(value);
    }
  }
  const publishedAt = new Date().toISOString();
  const bridge = staticClemBridge(slug, JSON.stringify(dataset), publishedAt);

  const stamp = publishedAt.replace(/[:.]/g, '-');
  const exportDir = path.join(spaceDir, 'publish', stamp);
  try {
    directNode(spaceDir, realpathSync(path.dirname(spaceDir)), 'Workspace', true);
    const publishDir = path.dirname(exportDir);
    if (!nodeExists(publishDir)) mkdirSync(publishDir);
    directNode(publishDir, root, 'publish', true);
    // Exclusive creation also refuses a pre-existing linked export and keeps
    // prior snapshots immutable if two publishers share a clock timestamp.
    mkdirSync(exportDir);
  } catch (error) {
    return { ok: false, error: error instanceof PublishCaptureError ? error.message
      : 'Could not create a new publish directory. No static snapshot was completed.' };
  }

  const files = [...capturedFiles.keys()];
  const viewRoot = realpathSync(viewDir);
  const copyBuffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  for (const rel of files) {
    const expected = capturedFiles.get(rel)!;
    const source = path.join(viewDir, rel);
    const dst = path.join(exportDir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.html?$/i.test(rel)) {
      const html = captureFile(source, viewRoot, `view/${rel}`, expected).toString('utf-8');
      const marker = `<meta name="clementine-snapshot" content="${publishedAt}">`;
      // The live route and static export use the same document-start injection
      // rule: clem exists before any authored inline or external script runs.
      const injected = injectWorkspaceBootstrap(html, clemViewDesignLayer() + bridge + marker);
      writeFileSync(dst, injected, 'utf-8');
      bytes += Buffer.byteLength(injected);
    } else {
      bytes += copyValidatedAsset(source, dst, viewRoot, `view/${rel}`, expected, copyBuffer);
    }
  }

  try {
    appendAudit(slug, { method: 'PUBLISH', path: `/publish/${stamp}`, outcome: 'ok', bytes });
  } catch { /* audit is best-effort */ }
  return { ok: true, dir: exportDir, files, bytes, rowsBySource };
}
