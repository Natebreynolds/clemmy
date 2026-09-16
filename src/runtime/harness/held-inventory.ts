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

/** Did the query or request that produced this row contain the toolkit's own
 * token? Legacy rows carry no match evidence and never name anything. */
function rowNamesToolkit(row: Record<string, unknown>, toolkit: string): boolean {
  if (!Array.isArray(row.matchedTokens)) return false;
  const wanted = toolkit.toLowerCase();
  return row.matchedTokens.some((token) => typeof token === 'string' && token.trim().toLowerCase() === wanted);
}

export interface HeldInventory {
  /** `named`: the producing query or request contained this toolkit's own
   * token, or a read receipt for this source already used it. A toolkit that
   * merely rode along in a discovery window is counted but not named. */
  toolkits: ReadonlyArray<{ toolkit: string; operations: readonly string[]; named: boolean }>;
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
    const capabilities = new Map<string, { identifier: string; usable: boolean; named: boolean }>();
    const readKeys = new Set<string>();
    const reads = new Set<string>();
    const readToolkits = new Set<string>();
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
          readToolkits.add(toolkitOf(record.identifier));
        }
        continue;
      }
      for (const row of Array.isArray(event.data.entries) ? event.data.entries : []) {
        if (!object(row)) continue;
        const key = capabilityEvidenceKey(row);
        if (!key) continue;
        const identifier = String(row.identifier).trim();
        capabilities.set(key, {
          identifier,
          usable: row.status === 'proven' && row.connection !== 'missing',
          // Naming is sticky per operation: once any row for it carried the
          // toolkit token, a later carry-forward or legacy row does not unsay it.
          named: capabilities.get(key)?.named === true || rowNamesToolkit(row, toolkitOf(identifier)),
        });
      }
    }
    const byToolkit = new Map<string, { operations: Set<string>; named: boolean }>();
    for (const { identifier, usable, named } of capabilities.values()) {
      if (!usable) continue;
      const toolkit = toolkitOf(identifier);
      let held = byToolkit.get(toolkit);
      if (!held) { held = { operations: new Set(), named: readToolkits.has(toolkit) }; byToolkit.set(toolkit, held); }
      held.operations.add(identifier);
      if (named) held.named = true;
    }
    const total = [...byToolkit.values()].reduce((sum, held) => sum + held.operations.size, 0);
    const toolkits = [...byToolkit.entries()]
      .sort((left, right) => right[1].operations.size - left[1].operations.size || left[0].localeCompare(right[0]))
      .slice(0, MAX_TOOLKITS)
      .map(([toolkit, held]) => ({
        toolkit,
        operations: [...held.operations].sort().slice(0, MAX_OPERATIONS_PER_TOOLKIT),
        named: held.named,
      }));
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
