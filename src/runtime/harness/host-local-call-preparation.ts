import {
  inspectAuthorizedLocalPlanningDisclosureCandidates,
  issueAuthorizedLocalPlanningDisclosureCandidate,
  localPlanningArgumentsMatch,
  nominateDisclosedLocalPlanningDefinition,
} from './local-planning-capability.js';
import {
  disclosePrimaryModelPlanningCapabilities,
  snapshotPrimaryModelPlanningContext,
  type HostFreshPlanningContextV1,
} from '../semantic-boundary/admit-and-compile-accepted-source.js';

type LocalCall = {
  sessionId: string;
  sourceUserSeq: number;
  capabilityRef: string;
  operationId: string;
  args: unknown;
};

const preparations = new WeakMap<object, {
  planning: HostFreshPlanningContextV1;
  configuredNames: ReadonlySet<string>;
}>();

/** Capture the actual dispatcher surface, not model-authored tool names. This
 * only permits current-source catalog preparation; consent and once-only
 * dispatch remain at their existing boundaries. */
export function bindHostLocalCallPreparation(agent: object, input: {
  planning: HostFreshPlanningContextV1;
  configuredNames: ReadonlySet<string>;
  deniedNames?: ReadonlySet<string>;
}): void {
  preparations.set(agent, {
    planning: input.planning,
    configuredNames: new Set([...input.configuredNames].filter(name => !input.deniedNames?.has(name))),
  });
}

/** A remembered exact native call should not need a model/search round trip
 * merely to republish its definition for this new request. Reopen the live
 * registry and schema, then use the same sealed disclosure as tool_search.
 * This never imports an earlier request's execution grant or acquires a
 * provider operation. Frozen graphs still own their selected capabilities. */
export async function prepareHostLocalCall(agent: object, call: LocalCall): Promise<boolean> {
  const bound = preparations.get(agent);
  if (!bound || !bound.configuredNames.has(call.operationId)) return false;
  const current = snapshotPrimaryModelPlanningContext(bound.planning.authority);
  if (!current || current.identity.sessionId !== call.sessionId
    || current.identity.sourceUserSeq !== call.sourceUserSeq) return false;
  const candidate = await issueAuthorizedLocalPlanningDisclosureCandidate({
    name: call.operationId, carrier: 'work_call', configuredNames: bound.configuredNames,
  });
  if (!candidate || 'refused' in candidate) return false;
  const definitions = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
  if (!definitions?.some(definition => definition.capabilityRef === call.capabilityRef
    && definition.name === call.operationId && definition.descriptor.effect === 'local_write'
    && localPlanningArgumentsMatch(definition, call.args))) return false;
  await disclosePrimaryModelPlanningCapabilities({ authority: bound.planning.authority, candidates: [candidate] });
  return nominateDisclosedLocalPlanningDefinition({ ...call, effect: 'local_write' }) !== null;
}
