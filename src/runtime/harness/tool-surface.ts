import { resolveEffectiveToolNames, type ToolPolicyDiagnostics } from './tool-policy.js';

export type ToolExposure = 'first_class' | 'deferred' | 'hidden';

export interface ToolSurfaceEntry {
  name: string;
  exposure: ToolExposure;
  reason: 'always_loaded' | 'promoted' | 'deferred' | 'excluded' | 'deferral_disabled';
}

export interface ToolSurfaceResult {
  firstClass: string[];
  deferred: string[];
  hidden: string[];
  entries: ToolSurfaceEntry[];
  diagnostics: ToolPolicyDiagnostics & {
    deferralEnabled: boolean;
    firstClassCount: number;
    deferredCount: number;
    hiddenCount: number;
  };
}

function cleanSet(values: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of values ?? []) {
    const name = String(raw ?? '').trim();
    if (name) out.add(name);
  }
  return out;
}

/**
 * Resolve one model-facing tool surface from the tools that ACTUALLY exist on a
 * lane. This is intentionally independent of any provider SDK: callers supply
 * the live available names, policy restrictions, and the names worth loading
 * first-class. The result is the authority shared by schema assembly, catalogs,
 * discovery, and generic dispatch.
 *
 * A tool is never deferred unless it remains callable in the same turn. Lanes
 * without an acquisition path pass `deferralEnabled:false` and retain their full
 * policy-allowed surface.
 */
export function resolveToolSurface(input: {
  surface: string;
  lane: string;
  availableNames: Iterable<string>;
  allowedNames?: Iterable<string>;
  excludeNames?: Iterable<string>;
  alwaysLoadedNames?: Iterable<string>;
  promotedNames?: Iterable<string>;
  deferralEnabled: boolean;
  reason?: string;
}): ToolSurfaceResult {
  const available = [...cleanSet(input.availableNames)];
  const allowedNames = input.allowedNames ? [...cleanSet(input.allowedNames)] : undefined;
  const excludeNames = input.excludeNames ? [...cleanSet(input.excludeNames)] : undefined;
  const policy = resolveEffectiveToolNames({
    surface: input.surface,
    lane: input.lane,
    toolNames: available,
    allowedToolNames: allowedNames,
    excludeToolNames: excludeNames,
    reason: input.reason,
  });
  const allowed = new Set(policy.names);
  const always = cleanSet(input.alwaysLoadedNames);
  const promoted = cleanSet(input.promotedNames);

  const firstClass: string[] = [];
  const deferred: string[] = [];
  const hidden: string[] = [];
  const entries: ToolSurfaceEntry[] = [];

  for (const name of available) {
    if (!allowed.has(name)) {
      hidden.push(name);
      entries.push({ name, exposure: 'hidden', reason: 'excluded' });
      continue;
    }
    if (!input.deferralEnabled) {
      firstClass.push(name);
      entries.push({ name, exposure: 'first_class', reason: 'deferral_disabled' });
      continue;
    }
    if (always.has(name)) {
      firstClass.push(name);
      entries.push({ name, exposure: 'first_class', reason: 'always_loaded' });
      continue;
    }
    if (promoted.has(name)) {
      firstClass.push(name);
      entries.push({ name, exposure: 'first_class', reason: 'promoted' });
      continue;
    }
    deferred.push(name);
    entries.push({ name, exposure: 'deferred', reason: 'deferred' });
  }

  return {
    firstClass,
    deferred,
    hidden,
    entries,
    diagnostics: {
      ...policy.diagnostics,
      deferralEnabled: input.deferralEnabled,
      firstClassCount: firstClass.length,
      deferredCount: deferred.length,
      hiddenCount: hidden.length,
    },
  };
}
