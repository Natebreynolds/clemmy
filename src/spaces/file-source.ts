/**
 * A Workspace data source that is a local file.
 *
 * Data that already lives in a file needs no model and no process to reach a
 * Workspace: the host reads the file on every refresh. Live 2026-10-17 a Space
 * built from a CSV either stayed a static snapshot or got a feed workflow
 * whose model step ran a shell command and relayed its stdout on every
 * refresh. A .json file becomes its parsed document, a .csv or .tsv file its
 * rows as objects keyed by the header (values stay text), anything else
 * `{ text }`. Credential files and Clementine's own state are refused, as
 * read_file refuses them.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { isSensitivePath } from '../runtime/security.js';
import { WORKSPACE_SET_DATA_MAX_BYTES } from './workspace-set-data-contract.js';

export type FileSourceRead =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: 'definition' | 'provider_error' };

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function delimitedRecords(text: string, delimiter: string): Array<Record<string, string>> {
  const [header, ...rows] = parseDelimitedRows(text, delimiter);
  if (!header) return [];
  const keys = header.map((name, index) => name.trim() || `column_${index + 1}`);
  return rows.map((values) => Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ''])));
}

export function readWorkspaceFileSource(sourceId: string, filePath: string): FileSourceRead {
  const raw = filePath.trim();
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, code: 'definition', error: `Data source "${sourceId}" file_path must be an absolute or ~/ path, not "${raw}".` };
  }
  let resolved: string;
  try { resolved = realpathSync(expanded); }
  catch { return { ok: false, code: 'provider_error', error: `Data source "${sourceId}" file ${raw} does not exist or cannot be opened.` }; }
  const state = path.join(BASE_DIR, 'state');
  const insideState = (() => {
    try { const rel = path.relative(realpathSync(state), resolved); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
    catch { return false; }
  })();
  if (isSensitivePath(resolved) || insideState) {
    return { ok: false, code: 'definition', error: `Data source "${sourceId}" file ${raw} holds credentials or Clementine's own state and cannot be a Workspace source.` };
  }
  let text: string;
  const fd = openSync(resolved, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'definition', error: `Data source "${sourceId}" file_path ${raw} is not a file.` };
    if (stat.size > WORKSPACE_SET_DATA_MAX_BYTES) {
      return { ok: false, code: 'provider_error', error: `Data source "${sourceId}" file ${raw} is ${stat.size} bytes, over the ${WORKSPACE_SET_DATA_MAX_BYTES}-byte dataset limit.` };
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    text = buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.json') {
    try { return { ok: true, data: JSON.parse(text) as unknown }; }
    catch (error) { return { ok: false, code: 'provider_error', error: `Data source "${sourceId}" file ${raw} is not valid JSON: ${(error as Error).message}` }; }
  }
  if (extension === '.csv') return { ok: true, data: delimitedRecords(text, ',') };
  if (extension === '.tsv') return { ok: true, data: delimitedRecords(text, '\t') };
  return { ok: true, data: { text } };
}
