/**
 * Typed work disposition and the durable fan-out adapter (E6).
 *
 * The predecessor decided a request's execution lane by matching SERVICE and
 * VERB nouns from a fixed vocabulary. That is a provider classifier wearing a
 * routing hat: it misroutes every unlisted carrier, and it cannot tell a
 * 40-item job from a one-liner about the same nouns.
 *
 * Here the MODEL PROPOSES a typed plan and the RUNTIME validates it
 * deterministically. Nothing in this control flow names a provider, service,
 * operation, or task domain — the only inputs are structural: how many
 * canonical items exist, whether their identities are real, whether required
 * inputs are present, and what effect ceiling the work needs.
 *
 * Explicit user controls (`/background`, Stop, Continue, Approve, Reject)
 * remain deterministic controls and outrank inference in both directions.
 */
export type DispositionKind = 'direct' | 'bounded_foreground' | 'durable_manifest';

export interface WorkManifestPhase {
  id: string;
  dependsOn: string[];
  runnerClass: string;
}

export interface WorkManifest {
  manifestId: string;
  contractVersion: string;
  /** REAL item identities from a canonical source — never an estimated count. */
  canonicalItems: Array<{ id: string; inputRef?: string }>;
  phases: WorkManifestPhase[];
  reducer: { id: string; requiredPhases: string[]; outputContract: string };
}

export interface WorkDisposition {
  kind: DispositionKind;
  objective: string;
  successCriteria: string[];
  missingRequiredInputs: string[];
  effectCeiling: 'none' | 'read' | 'write' | 'send';
  manifest?: WorkManifest;
  estimatedActivations: number;
}

export type DispositionAdmission =
  | { ok: true; disposition: WorkDisposition; windows: number }
  /** Load-bearing inputs are missing: ask ONCE before unattended work. */
  | { ok: false; kind: 'needs_input'; missing: string[] }
  | { ok: false; kind: 'invalid'; errors: string[] };

/**
 * The worker-schema window: how many canonical items one bounded worker
 * dispatch may carry. It is an INTERNAL routing boundary, never a refusal or
 * a subset-completion boundary — a larger manifest simply spans more durable
 * windows (E6.3).
 */
export const WORKER_WINDOW_ITEMS = 256;

/** How many durable activation windows a manifest of this size needs. */
export function manifestWindows(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / WORKER_WINDOW_ITEMS));
}

export interface DispositionControls {
  /** Explicit user control — outranks every inference, both directions. */
  explicit?: 'foreground' | 'background';
}

/**
 * Deterministically ADMIT a proposed disposition. The model proposes; this
 * validates. Structural rules only:
 *
 *  - every canonical item has a real, unique, non-placeholder identity;
 *  - phases reference declared phases; the reducer requires declared phases;
 *  - missing load-bearing inputs ask once (never unattended guessing);
 *  - a fully specified plan whose canonical items exceed one activation
 *    window IS durable — no special wording required;
 *  - an explicit user control wins over the inferred kind.
 */
/** Every dependency cycle among phases, as readable id paths. */
function phaseDependencyCycles(phases: readonly WorkManifestPhase[]): string[][] {
  const dependencies = new Map<string, string[]>();
  for (const phase of phases) dependencies.set(phase.id, [...phase.dependsOn]);
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const walk = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of dependencies.get(id) ?? []) {
      if (dependencies.has(next)) walk(next);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const phase of phases) walk(phase.id);
  return cycles;
}

