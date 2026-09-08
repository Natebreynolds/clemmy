/**
 * The planning disclosure a worker's tool_search runs with.
 *
 * A parent turn primes a planning catalog for its accepted source and hands
 * its tool_search this closure, so discovery can stage provider candidates
 * (Outlook, Sheets, …) and disclose executable capabilityRefs. A worker child
 * built its tool_search without one, so its searches returned only local
 * meta-tools and every delegated provider read came back "not done" (live
 * 2026-09-08: an inbox triage delegated to two mailbox workers). The child now
 * primes the same catalog for its own accepted source and runs this closure.
 */
import type { HostFreshPlanningContextV1 } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { disclosePrimaryModelPlanningCapabilities } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { stageDisclosedPlanningProviderCandidates } from '../tools/tool-search-provider-sources.js';
import type {
  ToolSearchPlanningDisclosureCandidate,
  ToolSearchPlanningDisclosureControl,
  ToolSearchPlanningDisclosureOutcome,
} from '../tools/tool-search-tool.js';

export function buildPlanningDisclosure(hostFreshPlanning: HostFreshPlanningContextV1) {
  return async (
    candidates: readonly ToolSearchPlanningDisclosureCandidate[],
    control?: Readonly<ToolSearchPlanningDisclosureControl>,
  ): Promise<ToolSearchPlanningDisclosureOutcome> => {
    const staged = await stageDisclosedPlanningProviderCandidates({
      ...hostFreshPlanning.identity,
      candidates,
      signal: control?.signal,
      deadlineAt: control?.deadlineAt,
      accountSelection: control?.accountSelection,
    });
    if (control && (control.signal.aborted || Date.now() >= control.deadlineAt)) {
      return { version: 1 as const, refs: Object.freeze({}), blockers: Object.freeze({}) };
    }
    const refs = await disclosePrimaryModelPlanningCapabilities({
      authority: hostFreshPlanning.authority,
      candidates,
      signal: control?.signal,
      deadlineAt: control?.deadlineAt,
    });
    if (control && (control.signal.aborted || Date.now() >= control.deadlineAt)) {
      return { version: 1 as const, refs: Object.freeze({}), blockers: Object.freeze({}) };
    }
    return { version: 1 as const, refs, blockers: staged.blockers };
  };
}
