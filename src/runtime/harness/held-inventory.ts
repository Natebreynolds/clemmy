/** Compact historical evidence index. It informs the model; it grants no authority. */
import { listEvents } from './eventlog.js';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

/** Read adapters stamp the source outside the record; the learning producer
 * stamps it inside. Neither an unscoped row nor another source is this turn. */
export function evidenceSourceUserSeq(data: Record<string, unknown>): number | undefined {
  const nested = object(data.record) && object(data.record.source) ? data.record.source.sourceUserSeq : undefined;
  const seq = data.sourceUserSeq ?? nested;
  return Number.isSafeInteger(seq) && Number(seq) > 0 ? Number(seq) : undefined;
}

/** Stable operation/routing identity, without row ids or discovery timestamps.
 * One toolkit can provide many different capabilities. */
export function capabilityEvidenceKey(row: Record<string, unknown>): string | undefined {
  if (typeof row.identifier !== 'string' || !row.identifier.trim()) return undefined;
  return JSON.stringify([row.kind ?? null, row.identifier.trim(), row.accountIdentity ?? null, row.command ?? null]);
}

/** A duplicate delivery of a read receipt must not become fresh progress.
 * Use evidence identity when available, then the producer's receipt identity. */
export function readEvidenceKey(record: Record<string, unknown>): string | undefined {
  if (record.dispatchOutcome !== 'succeeded' || record.effectClass !== 'read') return undefined;
  const ref = record.readEvidenceRef ?? record.receiptId;
  if (typeof ref !== 'string' || !ref) return undefined;
  const scope = object(record.scope) ? record.scope : {};
  return JSON.stringify([record.identifier, scope.tenant, scope.workspace, scope.accountIdentity, record.schemaFingerprint, ref]);
}

function toolkitOf(identifier: string): string {
  return identifier.trim().split('_')[0]?.toUpperCase() || identifier;
}

export interface HeldInventory {
  toolkits: ReadonlyArray<{ toolkit: string; operations: readonly string[] }>;
  /** Preview of read operation names, not a claim about all requested inputs. */
  reads: readonly string[];
  total: number;
  toolkitCount: number;
  readCount: number;
}

// Presentation bounds only: totals remain complete and the model can retrieve
// omitted operations/results through the existing discovery and recall tools.
const MAX_TOOLKITS = 8;
const MAX_OPERATIONS_PER_TOOLKIT = 6;
const MAX_READS = 6;

export function heldInventory(sessionId: string, sourceUserSeq?: number): HeldInventory {
  const empty: HeldInventory = { toolkits: [], reads: [], total: 0, toolkitCount: 0, readCount: 0 };
  if (!sessionId) return empty;
  try {
    const capabilities = new Map<string, { identifier: string; usable: boolean }>();
    const readKeys = new Set<string>();
    const reads = new Set<string>();
    const events = listEvents(sessionId, {
      types: ['capability_resolution', 'read_receipt'],
      ...(sourceUserSeq !== undefined ? { sinceSeq: sourceUserSeq - 1 } : {}),
    });
    for (const event of events) {
      if (sourceUserSeq !== undefined && evidenceSourceUserSeq(event.data) !== sourceUserSeq) continue;
      if (event.type === 'read_receipt') {
        const record = event.data.record;
        if (!object(record)) continue;
        const key = readEvidenceKey(record);
        if (key && typeof record.identifier === 'string') {
          readKeys.add(key);
          reads.add(record.identifier);
        }
        continue;
      }
      for (const row of Array.isArray(event.data.entries) ? event.data.entries : []) {
        if (!object(row)) continue;
        const key = capabilityEvidenceKey(row);
        if (!key) continue;
        capabilities.set(key, { identifier: String(row.identifier).trim(), usable: row.status === 'proven' && row.connection !== 'missing' });
      }
    }
    const byToolkit = new Map<string, Set<string>>();
    for (const { identifier, usable } of capabilities.values()) {
      if (!usable) continue;
      const toolkit = toolkitOf(identifier);
      let operations = byToolkit.get(toolkit);
      if (!operations) { operations = new Set(); byToolkit.set(toolkit, operations); }
      operations.add(identifier);
    }
    const total = [...byToolkit.values()].reduce((sum, operations) => sum + operations.size, 0);
    const toolkits = [...byToolkit.entries()]
      .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
      .slice(0, MAX_TOOLKITS)
      .map(([toolkit, operations]) => ({ toolkit, operations: [...operations].sort().slice(0, MAX_OPERATIONS_PER_TOOLKIT) }));
    return { toolkits, reads: [...reads].slice(0, MAX_READS), total, toolkitCount: byToolkit.size, readCount: readKeys.size };
  } catch {
    return empty;
  }
}

export function heldInventoryLines(inventory: HeldInventory): string[] {
  if (inventory.total === 0 && inventory.readCount === 0) return [];
  const lines = ['[retained evidence index — historical discoveries and read receipts; live dispatch still checks availability and authority]'];
  if (inventory.readCount > 0) {
    lines.push(`- ${inventory.readCount} distinct read results recorded. Read operations include: ${inventory.reads.join(', ')}. Use retained call IDs to retrieve their full results; these counts do not establish that every requested input was read.`);
  }
  for (const entry of inventory.toolkits) lines.push(`- ${entry.toolkit}: ${entry.operations.join(', ')}`);
  if (inventory.total > 0) {
    const shown = inventory.toolkits.reduce((sum, entry) => sum + entry.operations.length, 0);
    lines.push(`- Showing ${shown} of ${inventory.total} previously resolved operations across ${inventory.toolkitCount} toolkits. Reuse an exact known operation when suitable; discover a missing operation or refresh changed account/schema information when needed. A known toolkit does not mean all its operations are known.`);
  }
  return lines;
}
