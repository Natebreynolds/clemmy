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
 */
import { createHash } from 'node:crypto';
import { appendEvent, listEvents } from './eventlog.js';

export const OWN_FILE_OBSERVED_KIND = 'own_file_observed';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface LocalFileObservation {
  contentDigest: string;
  bytes: number;
  seq: number;
  tool: string;
}

/** Record that this conversation saw `bytes` at `target` (a canonical path). */
export function recordLocalFileObservation(input: {
  sessionId: string; sourceUserSeq?: number; callId?: string; tool: string; target: string; bytes: Buffer;
}): void {
  try {
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped', data: {
      kind: OWN_FILE_OBSERVED_KIND, tool: input.tool, target: input.target,
      contentDigest: digest(input.bytes), bytes: input.bytes.length,
      ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
    } });
  } catch { /* an unrecorded observation only means no base; the write is not affected */ }
}

/** The latest observation this conversation recorded for `target`, or null. */
export function observedLocalFileBase(input: { sessionId: string; target: string }): LocalFileObservation | null {
  try {
    // The newest observation by sequence; the query's own order is not relied on.
    let latest: LocalFileObservation | null = null;
    for (const event of listEvents(input.sessionId, { types: ['guardrail_tripped'] })) {
      if (event.role !== 'system' || event.data.kind !== OWN_FILE_OBSERVED_KIND || event.data.target !== input.target) continue;
      const contentDigest = event.data.contentDigest;
      if (typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest)) continue;
      if (!latest || event.seq > latest.seq) {
        latest = { contentDigest, bytes: Number(event.data.bytes ?? 0) || 0, seq: event.seq, tool: String(event.data.tool ?? '') };
      }
    }
    return latest;
  } catch {
    return null;
  }
}
