import { loadAutomationOpportunityProposal } from '../execution/automation-opportunity-store.js';
import { automationOpportunityDigest } from '../execution/automation-opportunity.js';

const unavailable = 'This proposal has changed or is unavailable. Request a fresh review before deciding.';

/** Presentation only. Decision authority remains in the review control plane.
 * Resolve the exact reviewed revision, never silently preview a newer proposal.
 * Existing pending cards gain the same preview without rewriting signed args. */
export function automationReviewPreview(args: Record<string, unknown> | null | undefined): string {
  try {
    if (!args || args.controlVersion !== 1 || args.kind !== 'automation_opportunity_review_decision'
      || typeof args.proposalId !== 'string' || typeof args.proposalDigest !== 'string'
      || !Number.isSafeInteger(args.reviewedRevision)) return unavailable;
    const record = loadAutomationOpportunityProposal(args.proposalId);
    if (!record || record.status !== 'reviewed' || record.revision !== args.reviewedRevision
      || record.digest !== args.proposalDigest
      || automationOpportunityDigest(record.opportunity) !== args.proposalDigest) return unavailable;
    const p = record.opportunity;
    const json = (value: unknown): string => JSON.stringify(value, null, 2);
    const effect = (value: string): string => value.replaceAll('_', ' ');
    return [
      p.title,
      `Objective: ${p.objective}`,
      `Why: ${p.rationale}`,
      'This approves the proposal only. It does not start a pilot, create a Space, execute work, or activate a schedule. Those steps retain their separate controls.',
      `Lifetime: ${json(p.lifetime)}`,
      `Recurrence (proposed only): ${json(p.recurrence)}`,
      `Trigger: ${json(p.trigger)}`,
      `Effect ceiling: ${effect(p.effectCeiling.class)}; at most ${p.effectCeiling.maxOperationsPerRun} operations per run.`,
      'Required capabilities:',
      ...p.capabilityRequirements.map(c => `${c.id}: ${c.description}\nMinimum effect: ${effect(c.minimumEffect)}\nConstraints: ${c.constraints.join('; ') || 'None specified'}`),
      'Phases:',
      ...p.phases.map(phase => `${phase.id}: ${phase.objective}\nEffect: ${effect(phase.effect.class)}; approval ${effect(phase.effect.approval)}; maximum operations ${phase.effect.maxOperationsPerRun}\nDependencies: ${phase.dependsOn.join(', ') || 'None'}\nCapabilities: ${phase.capabilityRequirementIds.join(', ')}\nPartitioned: ${phase.partitioned}\nEvidence: ${phase.outputEvidence.join('; ')}`),
      `Partition and completion boundary: ${json(p.partition)}`,
      `Deliverables: ${json(p.deliverables)}`,
      `Success criteria: ${json(p.successCriteria)}`,
      `Pilot limits: ${json(p.pilot)}`,
      `Run budgets: ${json(p.budgets)}`,
      `Missing inputs: ${json(p.missingInputs)}`,
      ...(p.dataset ? [`Dataset identity, merge and provenance: ${json(p.dataset)}`] : []),
    ].join('\n\n');
  } catch {
    return unavailable;
  }
}
