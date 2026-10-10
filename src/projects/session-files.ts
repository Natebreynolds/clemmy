/**
 * A file a conversation's own work saved, shown beside the conversation.
 *
 * A saved-file card knows the file's name and folder, or its opaque file id. The
 * file is found among the files the record says this conversation wrote (its
 * branches and its workers included), wherever they were written: Clem's own
 * folder or a project folder. Nothing else is reachable through it: no other
 * conversation's files, no path the caller names, nothing the security rules
 * call sensitive. More than one match is no match, so a card never shows the
 * wrong file. Nothing here writes.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, serialize, type DefaultTreeAdapterTypes as Html } from 'parse5';
import { listFileDeliverablesForSessions } from '../memory/deliverable-index.js';
import { isSensitivePath } from '../runtime/security.js';
import { listEvents, openEventLog } from '../runtime/harness/eventlog.js';

export type SessionFileKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'other';

export interface SessionFileView {
  /** Stable identity of this recorded path, not a historical file revision. */
  fileId: string;
  name: string;
  folder: string;
  /** Where it lies, with the home folder shortened to ~. */
  place: string;
  kind: SessionFileKind;
  bytes: number;
  modifiedAt: string;
  /** Text, markdown and HTML source, up to the shown limit. */
  text?: string;
  /** Static HTML preview with authored navigation removed. Original source is
   *  kept in text; preview still requires the sandbox and content policy. */
  previewHtml?: string;
  truncated?: boolean;
  /** Whether the Mac can open it in the app made for its type. */
  openable: boolean;
}

/** Text shown in the panel stops here; the file itself is unchanged. */
export const LARGEST_SHOWN_TEXT_BYTES = 1_000_000;
export const LARGEST_SHOWN_IMAGE_BYTES = 15_000_000;
/** Preview/download reads are bounded even when a saved file keeps growing. */
export const LARGEST_SESSION_FILE_CONTENT_BYTES = 25 * 1024 * 1024;

/** Saved HTML is a static document. Clients using srcDoc must apply this policy
 * there too: a fetched response's CSP does not travel with its string content. */
export const SESSION_FILE_CONTENT_POLICY = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const PREVIEW_REMOVED_ELEMENTS = new Set([
  'meta', 'base', 'link', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe',
  // SVG animation can restore a removed href without running JavaScript.
  'animate', 'animatemotion', 'animatetransform', 'set', 'discard',
]);
const PREVIEW_REMOVED_ATTRIBUTES = new Set(['action', 'formaction', 'target', 'formtarget', 'ping', 'download', 'srcdoc', 'autofocus']);

/** Parse as the script-disabled frame does, including noscript and template
 * contents. CSP alone does not stop meta refresh or a frame's own link
 * navigation. Remove those capabilities while preserving static formatting. */
