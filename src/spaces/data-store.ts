/**
 * Per-Workspace document store — the data plane the agent-authored view talks
 * to (same-origin, cookie-authed). The one real gap the Spaces feature fills.
 *
 *  - data.json   : the dataset, single JSON doc, last-write-wins, atomic, size-capped.
 *  - notes.jsonl : append-only user notes + tracked in-view actions.
 *  - audit.jsonl : append-only log of data-plane calls (trusted-model guardrail).
 *
 * Every path resolves through resolveInSpace() (traversal-safe). Single-user
 * loopback ⇒ no concurrent-writer problem, so last-write-wins is sufficient.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveInSpace } from './store.js';

/** Hard cap so a runaway poll loop can't fill the disk. */
export const MAX_DATA_BYTES = 5 * 1024 * 1024;
/** Keep notes/audit reads bounded. */
const DEFAULT_TAIL = 200;

function atomicWrite(file: string, content: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}

function appendLine(file: string, obj: unknown): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf-8');
}

function readTail(file: string, limit: number): unknown[] {
  if (!existsSync(file)) return [];
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
  const tail = lines.slice(-limit);
  const out: unknown[] = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
  }
  return out;
}

// ---- data.json ------------------------------------------------------------

/** Read the Space's dataset. Returns {} if absent or unreadable. */
export function readData(slug: string): unknown {
  const file = resolveInSpace(slug, 'data.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

export interface WriteDataResult { ok: true; bytes: number }
export interface WriteDataError { ok: false; error: string; bytes: number }

/** Write the Space's dataset (atomic, size-capped). */
export function writeData(slug: string, doc: unknown): WriteDataResult | WriteDataError {
  let serialized: string;
  try {
    serialized = JSON.stringify(doc ?? {});
  } catch (err) {
    return { ok: false, error: `data is not JSON-serializable: ${(err as Error).message}`, bytes: 0 };
  }
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > MAX_DATA_BYTES) {
    return { ok: false, error: `data exceeds ${MAX_DATA_BYTES} byte cap (${bytes} bytes)`, bytes };
  }
  atomicWrite(resolveInSpace(slug, 'data.json'), serialized);
  return { ok: true, bytes };
}

// ---- notes.jsonl ----------------------------------------------------------

export interface NoteRecord {
  id: string;
  text: string;
  /** Optional action kind for tracked in-view interactions (e.g. "call", "edit"). */
  kind?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export function appendNote(slug: string, input: { text: string; kind?: string; meta?: Record<string, unknown> }): NoteRecord {
  const note: NoteRecord = {
    id: randomUUID(),
    text: String(input.text ?? '').slice(0, 8000),
    kind: input.kind,
    meta: input.meta,
    createdAt: new Date().toISOString(),
  };
  appendLine(resolveInSpace(slug, 'notes.jsonl'), note);
  return note;
}

export function listNotes(slug: string, limit = DEFAULT_TAIL): NoteRecord[] {
  return readTail(resolveInSpace(slug, 'notes.jsonl'), limit) as NoteRecord[];
}

// ---- audit.jsonl ----------------------------------------------------------

export interface AuditEntry {
  ts: string;
  method: string;
  path: string;
  outcome: 'ok' | 'rejected' | 'error';
  bytes?: number;
  note?: string;
}

export function appendAudit(slug: string, entry: Omit<AuditEntry, 'ts'>): void {
  try {
    appendLine(resolveInSpace(slug, 'audit.jsonl'), { ts: new Date().toISOString(), ...entry });
  } catch {
    // best-effort; auditing must never break the request
  }
}

export function listAudit(slug: string, limit = DEFAULT_TAIL): AuditEntry[] {
  return readTail(resolveInSpace(slug, 'audit.jsonl'), limit) as AuditEntry[];
}
