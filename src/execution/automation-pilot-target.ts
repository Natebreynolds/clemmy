import type {
  AutomationCapabilityRequirementV1,
  AutomationOpportunityPhaseV1,
  AutomationOpportunityV1,
} from './automation-opportunity.js';

export type AutomaticReadPilotTargetV1 =
  | {
      ok: true;
      phase: AutomationOpportunityPhaseV1;
      requirement: AutomationCapabilityRequirementV1;
    }
  | { ok: false; reason: string };

/**
 * Select the one phase a one-shot read pilot may honestly prove.
 *
 * Besides the original single-read shape, this admits only the exact large
 * partition shape consumed by automation-partition-authority: one root,
 * unpartitioned enumeration read and exclusively partitioned phases
 * downstream of it. The pilot proves the source enumeration and its closed
 * result authority; it never claims to have piloted downstream fan-out.
 */
export function selectAutomaticReadPilotTarget(
  opportunity: AutomationOpportunityV1,
): AutomaticReadPilotTargetV1 {
  const sourcePhases = opportunity.phases.filter((phase) => !phase.partitioned);
  if (sourcePhases.length !== 1) {
    return { ok: false, reason: 'Automatic pilot advancement requires exactly one unpartitioned source phase.' };
  }
  const phase = sourcePhases[0]!;
  if (phase.dependsOn.length !== 0 || phase.capabilityRequirementIds.length !== 1) {
    return { ok: false, reason: 'The automatic pilot source must be one root phase bound to exactly one capability requirement.' };
  }
  const requirement = opportunity.capabilityRequirements.find(
    (candidate) => candidate.id === phase.capabilityRequirementIds[0],
  );
  if (!requirement) {
    return { ok: false, reason: 'The automatic pilot source capability requirement is missing.' };
  }
  if (
    phase.effect.class !== 'read'
    || requirement.minimumEffect !== 'read'
    || opportunity.effectCeiling.class !== 'read'
    || opportunity.pilot.effectCeiling.class !== 'read'
  ) return { ok: false, reason: 'Only an exact read-only proposal can enter automatic pilot advancement.' };

  if (opportunity.partition.mode === 'single') {
    if (
      opportunity.phases.length !== 1
      || opportunity.capabilityRequirements.length !== 1
      || opportunity.capabilityRequirements[0]?.id !== requirement.id
    ) {
      return { ok: false, reason: 'A single-item automatic pilot requires exactly one unpartitioned phase and one capability.' };
    }
    return { ok: true, phase, requirement };
  }

  if (
    opportunity.partition.mode !== 'finite'
    || opportunity.phases.length < 2
    || opportunity.pilot.maxPartitions !== 1
  ) {
    return { ok: false, reason: 'A partition source pilot requires one finite reviewed universe and a one-partition pilot ceiling.' };
  }
  const downstream = opportunity.phases.filter((candidate) => candidate.id !== phase.id);
  const downstreamById = new Map(downstream.map((candidate) => [candidate.id, candidate]));
  const referencedRequirements = new Set(opportunity.phases.flatMap(
    (candidate) => candidate.capabilityRequirementIds,
  ));
  if (
    downstream.some((candidate) => !candidate.partitioned)
    || downstream.some((candidate) => candidate.capabilityRequirementIds.includes(requirement.id))
    || opportunity.capabilityRequirements.some((candidate) => !referencedRequirements.has(candidate.id))
  ) {
    return { ok: false, reason: 'Every non-source phase must be explicitly partitioned, use non-enumeration capabilities, and account for the reviewed requirements.' };
  }
  for (const candidate of downstream) {
    const pending = [...candidate.dependsOn];
    const visited = new Set<string>();
    let reachesSource = false;
    while (pending.length > 0) {
      const dependency = pending.pop()!;
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      if (dependency === phase.id) {
        reachesSource = true;
        continue;
      }
      const dependencyPhase = downstreamById.get(dependency);
      if (!dependencyPhase?.partitioned) {
        return { ok: false, reason: `Partitioned phase "${candidate.id}" depends on work outside the exact source ledger.` };
      }
      pending.push(...dependencyPhase.dependsOn);
    }
    if (!reachesSource) {
      return { ok: false, reason: `Partitioned phase "${candidate.id}" is not downstream of the exact source enumeration.` };
    }
  }
  return { ok: true, phase, requirement };
}
