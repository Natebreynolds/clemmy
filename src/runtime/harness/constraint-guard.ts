/**
 * Provider-neutral standing-policy kernel.
 *
 * Integration adapters compile natural language and normalize physical calls.
 * This module consumes only sealed descriptors and generic tags/fields. It
 * contains no provider, toolkit, slug, connection, or argument-shape parser.
 */
import {
  listCompiledConstraintStandingPolicies,
  listDispatchStandingPolicies,
  type CompiledConstraintStandingPolicy,
  type ConsolidatedFact,
  type DispatchStandingPolicy,
} from '../../memory/facts.js';
import type {
  StandingPolicyBinding,
  StandingPolicyCapabilityHint,
  StandingPolicyDirective,
  StandingPolicySelector,
} from '../../memory/policy-enforcement.js';

export interface ConstraintViolation {
  constraint: ConsolidatedFact;
  reason: string;
  toolName: string;
  violatingField: string;
  overrideAllowed?: boolean;
  recovery?: string;
}

export interface StandingPolicyDispatchContext {
  adapterId: string;
  toolName: string;
  tags: string[];
  /** Adapter-normalized fields. Shared code treats every key/value as opaque. */
  fields: Record<string, string | undefined>;
}

export interface StandingPolicyDirectiveMatch<T extends StandingPolicyDirective = StandingPolicyDirective> {
  constraint: ConsolidatedFact;
  policy: DispatchStandingPolicy;
  directive: T;
}

function selectorMatches(selector: StandingPolicySelector, context: StandingPolicyDispatchContext): boolean {
  if (selector.adapterId !== context.adapterId) return false;
  const tags = new Set(context.tags);
  return selector.allTags.every((tag) => tags.has(tag));
}

function policiesForAdapter(adapterId: string): DispatchStandingPolicy[] {
  return listDispatchStandingPolicies({ supportedAdapterIds: [adapterId] });
}

export function matchingStandingPolicyDirectives<T extends StandingPolicyDirective['kind']>(
  context: StandingPolicyDispatchContext,
  kind: T,
  options: { selector?: 'primary' | 'preference' } = {},
): Array<StandingPolicyDirectiveMatch<Extract<StandingPolicyDirective, { kind: T }>>> {
  const matches: Array<StandingPolicyDirectiveMatch<Extract<StandingPolicyDirective, { kind: T }>>> = [];
  for (const policy of policiesForAdapter(context.adapterId)) {
    if (!policy.descriptor.gateways.includes(context.toolName)) continue;
    for (const directive of policy.descriptor.directives) {
      if (directive.kind !== kind) continue;
      const selector = options.selector === 'preference' && directive.kind === 'verified_identity'
        ? directive.preferenceSelector
        : directive.selector;
      if (!selector || !selectorMatches(selector, context)) continue;
      matches.push({
        constraint: policy.constraint,
        policy,
        directive: directive as Extract<StandingPolicyDirective, { kind: T }>,
      });
    }
  }
  return matches;
}

function fieldDirectiveViolation(
  value: string | undefined,
  directive: Extract<StandingPolicyDirective, { kind: 'field_constraint' }>,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return directive.requirePresent;
  const values = directive.values.map((candidate) => candidate.toLowerCase());
  if (directive.operator === 'forbid_exact') return values.includes(normalized);
  if (directive.operator === 'forbid_contains') return values.some((candidate) => normalized.includes(candidate));
  return !values.some((candidate) => normalized.includes(candidate));
}

function syntheticRegistryViolation(toolName: string, error: unknown): ConstraintViolation {
  const now = new Date().toISOString();
  console.error('[constraint-guard] standing-policy registry unavailable:', error);
  return {
    constraint: {
      id: -1,
      kind: 'constraint',
      content: 'Hard-constraint registry unavailable; deterministic policy compliance could not be verified.',
      source: {},
      score: 10,
      active: true,
      createdAt: now,
      updatedAt: now,
      pinned: true,
    },
    reason: 'Clementine could not verify the sealed dispatch policies, so it failed closed.',
    toolName,
    violatingField: 'policy registry',
    overrideAllowed: false,
    recovery: 'Repair or recompile the standing-policy registry, then retry.',
  };
}

/** Evaluate generic deny/value/identity directives against a normalized call. */
export function checkStandingPolicyViolation(
  context: StandingPolicyDispatchContext,
  options: { externallyHandledKinds?: readonly StandingPolicyDirective['kind'][] } = {},
): ConstraintViolation | null {
  try {
    const externallyHandled = new Set(options.externallyHandledKinds ?? []);
    for (const policy of policiesForAdapter(context.adapterId)) {
      if (!policy.descriptor.gateways.includes(context.toolName)) continue;
      for (const directive of policy.descriptor.directives) {
        if (!selectorMatches(directive.selector, context) || externallyHandled.has(directive.kind)) continue;
        let violation = false;
        if (directive.kind === 'deny') violation = true;
        else if (directive.kind === 'field_constraint') {
          violation = fieldDirectiveViolation(context.fields[directive.field], directive);
        } else if (directive.kind === 'verified_identity') {
          const actual = context.fields[`identity:${directive.identityKind}`]?.trim().toLowerCase();
          violation = !actual || actual !== directive.requiredValue.trim().toLowerCase();
        }
        // Route directives are bindings, not denials; their adapter applies the
        // exact binding before dispatch and the ordinary account gate verifies it.
        if (!violation) continue;
        return {
          constraint: policy.constraint,
          reason: directive.reason,
          toolName: context.toolName,
          violatingField: directive.violatingField,
          overrideAllowed: directive.overrideAllowed,
          recovery: directive.recovery,
        };
      }
    }
  } catch (error) {
    return syntheticRegistryViolation(context.toolName, error);
  }
  return null;
}

export function standingPolicyCapabilityHints(adapterId: string): StandingPolicyCapabilityHint[] {
  const hints: StandingPolicyCapabilityHint[] = [];
  for (const policy of policiesForAdapter(adapterId)) {
    for (const hint of policy.descriptor.capabilityHints) {
      if (hint.adapterId === adapterId) hints.push(hint);
    }
  }
  return hints;
}

export function standingPoliciesForBinding(
  binding: StandingPolicyBinding,
  options: { includePrompt?: boolean } = {},
): Array<DispatchStandingPolicy | CompiledConstraintStandingPolicy> {
  const policies = options.includePrompt
    ? listCompiledConstraintStandingPolicies({ supportedAdapterIds: [binding.adapterId] })
    : policiesForAdapter(binding.adapterId);
  return policies.filter((policy) =>
    policy.descriptor.bindings.some((candidate) =>
      candidate.adapterId === binding.adapterId
      && candidate.kind === binding.kind
      && candidate.value === binding.value));
}

/**
 * Format a violation without implying a hard policy is bypassable. Only a
 * descriptor whose compiler explicitly set overrideAllowed offers override.
 */
export function formatConstraintEscalation(violation: ConstraintViolation): string {
  const resolution = violation.overrideAllowed
    ? 'Use the policy recovery above, or explicitly confirm the allowed override for this exact action.'
    : 'Change the approach as described above; this standing policy does not permit an execution override.';
  return [
    '⚠️  This action would violate a standing constraint:',
    '',
    `Constraint: "${violation.constraint.content}"`,
    `Issue: ${violation.reason}`,
    `Tool: ${violation.toolName} (field: ${violation.violatingField})`,
    ...(violation.recovery ? [`Recovery: ${violation.recovery}`] : []),
    '',
    resolution,
  ].join('\n');
}
