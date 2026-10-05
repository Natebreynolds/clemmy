/**
 * A file a conversation's own work saved, shown beside the conversation.
 *
 * A saved-file card knows only the file's name and the folder it lies in. The
 * file is found among the files the record says this conversation wrote (its
 * branches and its workers included), wherever they were written: Clem's own
 * folder or a project folder. Nothing else is reachable through it: no other
 * conversation's files, no path the caller names, nothing the security rules
 * call sensitive. More than one match is no match, so a card never shows the
 * wrong file. Nothing here writes.
 */
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFileDeliverablesForSessions } from '../memory/deliverable-index.js';
import { isSensitivePath } from '../runtime/security.js';
import { listEvents, openEventLog } from '../runtime/harness/eventlog.js';

export type SessionFileKind = 'markdown' | 'text' | 'image' | 'other';

export interface SessionFileView {
  name: string;
  folder: string;
  /** Where it lies, with the home folder shortened to ~. */
  place: string;
  kind: SessionFileKind;
  bytes: number;
  modifiedAt: string;
  /** Text and markdown only: the file's text, up to the shown limit. */
  text?: string;
  truncated?: boolean;
  /** Whether the Mac can open it in the app made for its type. */
  openable: boolean;
}

/** Text shown in the panel stops here; the file itself is unchanged. */
export const LARGEST_SHOWN_TEXT_BYTES = 1_000_000;
export const LARGEST_SHOWN_IMAGE_BYTES = 15_000_000;

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXT = new Set(['.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.log', '.xml', '.html', '.htm', '.css',
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

/** The exact file behind a card, or null when none or more than one answers. */
export function fileSavedBySession(sessionId: string, name: string, folder?: string | null): string | null {
  const session = sessionId.trim();
  const wanted = name.trim();
  const within = (folder ?? '').trim();
  if (!session || !wanted || wanted.includes('/') || wanted.includes('\\')) return null;
  const matches = new Set<string>();
  try {
    for (const row of listFileDeliverablesForSessions(relatedSessions(session), 400)) {
      if (path.basename(row.target) !== wanted || (within && path.basename(path.dirname(row.target)) !== within)) continue;
      // The recorded file itself, never a link to some other file.
      try { if (lstatSync(row.target).isSymbolicLink()) continue; } catch { continue; }
      let file: string;
      try { file = realpathSync(row.target); } catch { continue; }
      if (isSensitivePath(file) || isSensitivePath(row.target)) continue;
      try { if (!statSync(file).isFile()) continue; } catch { continue; }
      matches.add(file);
    }
  } catch {
    return null;
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function readStart(file: string, bytes: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** What the panel shows for one saved file. */
export function readSessionFile(sessionId: string, name: string, folder?: string | null):
  { ok: true; view: SessionFileView; file: string } | { ok: false; reason: 'file_not_found' } {
  const file = fileSavedBySession(sessionId, name, folder);
  if (!file) return { ok: false, reason: 'file_not_found' };
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(file); } catch { return { ok: false, reason: 'file_not_found' }; }
  let kind = kindOf(file);
  const view: SessionFileView = {
    name: path.basename(file), folder: path.basename(path.dirname(file)), place: place(file),
    kind, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), openable: OPENABLE.has(path.extname(file).toLowerCase()),
  };
  if (kind === 'markdown' || kind === 'text') {
    const start = readStart(file, Math.min(stat.size, LARGEST_SHOWN_TEXT_BYTES));
    // A file named as text that holds binary data is shown as a file, not as text.
    if (start.subarray(0, 8192).includes(0)) kind = 'other';
    else {
      view.text = start.toString('utf8');
      if (stat.size > LARGEST_SHOWN_TEXT_BYTES) view.truncated = true;
    }
  }
  if (kind === 'image' && stat.size > LARGEST_SHOWN_IMAGE_BYTES) kind = 'other';
  view.kind = kind;
  return { ok: true, view, file };
}
