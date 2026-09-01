export interface HostStructuralPlanningControlLookupV1 {
  kind: 'host_structural_control_lookup_v1';
  query: string;
  total_results: 2;
  results: readonly [
    Readonly<Record<string, string>>,
    Readonly<Record<string, string>>,
  ];
  schemas: Readonly<Record<string, never>>;
  hint: string;
}

/**
 * Recognize a lookup for Clementine's own plan/work CONTROL surface. This is
 * intentionally narrower than ordinary prose about making a plan: either the
 * exact host names are present, or the query explicitly asks for multi-step
 * dependency planning plus work-call execution.
 */
export function isHostStructuralPlanningControlLookup(query: string): boolean {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const explicitlyNamesControl = /(?:^|[^a-z0-9_])(?:plan_task|work_call)(?:[^a-z0-9_]|$)/i
    .test(normalized);
  const semanticControlLookup = /\bplan\b/i.test(normalized)
    && /\b(?:multi[- ]?step|dependent|dependencies|operation\s+dag|work\s+topology)\b/i
      .test(normalized)
    && /\b(?:work\s+calls?|execute\s+work)\b/i.test(normalized);
  return explicitlyNamesControl || semanticControlLookup;
}

export function hostStructuralPlanningControlLookup(
  query: string,
): HostStructuralPlanningControlLookupV1 | null {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!isHostStructuralPlanningControlLookup(normalized)) return null;
  return Object.freeze({
    kind: 'host_structural_control_lookup_v1' as const,
    query: normalized,
    total_results: 2 as const,
    results: Object.freeze([
      Object.freeze({
        name: 'plan_task',
        summary: 'Host-local control that freezes a disclosed multi-step action topology.',
        status: 'host_surface_control',
        authority: 'none',
      }),
      Object.freeze({
        name: 'work_call',
        summary: 'Host-local carrier for one exact operation from the frozen plan.',
        status: 'host_surface_control',
        authority: 'none',
      }),
    ]) as HostStructuralPlanningControlLookupV1['results'],
    schemas: Object.freeze({}),
    hint: 'These are host-local control schemas, not business capabilities and not capabilityRef values. They appear on the next model surface after exact business capability discovery. Do not search provider catalogs for them or cite these rows in plan_task.',
  });
}