export function sessionFileHtmlPreview(source: string): string {
  const document = parse(source, { scriptingEnabled: false });
  const pending: Html.ParentNode[] = [document];
  while (pending.length) {
    const parent = pending.pop()!;
    parent.childNodes = parent.childNodes.filter(node => {
      if (!('tagName' in node)) return true;
      const tag = node.tagName.toLowerCase();
      if (PREVIEW_REMOVED_ELEMENTS.has(tag)) return false;
      node.attrs = node.attrs.filter(attribute => {
        const name = attribute.name.toLowerCase();
        // href also navigates on legacy MathML elements. Keep only inert SVG
        // resource references, not a namespace-specific list of link tags.
        const safeResourceHref = node.namespaceURI === 'http://www.w3.org/2000/svg'
          && ((tag === 'use' && attribute.value.trim().startsWith('#'))
            || (tag === 'image' && /^data:image\//i.test(attribute.value.trim())));
        return !name.startsWith('on') && !PREVIEW_REMOVED_ATTRIBUTES.has(name)
          && (!(name === 'href' || name === 'xlink:href') || safeResourceHref);
      });
      // An inert form keeps its layout but cannot submit to an implicit URL.
      if (tag === 'form') { node.tagName = 'div'; node.nodeName = 'div'; }
      pending.push(node);
      if ('content' in node) pending.push((node as Html.Template).content);
      return true;
    });
  }
  return serialize(document);
}

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXT = new Set(['.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.log', '.xml', '.css',
  '.js', '.mjs', '.ts', '.tsx', '.py', '.sql', '.toml']);
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
/** Documents the Mac may open in their own app. Never a script, an app or an
 * installer: opening one of those runs it. */
const OPENABLE = new Set([...MARKDOWN, '.txt', '.csv', '.tsv', '.json', '.html', '.htm', '.pdf', '.rtf',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pages', '.numbers', '.key', ...Object.keys(IMAGE_TYPES)]);

function kindOf(file: string): SessionFileKind {
  const ext = path.extname(file).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (TEXT.has(ext)) return 'text';
  if (ext in IMAGE_TYPES) return 'image';
  return 'other';
}

export function sessionFileImageType(file: string): string | null {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ?? null;
}

function place(file: string): string {
  const home = os.homedir();
  const dir = path.dirname(file);
  return home && (dir === home || dir.startsWith(`${home}${path.sep}`)) ? `~${dir.slice(home.length)}` : dir;
}

/** The conversation, the conversation it branched from, its other branches,
 * and the workers any of them started. */
function relatedSessions(sessionId: string): string[] {
  const db = openEventLog();
  const row = db.prepare("SELECT json_extract(metadata_json, '$.channelId') AS channel FROM sessions WHERE id = ?")
    .get(sessionId) as { channel: unknown } | undefined;
  const root = typeof row?.channel === 'string' && row.channel.trim() ? row.channel.trim() : sessionId;
  const sessions = new Set([sessionId, root]);
  for (const branch of db.prepare("SELECT id FROM sessions WHERE json_extract(metadata_json, '$.channelId') = ? LIMIT 50")
    .all(root) as Array<{ id: string }>) sessions.add(branch.id);
  for (const session of [...sessions]) {
    for (const event of listEvents(session, { types: ['worker_started'] })) {
      const child = (event.data as { childSessionId?: unknown }).childSessionId;
      if (event.role === 'system' && typeof child === 'string' && child.trim()) sessions.add(child.trim());
    }
  }
  return [...sessions];
}

function fileId(file: string): string {
  return `sf_${createHash('sha256').update(file).digest('hex')}`;
}

/** Only canonical, non-sensitive, regular files recorded by this conversation. */
function savedFiles(sessionId: string): string[] {
  const session = sessionId.trim();
  if (!session) return [];
  const matches = new Set<string>();
  try {
    for (const row of listFileDeliverablesForSessions(relatedSessions(session), 400)) {
      // The recorded file itself, never a link to some other file.
      try { if (lstatSync(row.target).isSymbolicLink()) continue; } catch { continue; }
      let file: string;
      try { file = realpathSync(row.target); } catch { continue; }
      if (isSensitivePath(file) || isSensitivePath(row.target)) continue;
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      matches.add(file);
    }
  } catch {
    return [];
  }
  return [...matches];
}

/** An id disambiguates duplicate names but never expands conversation access.
 * A supplied invalid id fails closed instead of falling back to a name. */
export function fileSavedBySession(sessionId: string, name: string, folder?: string | null, id?: string | null): string | null {
  const wanted = name.trim();
  const within = (folder ?? '').trim();
  const wantedId = (id ?? '').trim();
  if ((!wanted && !wantedId) || wanted.includes('/') || wanted.includes('\\')) return null;
  const matches = savedFiles(sessionId).filter(file =>
    (!wantedId || fileId(file) === wantedId)
    && (!wanted || path.basename(file) === wanted)
    && (!within || path.basename(path.dirname(file)) === within));
  return matches.length === 1 ? matches[0]! : null;
}

function readStart(file: string, bytes: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || realpathSync(file) !== file) throw new Error('File changed');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function fileView(file: string, stat = statSync(file)): SessionFileView {
  return {
    fileId: fileId(file), name: path.basename(file), folder: path.basename(path.dirname(file)), place: place(file),
    kind: kindOf(file), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), openable: OPENABLE.has(path.extname(file).toLowerCase()),
  };
}

/** Available saved files within the existing record limit, newest first. Metadata describes the
 * current file on disk; it is not a snapshot of the original saved revision. */
export function listSessionFiles(sessionId: string): SessionFileView[] {
  return savedFiles(sessionId).flatMap(file => {
    try { return [fileView(file)]; } catch { return []; }
  });
}

/** What the panel shows for one saved file. */
export function readSessionFile(sessionId: string, name: string, folder?: string | null, id?: string | null):
  { ok: true; view: SessionFileView; file: string } | { ok: false; reason: 'file_not_found' } {
  const file = fileSavedBySession(sessionId, name, folder, id);
  if (!file) return { ok: false, reason: 'file_not_found' };
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(file); } catch { return { ok: false, reason: 'file_not_found' }; }
  let kind = kindOf(file);
  const view = fileView(file, stat);
  if (kind === 'markdown' || kind === 'text' || kind === 'html') {
    let start: Buffer;
    try { start = readStart(file, Math.min(stat.size, LARGEST_SHOWN_TEXT_BYTES)); }
    catch { return { ok: false, reason: 'file_not_found' }; }
    // A file named as text that holds binary data is shown as a file, not as text.
    if (start.subarray(0, 8192).includes(0)) kind = 'other';
    else {
      view.text = start.toString('utf8');
      if (kind === 'html') view.previewHtml = sessionFileHtmlPreview(view.text);
      if (stat.size > LARGEST_SHOWN_TEXT_BYTES) view.truncated = true;
    }
  }
  if (kind === 'image' && stat.size > LARGEST_SHOWN_IMAGE_BYTES) kind = 'other';
  view.kind = kind;
  return { ok: true, view, file };
}

/** Authenticated surfaces fetch the bytes before creating their own local
 * preview URL. Unknown types are download-only, never interpreted as HTML. */
export function readSessionFileContent(sessionId: string, name: string, folder?: string | null, id?: string | null):
  { ok: true; view: SessionFileView; content: Buffer; mimeType: string } |
  { ok: false; reason: 'file_not_found' | 'file_too_large' } {
  const file = fileSavedBySession(sessionId, name, folder, id);
  if (!file) return { ok: false, reason: 'file_not_found' };
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || realpathSync(file) !== file) return { ok: false, reason: 'file_not_found' };
    if (stat.size > LARGEST_SESSION_FILE_CONTENT_BYTES) return { ok: false, reason: 'file_too_large' };
    const buffer = Buffer.alloc(stat.size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!read) break;
      bytes += read;
    }
    if (fstatSync(fd).size > LARGEST_SESSION_FILE_CONTENT_BYTES) return { ok: false, reason: 'file_too_large' };
    const content = buffer.subarray(0, bytes);
    const view = fileView(file, stat);
    if (['markdown', 'text', 'html'].includes(view.kind) && content.subarray(0, 8192).includes(0)) view.kind = 'other';
    const mimeType = view.kind === 'html' ? 'text/html; charset=utf-8'
      : view.kind === 'pdf' ? 'application/pdf'
        : view.kind === 'image' ? sessionFileImageType(file)!
          : view.kind === 'markdown' || view.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    return { ok: true, view, content, mimeType };
  } catch {
    return { ok: false, reason: 'file_not_found' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