export function admitWorkDisposition(
  proposed: WorkDisposition,
  controls: DispositionControls = {},
): DispositionAdmission {
  const errors: string[] = [];
  if (!proposed.objective.trim()) errors.push('objective is required');
  if (!['none', 'read', 'write', 'send'].includes(proposed.effectCeiling)) {
    errors.push(`effectCeiling "${String(proposed.effectCeiling)}" is not a known effect class`);
  }
  if (!Number.isFinite(proposed.estimatedActivations) || proposed.estimatedActivations < 1) {
    errors.push('estimatedActivations must be a finite count of at least one');
  }

  // Missing load-bearing inputs are asked ONCE, before structural manifest
  // complaints: a plan cannot enumerate canonical items it has no inputs for,
  // and unattended guessing is the incident class this replaces.
  if (errors.length === 0 && proposed.missingRequiredInputs.length > 0) {
    return { ok: false, kind: 'needs_input', missing: [...proposed.missingRequiredInputs] };
  }

  const manifest = proposed.manifest;
  if (proposed.kind === 'durable_manifest' && !manifest) {
    errors.push('a durable_manifest disposition requires a canonical manifest');
  }
  if (manifest) {
    if (!manifest.manifestId.trim() || !manifest.contractVersion.trim()) {
      errors.push('a manifest requires an id and a contract version');
    }
    if (manifest.canonicalItems.length === 0) {
      errors.push('a manifest requires canonical items — an estimated count is not a manifest');
    }
    const seen = new Set<string>();
    for (const item of manifest.canonicalItems) {
      const id = String(item.id ?? '').trim();
      if (!id) { errors.push('a canonical item has no identity'); continue; }
      if (/^(?:item|row|record|thing)?\s*\d*$|^tbd$|^todo$|^placeholder$/i.test(id) && !item.inputRef) {
        errors.push(`canonical item "${id}" is a placeholder, not an identity`);
      }
      if (seen.has(id)) errors.push(`canonical item "${id}" appears twice`);
      seen.add(id);
    }
    const phaseIds = new Set<string>();
    for (const phase of manifest.phases) {
      const id = String(phase.id ?? '').trim();
      if (!id) { errors.push('a phase has no identity'); continue; }
      // A duplicate phase id makes the item x phase ledger ambiguous: two
      // different runners would settle the same ledger key, and the reducer
      // could not tell whether both ran or one ran twice.
      if (phaseIds.has(id)) errors.push(`phase "${id}" appears twice`);
      phaseIds.add(id);
    }
    for (const phase of manifest.phases) {
      for (const dependency of phase.dependsOn) {
        if (!phaseIds.has(dependency)) errors.push(`phase "${phase.id}" depends on unknown phase "${dependency}"`);
      }
    }
    // A dependency cycle never becomes runnable — every phase in it waits for
    // another phase in it. Rejecting at admission beats a plan that schedules
    // cleanly and then never finishes.
    for (const cycle of phaseDependencyCycles(manifest.phases)) {
      errors.push(`phases form a dependency cycle: ${cycle.join(' -> ')}`);
    }
    for (const required of manifest.reducer.requiredPhases) {
      if (!phaseIds.has(required)) errors.push(`the reducer requires unknown phase "${required}"`);
    }
    if (!manifest.reducer.outputContract.trim()) errors.push('the reducer requires an output contract');
  }
  if (errors.length > 0) return { ok: false, kind: 'invalid', errors };

  // Structural disposition: a fully specified plan that cannot finish inside
  // one bounded activation is durable, whatever words the user used.
  const itemCount = manifest?.canonicalItems.length ?? 0;
  const windows = manifestWindows(itemCount);
  let kind: DispositionKind = proposed.kind;
  if (manifest && (windows > 1 || proposed.estimatedActivations > 1)) kind = 'durable_manifest';
  // An explicit "do this in the background" is a decision the user made, not
  // an estimate to re-derive. Without a manifest there are no canonical items
  // to fan out, but the work still runs durably — demoting it to foreground
  // would silently give back the thing that was asked for.
  if (controls.explicit === 'background') kind = 'durable_manifest';
  if (controls.explicit === 'foreground' && kind === 'durable_manifest' && windows === 1) {
    kind = 'bounded_foreground';
  }
  return { ok: true, disposition: { ...proposed, kind }, windows };
}

export interface DurableWorkPlan {
  /** One entry per durable activation window; the runtime owns scheduling,
   *  bounded concurrency, retries, checkpointing, and reducer readiness. */
  windows: Array<{ index: number; itemIds: string[] }>;
  reducerId: string;
  requiredPhases: string[];
  manifestId: string;
  contractVersion: string;
}

/**
 * The durable fan-out adapter (E6.2): translate an admitted manifest into
 * bounded windows over the EXISTING background/workflow substrate. The model
 * never has to remember to call a worker N times — once a manifest is
 * admitted, the runtime owns item scheduling.
 */
export function dispositionToDurableWork(disposition: WorkDisposition): DurableWorkPlan | undefined {
  const manifest = disposition.manifest;
  if (!manifest || disposition.kind !== 'durable_manifest') return undefined;
  const windows: DurableWorkPlan['windows'] = [];
  for (let index = 0; index * WORKER_WINDOW_ITEMS < manifest.canonicalItems.length; index += 1) {
    windows.push({
      index,
      itemIds: manifest.canonicalItems
        .slice(index * WORKER_WINDOW_ITEMS, (index + 1) * WORKER_WINDOW_ITEMS)
        .map((item) => item.id),
    });
  }
  return {
    windows,
    reducerId: manifest.reducer.id,
    requiredPhases: [...manifest.reducer.requiredPhases],
    manifestId: manifest.manifestId,
    contractVersion: manifest.contractVersion,
  };
}

/** One settled unit of durable work: this item, in this phase. */
export interface LedgerEntry {
  itemId: string;
  phaseId: string;
}

function ledgerKey(entry: LedgerEntry): string {
  return `${entry.itemId}::${entry.phaseId}`;
}

/**
 * Exactly what must have settled before the reducer may run: every canonical
 * item, in every phase the reducer requires. This is derived from the PLAN, so
 * no caller can define readiness by asserting a total.
 */
export function expectedLedger(plan: DurableWorkPlan): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const window of plan.windows) {
    for (const itemId of window.itemIds) {
      for (const phaseId of plan.requiredPhases) entries.push({ itemId, phaseId });
    }
  }
  return entries;
}

/**
 * Reducer readiness against the EXACT expected ledger.
 *
 * Counting was the bug: three settlements for ids belonging to no item in the
 * plan satisfied a three-item plan, so a reducer could run over work that
 * never happened. Readiness now asks whether each expected item x phase
 * settled; anything else is reported as unknown and never counts toward it.
 */
export function reducerReady(input: {
  plan: DurableWorkPlan;
  completed: readonly LedgerEntry[];
}): { ready: boolean; missing: LedgerEntry[]; unknown: LedgerEntry[] } {
  const expected = expectedLedger(input.plan);
  const expectedKeys = new Set(expected.map(ledgerKey));
  const settled = new Set<string>();
  const unknown: LedgerEntry[] = [];
  for (const entry of input.completed) {
    const key = ledgerKey(entry);
    if (expectedKeys.has(key)) settled.add(key);
    else unknown.push(entry);
  }
  const missing = expected.filter((entry) => !settled.has(ledgerKey(entry)));
  return { ready: missing.length === 0, missing, unknown };
}
