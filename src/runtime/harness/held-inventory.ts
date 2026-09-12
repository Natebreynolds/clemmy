/**
 * WHAT SHE ALREADY HOLDS — the one thing compaction must never take.
 *
 * Mid-turn compaction collapses older tool call/result pairs into a stub so
 * per-frame prefill stays cheap. That trade is deliberate and measured: window
 * scaling it (2026-08-05) let GLM's 512k window reach 82k of results before the
 * first collapse, so a 27-read workflow composed 58k-token prompts and timed
 * out on first byte (2026-09-01); and on a caching wire each collapse rewrites
 * the prefix, which cost ~126k of one run's ~139k uncached tokens (2026-09-03).
 * So the absolute trigger stays.
 *
 * What that trade never priced is WHAT gets collapsed. Measured across four
 * Plan turns on 2026-09-11..12:
 *
 *   run                compactions  pairs collapsed  recall calls  outcome
 *   33-min (published)      10            945             78       33 minutes
 *   22.5-min                 4            126             27       no plan
 *   16-min                   1              7              7       no plan
 *
 * And the loop underneath those numbers, live 2026-09-12
 * (sess-desktop-03fef66ec002984d6bd0b8d2):
 *
 *   05:28:33  condenser_applied — 7 tool pairs collapsed, 34,636 → 19,732
 *   05:29:30  "DataForSEO Google related keywords search volume live SERP organic"
 *   05:30:08  "DataForSEO related keywords search volume Google Ads live"
 *   05:30:58  "DataForSEO Google related keywords search volume live SERP"
 *   05:31:14  "DataForSEO Google Ads search volume related keywords live"
 *   05:31:48  "DataForSEO Google Ads search volume related keywords live"  ← exact repeat
 *   05:32:28  "DataForSEO Google organic SERP live keyword search volume labs…"
 *
 * against NINE DataForSEO operations already proven and still callable the
 * whole time. She was not confused about the task — her own check-in that turn
 * read "the source doc is a competitor-intel brief… next I'm binding the exact
 * Apify scrape and DataForSEO keyword/SERP/backlink actions". She had simply
 * lost the LIST, and re-searching costs one call while recovering costs a
 * recall call plus knowing which call_id to ask for.
 *
 * THE FIX IS NOT MORE STORAGE. The results are already durable in
 * `tool_outputs`; the schemas are already on disk (2,000 contracts in
 * memory/tool-contracts); the capabilities stay callable in the catalog the
 * entire time. Compaction destroys none of that — it destroys her INDEX of it.
 *
 * So this is a few hundred bytes, regenerated from the ledger, that rides
 * inside the collapse summary itself. It survives because it IS the
 * replacement, not something the collapse has to be taught to spare. Prefill
 * stays cheap; the map does not go missing.
 */
import { listEvents } from './eventlog.js';

/** Provider slugs are TOOLKIT_VERB_NOUN; the head segment is the toolkit. */
function toolkitOf(identifier: string): string {
  const head = identifier.trim().toUpperCase().split('_')[0] ?? '';
  return head || identifier.trim().toUpperCase();
}

export interface HeldInventory {
  /** Provider operations proven callable, grouped by toolkit. */
  toolkits: ReadonlyArray<{ toolkit: string; operations: readonly string[] }>;
  /** Exact inputs already read from a provider this turn. */
  reads: readonly string[];
  total: number;
}

/** Bounded so the block can never grow into the thing it replaces. */
const MAX_TOOLKITS = 8;
const MAX_OPERATIONS_PER_TOOLKIT = 6;
const MAX_READS = 6;

/**
 * What this accepted source has proven and read. Pure ledger read; any failure
 * yields an empty inventory rather than a wrong one, because a confident but
 * stale list would be worse than none.
 */
export function heldInventory(sessionId: string, sourceUserSeq?: number): HeldInventory {
  const empty: HeldInventory = { toolkits: [], reads: [], total: 0 };
  if (!sessionId) return empty;
  try {
    const byToolkit = new Map<string, Set<string>>();
    const reads = new Set<string>();
    let total = 0;
    const events = listEvents(sessionId, {
      types: ['capability_resolution', 'read_receipt'],
      ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
        ? { sinceSeq: (sourceUserSeq as number) - 1 }
        : {}),
    });
    for (const event of events) {
      if (sourceUserSeq !== undefined && event.data.sourceUserSeq !== undefined
        && event.data.sourceUserSeq !== sourceUserSeq) continue;
      if (event.type === 'read_receipt') {
        const record = event.data.record;
        const identifier = record && typeof record === 'object' && !Array.isArray(record)
          ? (record as { identifier?: unknown }).identifier
          : undefined;
        if (typeof identifier === 'string' && identifier.trim()) reads.add(identifier.trim());
        continue;
      }
      const entries = Array.isArray(event.data.entries) ? event.data.entries : [];
      for (const entry of entries) {
        const row = entry as { identifier?: unknown; status?: unknown; connection?: unknown };
        if (row.status !== 'proven' || row.connection === 'missing') continue;
        if (typeof row.identifier !== 'string' || !row.identifier.trim()) continue;
        const identifier = row.identifier.trim();
        let set = byToolkit.get(toolkitOf(identifier));
        if (!set) { set = new Set(); byToolkit.set(toolkitOf(identifier), set); }
        if (!set.has(identifier)) { set.add(identifier); total += 1; }
      }
    }
    const toolkits = [...byToolkit.entries()]
      .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
      .slice(0, MAX_TOOLKITS)
      .map(([toolkit, operations]) => ({
        toolkit,
        operations: [...operations].sort().slice(0, MAX_OPERATIONS_PER_TOOLKIT),
      }));
    return { toolkits, reads: [...reads].slice(0, MAX_READS), total };
  } catch {
    return empty;
  }
}

/**
 * The lines that ride inside a collapse summary. Empty when there is nothing
 * held — a heading over an empty list teaches the model to ignore the heading.
 */
export function heldInventoryLines(inventory: HeldInventory): string[] {
  if (inventory.toolkits.length === 0 && inventory.reads.length === 0) return [];
  const lines: string[] = [
    '[still held — collapsing the results above did NOT withdraw any of this]',
  ];
  if (inventory.reads.length > 0) {
    lines.push(`- Inputs already read: ${inventory.reads.join(', ')}. Do not re-read them.`);
  }
  for (const entry of inventory.toolkits) {
    lines.push(`- ${entry.toolkit}: ${entry.operations.join(', ')}`);
  }
  if (inventory.total > 0) {
    lines.push(
      `- These ${inventory.total} operations are PROVEN and CALLABLE right now, against accounts already resolved. `
      + 'Call one directly. Do NOT search again for a toolkit listed here — a repeat search returns what you already hold and proves nothing new.',
    );
  }
  return lines;
}
