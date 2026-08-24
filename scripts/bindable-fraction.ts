/**
 * BINDABLE FRACTION — the CAT-8 release gate.
 *
 * "Catalogued is not usable." A capability the user connected is `connected`
 * only when it is BINDABLE; anything less is a DiscoveredCapability, which may
 * be described, ranked and cited but never compiled into an executable node —
 * and must never be reported to the user as connected.
 *
 * This measures the gap that produced the defining number of this era: an
 * install holding 2,414 catalogued operations that bound exactly ONE graph in
 * 491 compilations. Nothing reported that as a failure, because no gate looked.
 *
 * WHAT IS COUNTED. Bindability is a conjunction, and this measures the leg that
 * was actually missing plus the ones cheaply checkable without a provider call:
 *   identity          — the operation is catalogued and active
 *   frozen schema     — resolvable from the DURABLE contract store, not a
 *                       process cache a restart erases. This is the leg that
 *                       connect time used to discard.
 *   effect known      — an operation whose effect is `unknown` cannot be gated,
 *                       so it cannot be dispatched.
 * Manifest currency, account binding and lifecycle-port totality (CAT-6) are
 * NOT counted here — they are per-turn and per-carrier facts. So this number is
 * an UPPER BOUND on what can bind. Treat a low number as decisive and a high
 * number as necessary-not-sufficient.
 *
 * Run: npx tsx scripts/bindable-fraction.ts [--json]
 * Read-only. Never contacts a provider.
 */
import { capabilityIndexDatabase } from '../src/memory/capability-index.js';
import { loadToolContract } from '../src/tools/tool-contract-store.js';

interface CarrierKindRoll {
  carrierKind: string;
  catalogued: number;
  withSchema: number;
  withEffect: number;
  bindable: number;
}

function main(): void {
  const asJson = process.argv.includes('--json');

  let rows: Array<{ carrier_kind: string; identifier: string; effect_class: string }>;
  try {
    rows = capabilityIndexDatabase().prepare(
      `SELECT carrier_kind, identifier, effect_class
         FROM capability_operations
        WHERE active = 1`,
    ).all() as Array<{ carrier_kind: string; identifier: string; effect_class: string }>;
  } catch {
    console.error('no capability index on this home — nothing to measure');
    process.exit(2);
  }

  const byKind = new Map<string, CarrierKindRoll>();
  for (const row of rows) {
    const kind = row.carrier_kind || 'unknown';
    const roll = byKind.get(kind)
      ?? { carrierKind: kind, catalogued: 0, withSchema: 0, withEffect: 0, bindable: 0 };
    roll.catalogued += 1;

    // The durable store only — a process cache would flatter the result and
    // would not survive the restart a real install performs constantly.
    let hasSchema = false;
    try {
      const contract = loadToolContract(row.identifier);
      hasSchema = Boolean(contract?.schema && typeof contract.schema === 'object');
    } catch { hasSchema = false; }

    const hasEffect = row.effect_class === 'read' || row.effect_class === 'write';
    if (hasSchema) roll.withSchema += 1;
    if (hasEffect) roll.withEffect += 1;
    if (hasSchema && hasEffect) roll.bindable += 1;
    byKind.set(kind, roll);
  }

  const kinds = [...byKind.values()].sort((a, b) => b.catalogued - a.catalogued);
  const total = kinds.reduce((sum, k) => sum + k.catalogued, 0);
  const bindable = kinds.reduce((sum, k) => sum + k.bindable, 0);

  // CAT-8: a carrier kind with a non-zero catalogue and a zero bindable
  // fraction is a DECORATIVE CARRIER — the user sees connected tools and the
  // executor sees none. That is release-blocking, not a degraded mode.
  const decorative = kinds.filter((k) => k.catalogued > 0 && k.bindable === 0);

  if (asJson) {
    console.log(JSON.stringify({
      total, bindable,
      fraction: total ? bindable / total : 0,
      byCarrierKind: kinds,
      decorativeCarrierKinds: decorative.map((k) => k.carrierKind),
      releaseBlocking: decorative.length > 0,
    }, null, 2));
    process.exit(decorative.length > 0 ? 1 : 0);
  }

  console.log('BINDABLE FRACTION (CAT-8)\n');
  console.log('  carrier kind    catalogued    schema    effect    BINDABLE');
  for (const k of kinds) {
    const pct = k.catalogued ? ((k.bindable / k.catalogued) * 100).toFixed(1) : '0.0';
    console.log(
      `  ${k.carrierKind.padEnd(14)} ${String(k.catalogued).padStart(10)}`
      + ` ${String(k.withSchema).padStart(9)} ${String(k.withEffect).padStart(9)}`
      + ` ${String(k.bindable).padStart(11)}  ${pct}%`,
    );
  }
  const pct = total ? ((bindable / total) * 100).toFixed(1) : '0.0';
  console.log(`\n  TOTAL          ${String(total).padStart(10)} ${' '.repeat(19)}${String(bindable).padStart(11)}  ${pct}%`);

  if (decorative.length > 0) {
    console.log(`\n✗ RELEASE-BLOCKING (CAT-8): decorative carrier kind(s) — ${decorative.map((k) => k.carrierKind).join(', ')}`);
    console.log('  A non-zero catalogue with zero bindable capabilities means the user sees');
    console.log('  connected tools and the executor sees none. Not a degraded mode.');
    process.exit(1);
  }
  console.log('\n✓ every carrier kind with a catalogue has at least one bindable capability');
}

main();
