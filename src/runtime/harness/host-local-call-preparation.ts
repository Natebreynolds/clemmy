import {
  inspectAuthorizedLocalPlanningDisclosureCandidates,
  isRegistryDeclaredLocalPlanningCapability,
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
  const current = await currentLocalWriteDefinitions(agent, call);
  if (!current?.definitions.some(definition => definition.capabilityRef === call.capabilityRef)) return false;
  await disclosePrimaryModelPlanningCapabilities({ authority: current.authority, candidates: [current.candidate] });
  return nominateDisclosedLocalPlanningDefinition({ ...call, effect: 'local_write' }) !== null;
}

/** The requirement an exact native write runs under, or null.
 *
 * A requirement id copied from ANOTHER configured local operation (the one the
 * model used a step earlier) is a label slip, not a different request: the
 * named operation and its arguments are the call. When exactly one current
 * write definition of the named operation matches those arguments, that
 * definition is the requirement, published the same way as above. An id that
 * names no configured local operation, or arguments that match no single
 * variant, keep the ordinary refusal. */
export async function resolveHostLocalCallRequirement(agent: object, call: LocalCall): Promise<string | null> {
  if (await prepareHostLocalCall(agent, call)) return call.capabilityRef;
  const namedOperation = /^cap:local:([^:]+):/.exec(call.capabilityRef)?.[1];
  const bound = preparations.get(agent);
  if (!bound || !namedOperation || namedOperation === call.operationId
    || !bound.configuredNames.has(namedOperation)
    || !isRegistryDeclaredLocalPlanningCapability(namedOperation)) return null;
  const current = await currentLocalWriteDefinitions(agent, call);
  if (current?.definitions.length !== 1) return null;
  const requirement = { ...call, capabilityRef: current.definitions[0]!.capabilityRef, effect: 'local_write' };
  if (!nominateDisclosedLocalPlanningDefinition(requirement)) {
    await disclosePrimaryModelPlanningCapabilities({ authority: current.authority, candidates: [current.candidate] });
  }
  return nominateDisclosedLocalPlanningDefinition(requirement) ? requirement.capabilityRef : null;
}

/** The named operation's current write definitions that match these exact
 * arguments, from the live registry and this agent's configured surface. */
async function currentLocalWriteDefinitions(agent: object, call: LocalCall) {
  const bound = preparations.get(agent);
  if (!bound || !bound.configuredNames.has(call.operationId)) return null;
  const current = snapshotPrimaryModelPlanningContext(bound.planning.authority);
  if (!current || current.identity.sessionId !== call.sessionId
    || current.identity.sourceUserSeq !== call.sourceUserSeq) return null;
  const candidate = await issueAuthorizedLocalPlanningDisclosureCandidate({
    name: call.operationId, carrier: 'work_call', configuredNames: bound.configuredNames,
  });
  if (!candidate || 'refused' in candidate) return null;
  const definitions = (inspectAuthorizedLocalPlanningDisclosureCandidates(candidate) ?? []).filter(definition => (
    definition.name === call.operationId && definition.descriptor.effect === 'local_write'
    && localPlanningArgumentsMatch(definition, call.args)
  ));
  return { authority: bound.planning.authority, candidate, definitions };
}
