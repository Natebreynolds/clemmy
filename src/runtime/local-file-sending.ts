import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { isSensitivePath } from './security.js';
import { BUILTIN_STAGED_FILE_DENY_SEGMENTS, SECRET_BASENAME_RE } from '../integrations/composio/staged-file-blob-store.js';

/**
 * A file on this computer that a tool call will send somewhere else: an
 * attachment for a connected app, file content for an MCP server, an upload
 * in a command. Every lane runs the same check before anything leaves, and
 * the card names the file the same way. Nothing here reads a provider's
 * name: the tool's own schema says which parameter takes a file.
 */
export interface LocalFileToSend {
  /** The path as the call gave it. */
  requested: string;
  /** The real path that will be read. */
  path: string;
  name: string;
  /** The folder it sits in, by name only. */
  folder: string;
  bytes: number;
  mimetype: string;
}

export type LocalFileSendRefusalCode =
  | 'not_a_local_path'
  | 'missing'
  | 'not_a_file'
  | 'outside_allowed_folders'
  | 'sensitive'
  | 'too_large'
  | 'unreadable';

/** The file cannot be sent; nothing left the machine. The message is for the model and the owner. */
export class LocalFileSendRefusal extends Error {
  constructor(readonly code: LocalFileSendRefusalCode, message: string) {
    super(message);
    this.name = 'LocalFileSendRefusal';
  }
}

/** What an upload or inline file may weigh. Above it the call is refused before anything is sent. */
export const LOCAL_FILE_SEND_MAX_BYTES = 100 * 1024 * 1024;

const MIMETYPES: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', json: 'application/json',
  ics: 'text/calendar', vcf: 'text/vcard', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
});

/** The media type a file's extension names, or a generic binary type. */
export function localFileMimetype(name: string): string {
  const extension = path.extname(name).slice(1).toLowerCase();
  return MIMETYPES[extension] ?? 'application/octet-stream';
}

/** A string that names a file on this computer: absolute (POSIX or a
 * Windows drive) or under the home folder. A URL or a bare name is not. */
export function looksLikeLocalFilePath(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 4096 || /[\u0000\n\r]/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  return text.startsWith('/') || text === '~' || text.startsWith('~/') || text.startsWith('~\\')
    || /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function inside(parent: string, child: string): boolean {
  const a = caseInsensitive ? parent.toLowerCase() : parent;
  const b = caseInsensitive ? child.toLowerCase() : child;
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrResolved(entry: string): string {
  const resolved = path.resolve(expandHome(entry));
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

/** Where a file may be sent from: the owner's home folder and the work
 * folders they added. Clem's own stores inside her home are excluded below. */
function allowedRoots(): string[] {
  // The owner's work folders, read lazily: the provider clients that send
  // files stay free of the tool layer. Without them home and Clem's folder
  // still stand.
  let workspace: string[] = [];
  try {
    const shared = createRequire(import.meta.url)('../tools/shared.js') as { getWorkspaceDirs?: () => string[] };
    workspace = shared.getWorkspaceDirs?.() ?? [];
  } catch { workspace = []; }
  return [...new Set([os.homedir(), BASE_DIR, ...workspace].map(realOrResolved))];
}

/** Clem's own state, secrets and databases never leave, whatever a call says. */
function insideClemStores(real: string): boolean {
  const base = realOrResolved(BASE_DIR);
  if (!inside(base, real)) return false;
  const first = path.relative(base, real).split(/[\\/]/)[0]?.toLowerCase() ?? '';
  if (['state', 'mcp', 'logs', 'backups', '.env'].includes(first) || first.startsWith('secrets')) return true;
  return /\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(real);
}

function credentialBearing(requested: string, real: string): boolean {
  const deny = new Set(BUILTIN_STAGED_FILE_DENY_SEGMENTS.map((segment) => segment.toLowerCase()));
  for (const candidate of [requested, real]) {
    const segments = candidate.split(/[\\/]+/).map((segment) => segment.toLowerCase());
    if (segments.some((segment) => deny.has(segment))) return true;
    if (SECRET_BASENAME_RE.test(path.basename(candidate))) return true;
    if (isSensitivePath(candidate)) return true;
  }
  // Certificate and key stores (a `.key` is left out: it is also a Keynote deck).
  return /\.(?:pem|p12|pfx|keychain-db)$/i.test(real);
}

function folderLabel(real: string): string {
  const parent = path.dirname(real);
  return parent === os.homedir() ? 'your home folder' : path.basename(parent) || parent;
}

/**
 * The one check before a file on this computer is sent anywhere: it exists,
 * is a regular file, sits in the owner's home or work folders, is not a
 * credential or one of Clem's own stores, and is under the size limit.
 * Throws a LocalFileSendRefusal; nothing is read or sent on refusal.
 */
export function resolveLocalFileToSend(requested: string, options: { maxBytes?: number } = {}): LocalFileToSend {
  if (typeof requested !== 'string' || !looksLikeLocalFilePath(requested)) {
    throw new LocalFileSendRefusal('not_a_local_path', `"${String(requested).slice(0, 200)}" is not the full path of a file on this computer.`);
  }
  const resolved = path.resolve(expandHome(requested.trim()));
  let real: string;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw new LocalFileSendRefusal('missing', `There is no file at ${resolved}.`);
  }
  let stats;
  try { stats = statSync(real); } catch {
    throw new LocalFileSendRefusal('unreadable', `The file at ${resolved} could not be read.`);
  }
  if (!stats.isFile()) throw new LocalFileSendRefusal('not_a_file', `${resolved} is a folder or a device, not a file.`);
  if (credentialBearing(resolved, real) || insideClemStores(real)) {
    throw new LocalFileSendRefusal('sensitive', `${path.basename(real)} holds credentials or Clem's own data, so it is never sent anywhere.`);
  }
  if (!allowedRoots().some((root) => inside(root, real))) {
    throw new LocalFileSendRefusal('outside_allowed_folders', `${resolved} is outside your home folder and your work folders, so it is not sent.`);
  }
  const maxBytes = options.maxBytes ?? LOCAL_FILE_SEND_MAX_BYTES;
  if (stats.size > maxBytes) {
    throw new LocalFileSendRefusal('too_large', `${path.basename(real)} is ${formatFileBytes(stats.size)}, over the ${formatFileBytes(maxBytes)} limit for sending a file.`);
  }
  const name = path.basename(real);
  return { requested, path: real, name, folder: folderLabel(real), bytes: stats.size, mimetype: localFileMimetype(name) };
}

/** Read the file the check above approved, refusing one that changed size or was swapped meanwhile. */
export function readLocalFileToSend(file: LocalFileToSend): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size !== file.bytes) {
      throw new LocalFileSendRefusal('unreadable', `${file.name} changed while it was being sent; nothing was sent.`);
    }
    const buffer = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < file.bytes) {
      const read = readSync(fd, buffer, offset, file.bytes - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== file.bytes) throw new LocalFileSendRefusal('unreadable', `${file.name} could not be read in full; nothing was sent.`);
    return buffer;
  } catch (error) {
    if (error instanceof LocalFileSendRefusal) throw error;
    throw new LocalFileSendRefusal('unreadable', `${file.name} could not be read; nothing was sent.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** How a card names a file that will leave this computer. */
export function describeLocalFileToSend(file: LocalFileToSend): string {
  return `${file.name} · ${formatFileBytes(file.bytes)} · in ${file.folder}`;
}
