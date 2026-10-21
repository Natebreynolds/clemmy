/**
 * What a conversation has seen of a local file, so a later write binds to
 * exactly that and never silently replaces an edit made outside.
 *
 * A read records the bytes it returned; a write records the bytes it
 * committed. The latest of those for a file is the base a following write in
 * the same conversation expects to find on disk. No read is required before a
 * write: a file this conversation never observed has no base, and the write
 * proceeds as it always has. A base is never guessed from anything but an
 * exact recorded observation.
 *
 * Observations live beside the revision store, one small file per file and
 * conversation, not in the event log: readers there take the most recent N
 * events of a type as a window, and the console resyncs on each, so one row
 * per read or write would crowd both.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

const PREFIX = 'state/local-file-observations';
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export interface LocalFileObservation {
  contentDigest: string;
  bytes: number;
  tool: string;
  at: string;
}

function observationFile(sessionId: string, target: string): string {
  return path.join(BASE_DIR, PREFIX, digest(target), `${digest(sessionId)}.json`);
}

/** Record that this conversation saw `bytes` at `target` (a canonical path). */
export function recordLocalFileObservation(input: {
  sessionId: string; sourceUserSeq?: number; callId?: string; tool: string; target: string; bytes: Buffer;
}): void {
  try {
    const file = observationFile(input.sessionId, input.target);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const record = { version: 1, target: input.target, sessionId: input.sessionId, tool: input.tool,
      contentDigest: digest(input.bytes), bytes: input.bytes.length, at: new Date().toISOString(),
      ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
      ...(input.callId ? { callId: input.callId } : {}) };
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, file);
  } catch { /* an unrecorded observation only means no base; the write is not affected */ }
}

/** The latest observation this conversation recorded for `target`, or null. */
export function observedLocalFileBase(input: { sessionId: string; target: string }): LocalFileObservation | null {
  try {
    const file = observationFile(input.sessionId, input.target);
    if (!existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (record.version !== 1 || record.target !== input.target || record.sessionId !== input.sessionId) return null;
    const contentDigest = record.contentDigest;
    if (typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest)) return null;
    return { contentDigest, bytes: Number(record.bytes ?? 0) || 0, tool: String(record.tool ?? ''), at: String(record.at ?? '') };
  } catch {
    return null;
  }
}
