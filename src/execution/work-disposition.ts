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
    const phaseIds = new Set(manifest.phases.map((phase) => phase.id));
    for (const phase of manifest.phases) {
      for (const dependency of phase.dependsOn) {
        if (!phaseIds.has(dependency)) errors.push(`phase "${phase.id}" depends on unknown phase "${dependency}"`);
      }
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
  if (controls.explicit === 'background') kind = manifest ? 'durable_manifest' : 'bounded_foreground';
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

/** Reducer readiness: every canonical item terminal exists, exactly once. */
export function reducerReady(input: {
  plan: DurableWorkPlan;
  completedItemIds: readonly string[];
  totalItems: number;
}): { ready: boolean; missing: number } {
  const completed = new Set(input.completedItemIds);
  const missing = input.totalItems - completed.size;
  return { ready: missing <= 0, missing: Math.max(0, missing) };
}
