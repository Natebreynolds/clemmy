/**
 * AutomationOpportunityV1 is a review envelope for work that may deserve a
 * durable workflow. It is deliberately not an executable graph: phases carry
 * intent, dependencies, capability requirements, and ceilings, but no
 * executor identities or arguments. Compilation remains the responsibility of
 * the existing ProjectPlan / WorkDisposition boundaries after review.
 *
 * Recurrence is proposal-only here. There is no active/enabled state in this
 * contract, so parsing, hashing, persistence, or proposal approval cannot by
 * themselves schedule work.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { validateCronExpression } from '../shared/cron.js';
import type {
  ProjectApprovalDisposition,
  ProjectEffectClass,
} from './project-plan-ir.js';
import type { WorkDisposition } from './work-disposition.js';

export const AUTOMATION_OPPORTUNITY_VERSION = 1 as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DOT_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const MAX_TEXT = 4_096;
const MAX_SHORT_TEXT = 512;
const MAX_PHASES = 256;
const MAX_CAPABILITIES = 256;
const MAX_FIELDS = 512;
const MAX_COLLECTION = 1_024;
const MAX_BUDGET = 10_000_000;
const MAX_RUN_MINUTES = 10_080;
const MAX_CONCURRENT_PARTITIONS = 256;
const MAX_ATTEMPTS_PER_PARTITION = 20;

const PROJECT_EFFECT_CLASSES = [
  'read',
  'local_write',
  'external_write',
] as const satisfies readonly ProjectEffectClass[];

const PROJECT_APPROVAL_DISPOSITIONS = [
  'not_required',
  'required',
] as const satisfies readonly ProjectApprovalDisposition[];

const safeObjectKey = (value: string): boolean => !RESERVED_OBJECT_KEYS.has(value.toLowerCase());
const id = z.string().trim().regex(ID_RE).refine(safeObjectKey, 'reserved object key is not allowed');
const fieldName = z.string().trim().regex(FIELD_RE).refine(safeObjectKey, 'reserved object key is not allowed');
const dotPath = z.string().trim().regex(DOT_PATH_RE).refine(
  (value) => value
    .replace(/\[\d+\]/g, '')
    .split('.')
    .every(safeObjectKey),
  'reserved object path segment is not allowed',
);
const text = z.string().trim().min(1).max(MAX_TEXT);
const shortText = z.string().trim().min(1).max(MAX_SHORT_TEXT);
const positiveBudget = z.number().int().positive().max(MAX_BUDGET);
const nonNegativeBudget = z.number().int().nonnegative().max(MAX_BUDGET);

const lifetimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single_run') }).strict(),
  z.object({
    kind: z.literal('bounded_runs'),
    maximumRuns: positiveBudget,
  }).strict(),
  z.object({ kind: z.literal('ongoing') }).strict(),
]);

const cadenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    every: positiveBudget,
    unit: z.enum(['minute', 'hour', 'day']),
  }).strict(),
  z.object({
    kind: z.literal('calendar'),
    expression: shortText,
    timezone: shortText,
  }).strict(),
]);

const recurrenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({
    mode: z.literal('proposed'),
    cadence: cadenceSchema,
    overlapPolicy: z.enum(['skip', 'queue_one']),
    catchUpPolicy: z.enum(['skip', 'run_once']),
    activation: z.literal('requires_pilot_success_and_recurrence_consent'),
  }).strict(),
]);

const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('recurrence') }).strict(),
  z.object({
    kind: z.literal('event'),
    eventContract: shortText,
    dedupeKey: dotPath,
    capabilityRequirementId: id,
  }).strict(),
]);

const terminalEvidenceSchema = z.object({
  kind: z.literal('terminal_evidence'),
  evidence: z.array(shortText).min(1).max(MAX_COLLECTION),
}).strict();

const finiteCompletionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exact_count'),
    expected: positiveBudget,
  }).strict(),
  z.object({
    kind: z.literal('enumeration_exhausted'),
    evidence: z.array(shortText).min(1).max(MAX_COLLECTION),
  }).strict(),
]);

const partitionOutcomeAuthoritySchema = z.object({
  version: z.literal(1),
  kind: z.literal('workflow_read_aggregate'),
  acceptedTerminalStates: z.union([
    z.tuple([z.literal('completed')]),
    z.tuple([z.literal('completed'), z.literal('failed')]),
  ]),
}).strict();

const partitionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('single'),
    checkpointEvery: z.literal(1),
    completion: terminalEvidenceSchema,
    outcomeAuthority: partitionOutcomeAuthoritySchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal('finite'),
    keyFields: z.array(fieldName).min(1).max(32),
    dimensions: z.array(id).min(1).max(32),
    checkpointEvery: positiveBudget,
    completion: finiteCompletionSchema,
  }).strict(),
  z.object({
    mode: z.literal('open'),
    keyFields: z.array(fieldName).min(1).max(32),
    dimensions: z.array(id).min(1).max(32),
    checkpointEvery: positiveBudget,
    completion: z.object({
      kind: z.literal('per_run_boundary'),
      evidence: z.array(shortText).min(1).max(MAX_COLLECTION),
    }).strict(),
  }).strict(),
]);

const capabilityRequirementSchema = z.object({
  id,
  description: text,
  minimumEffect: z.enum(PROJECT_EFFECT_CLASSES),
  constraints: z.array(shortText).max(MAX_COLLECTION),
}).strict();

const phaseEffectSchema = z.object({
  class: z.enum(PROJECT_EFFECT_CLASSES),
  approval: z.enum(PROJECT_APPROVAL_DISPOSITIONS),
  maxOperationsPerRun: positiveBudget,
}).strict();

const phaseSchema = z.object({
  id,
  objective: text,
  dependsOn: z.array(id).max(MAX_PHASES),
  capabilityRequirementIds: z.array(id).max(MAX_CAPABILITIES),
  effect: phaseEffectSchema,
  partitioned: z.boolean(),
  outputEvidence: z.array(shortText).min(1).max(MAX_COLLECTION),
}).strict();

const effectCeilingSchema = z.object({
  class: z.enum(PROJECT_EFFECT_CLASSES),
  maxOperationsPerRun: positiveBudget,
}).strict();

const datasetFieldSchema = z.object({
  name: fieldName,
  type: z.enum(['string', 'number', 'boolean', 'timestamp', 'object', 'array']),
  required: z.boolean(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
}).strict();

const identityRuleSchema = z.object({
  id,
  fields: z.array(fieldName).min(1).max(32),
  match: z.enum(['exact', 'compound']),
  normalizers: z.array(z.enum([
    'trim',
    'case_fold',
    'unicode_nfkc',
    'numeric',
  ])).min(1).max(8),
}).strict();

const fieldMergePolicySchema = z.object({
  field: fieldName,
  onConflict: z.enum([
    'review_required',
    'keep_existing',
    'prefer_newer',
    'combine_unique',
  ]),
}).strict();

const entityDatasetSchema = z.object({
  schema: z.object({
    fields: z.array(datasetFieldSchema).min(1).max(MAX_FIELDS),
    additionalFields: z.enum(['reject', 'preserve']),
  }).strict(),
  identity: z.object({
    rules: z.array(identityRuleSchema).min(1).max(64),
    ambiguousMatch: z.enum(['review_required', 'keep_separate']),
  }).strict(),
  merge: z.object({
    mode: z.enum(['review_required', 'field_policy_after_exact_identity']),
    defaultConflict: z.enum(['review_required', 'keep_existing']),
    fieldPolicies: z.array(fieldMergePolicySchema).max(MAX_FIELDS),
    preserveSourceRecords: z.literal(true),
  }).strict(),
  provenance: z.object({
    required: z.literal(true),
    retainSourceSnapshots: z.literal(true),
    requiredReferences: z.array(z.enum([
      'source_ref',
      'run_ref',
      'observed_at',
    ])).min(3).max(3),
  }).strict(),
}).strict();

const successCriterionSchema = z.object({
  id,
  description: text,
  evidence: z.array(shortText).min(1).max(MAX_COLLECTION),
}).strict();

const deliverableSchema = z.object({
  id,
  description: text,
  kind: z.enum(['dataset_snapshot', 'artifact', 'notification', 'state_change']),
  required: z.boolean(),
  successCriterionIds: z.array(id).min(1).max(MAX_COLLECTION),
  evidence: z.array(shortText).min(1).max(MAX_COLLECTION),
}).strict();

const missingInputSchema = z.object({
  id,
  description: text,
  required: z.boolean(),
  blockingPhaseIds: z.array(id).max(MAX_PHASES),
}).strict();

const pilotSchema = z.object({
  required: z.boolean(),
  maxPartitions: positiveBudget,
  maxRecords: positiveBudget,
  effectCeiling: effectCeilingSchema,
  successCriterionIds: z.array(id).min(1).max(MAX_COLLECTION),
  haltOnFailure: z.literal(true),
}).strict();

const budgetsSchema = z.object({
  maxWallClockMinutesPerRun: z.number().int().positive().max(MAX_RUN_MINUTES),
  maxConcurrentPartitions: z.number().int().positive().max(MAX_CONCURRENT_PARTITIONS),
  maxAttemptsPerPartition: z.number().int().positive().max(MAX_ATTEMPTS_PER_PARTITION),
  maxPartitionsPerRun: positiveBudget,
  maxRecordsPerRun: positiveBudget,
  maxOperationsPerRun: positiveBudget,
  reserveOperations: nonNegativeBudget,
}).strict();

export const automationOpportunitySchema = z.object({
  version: z.literal(AUTOMATION_OPPORTUNITY_VERSION),
  title: shortText,
  objective: text,
  rationale: text,
  lifetime: lifetimeSchema,
  recurrence: recurrenceSchema,
  trigger: triggerSchema,
  partition: partitionSchema,
  capabilityRequirements: z.array(capabilityRequirementSchema).min(1).max(MAX_CAPABILITIES),
  phases: z.array(phaseSchema).min(1).max(MAX_PHASES),
  effectCeiling: effectCeilingSchema,
  dataset: entityDatasetSchema.optional(),
  deliverables: z.array(deliverableSchema).min(1).max(MAX_COLLECTION),
  missingInputs: z.array(missingInputSchema).max(MAX_COLLECTION),
  successCriteria: z.array(successCriterionSchema).min(1).max(MAX_COLLECTION),
  pilot: pilotSchema,
  budgets: budgetsSchema,
}).strict();

export type AutomationOpportunityV1 = z.infer<typeof automationOpportunitySchema>;
export type AutomationLifetimeV1 = AutomationOpportunityV1['lifetime'];
export type AutomationRecurrenceV1 = AutomationOpportunityV1['recurrence'];
export type AutomationTriggerV1 = AutomationOpportunityV1['trigger'];
export type AutomationPartitionContractV1 = AutomationOpportunityV1['partition'];
export type AutomationCapabilityRequirementV1 = AutomationOpportunityV1['capabilityRequirements'][number];
export type AutomationOpportunityPhaseV1 = AutomationOpportunityV1['phases'][number];
export type AutomationEntityDatasetV1 = NonNullable<AutomationOpportunityV1['dataset']>;

export type AutomationOpportunityValidation =
  | { ok: true; value: AutomationOpportunityV1 }
  | { ok: false; errors: string[] };

export class AutomationOpportunityValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid AutomationOpportunityV1:\n- ${errors.join('\n- ')}`);
    this.name = 'AutomationOpportunityValidationError';
    this.errors = errors;
  }
}

function effectRank(effect: ProjectEffectClass): number {
  return PROJECT_EFFECT_CLASSES.indexOf(effect);
}

function duplicateIds(values: readonly { id: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates].sort();
}

function duplicateStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function timezoneExists(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function phaseCycle(phases: readonly AutomationOpportunityPhaseV1[]): string[] | null {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (phaseId: string): string[] | null => {
    if (state.get(phaseId) === 'done') return null;
    if (state.get(phaseId) === 'visiting') {
      const start = stack.indexOf(phaseId);
      return [...stack.slice(start >= 0 ? start : 0), phaseId];
    }
    state.set(phaseId, 'visiting');
    stack.push(phaseId);
    for (const dependency of byId.get(phaseId)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(phaseId, 'done');
    return null;
  };

  for (const phase of phases) {
    const cycle = visit(phase.id);
    if (cycle) return cycle;
  }
  return null;
}

function structuralErrors(value: AutomationOpportunityV1): string[] {
  const errors: string[] = [];

  if (value.recurrence.mode === 'proposed') {
    if (value.lifetime.kind === 'single_run') {
      errors.push('single_run lifetime cannot propose recurrence');
    }
    if (value.trigger.kind !== 'recurrence') {
      errors.push('a recurrence proposal requires the recurrence trigger');
    }
    if (!value.pilot.required) {
      errors.push('recurring work requires a pilot');
    }
    if (value.recurrence.cadence.kind === 'calendar') {
      if (!validateCronExpression(value.recurrence.cadence.expression)) {
        errors.push('recurrence calendar expression is invalid');
      }
      if (!timezoneExists(value.recurrence.cadence.timezone)) {
        errors.push('recurrence timezone is invalid');
      }
    }
  } else if (value.trigger.kind === 'recurrence') {
    errors.push('the recurrence trigger requires an explicit recurrence proposal');
  }

  if (value.effectCeiling.class === 'external_write' && !value.pilot.required) {
    errors.push('an external_write opportunity requires a pilot');
  }

  for (const duplicate of duplicateIds(value.capabilityRequirements)) {
    errors.push(`duplicate capability requirement id "${duplicate}"`);
  }
  for (const duplicate of duplicateIds(value.phases)) {
    errors.push(`duplicate phase id "${duplicate}"`);
  }
  for (const duplicate of duplicateIds(value.deliverables)) {
    errors.push(`duplicate deliverable id "${duplicate}"`);
  }
  for (const duplicate of duplicateIds(value.missingInputs)) {
    errors.push(`duplicate missing input id "${duplicate}"`);
  }
  for (const duplicate of duplicateIds(value.successCriteria)) {
    errors.push(`duplicate success criterion id "${duplicate}"`);
  }

  const capabilityIds = new Set(value.capabilityRequirements.map((item) => item.id));
  const phaseIds = new Set(value.phases.map((phase) => phase.id));
  const criterionIds = new Set(value.successCriteria.map((criterion) => criterion.id));

  if (value.trigger.kind === 'event'
    && !capabilityIds.has(value.trigger.capabilityRequirementId)) {
    errors.push(`event trigger references unknown capability requirement "${value.trigger.capabilityRequirementId}"`);
  }

  for (const phase of value.phases) {
    if (phase.dependsOn.includes(phase.id)) {
      errors.push(`phase "${phase.id}" depends on itself`);
    }
    for (const dependency of phase.dependsOn) {
      if (!phaseIds.has(dependency)) {
        errors.push(`phase "${phase.id}" depends on unknown phase "${dependency}"`);
      }
    }
    for (const requirementId of phase.capabilityRequirementIds) {
      if (!capabilityIds.has(requirementId)) {
        errors.push(`phase "${phase.id}" references unknown capability requirement "${requirementId}"`);
      }
    }

    if (effectRank(phase.effect.class) > effectRank(value.effectCeiling.class)) {
      errors.push(`phase "${phase.id}" exceeds the opportunity effect ceiling`);
    }
    if (phase.effect.maxOperationsPerRun > value.effectCeiling.maxOperationsPerRun) {
      errors.push(`phase "${phase.id}" exceeds the opportunity operation ceiling`);
    }
    if (phase.effect.class === 'external_write' && phase.effect.approval !== 'required') {
      errors.push(`phase "${phase.id}" requests an external write without required approval`);
    }
    if (phase.effect.class !== 'external_write' && phase.effect.approval !== 'not_required') {
      errors.push(`phase "${phase.id}" requires approval without an external effect boundary`);
    }

    for (const requirementId of phase.capabilityRequirementIds) {
      const requirement = value.capabilityRequirements.find((item) => item.id === requirementId);
      if (requirement && effectRank(requirement.minimumEffect) > effectRank(phase.effect.class)) {
        errors.push(`phase "${phase.id}" grants less effect than capability requirement "${requirementId}" needs`);
      }
    }
    if (
      phase.effect.class !== 'read'
      && !phase.capabilityRequirementIds.some((requirementId) => (
        value.capabilityRequirements.find((item) => item.id === requirementId)?.minimumEffect
          === phase.effect.class
      ))
    ) {
      errors.push(`phase "${phase.id}" has no capability requirement for its ${phase.effect.class} effect`);
    }
  }

  const cycle = phaseCycle(value.phases);
  if (cycle) errors.push(`phases form a dependency cycle: ${cycle.join(' -> ')}`);

  for (const deliverable of value.deliverables) {
    for (const criterionId of deliverable.successCriterionIds) {
      if (!criterionIds.has(criterionId)) {
        errors.push(`deliverable "${deliverable.id}" references unknown success criterion "${criterionId}"`);
      }
    }
    if (deliverable.kind === 'state_change' && value.effectCeiling.class !== 'external_write') {
      errors.push(`deliverable "${deliverable.id}" requires an external_write opportunity ceiling`);
    }
    if (
      deliverable.kind === 'state_change'
      && !value.phases.some((phase) => phase.effect.class === 'external_write')
    ) {
      errors.push(`deliverable "${deliverable.id}" has no external_write phase`);
    }
  }

  for (const missing of value.missingInputs) {
    for (const phaseId of missing.blockingPhaseIds) {
      if (!phaseIds.has(phaseId)) {
        errors.push(`missing input "${missing.id}" blocks unknown phase "${phaseId}"`);
      }
    }
  }

  for (const criterionId of value.pilot.successCriterionIds) {
    if (!criterionIds.has(criterionId)) {
      errors.push(`pilot references unknown success criterion "${criterionId}"`);
    }
  }
  if (effectRank(value.pilot.effectCeiling.class) > effectRank(value.effectCeiling.class)) {
    errors.push('pilot effect ceiling exceeds the opportunity effect ceiling');
  }
  if (value.pilot.effectCeiling.maxOperationsPerRun > value.effectCeiling.maxOperationsPerRun) {
    errors.push('pilot operation ceiling exceeds the opportunity operation ceiling');
  }
  if (value.pilot.maxPartitions > value.budgets.maxPartitionsPerRun) {
    errors.push('pilot partition bound exceeds the per-run partition budget');
  }
  if (value.pilot.maxRecords > value.budgets.maxRecordsPerRun) {
    errors.push('pilot record bound exceeds the per-run record budget');
  }
  if (value.effectCeiling.maxOperationsPerRun > value.budgets.maxOperationsPerRun) {
    errors.push('effect ceiling exceeds the per-run operation budget');
  }
  if (value.budgets.reserveOperations >= value.budgets.maxOperationsPerRun) {
    errors.push('reserveOperations must leave at least one operation available');
  }
  if (value.budgets.maxConcurrentPartitions > value.budgets.maxPartitionsPerRun) {
    errors.push('concurrent partition budget exceeds the per-run partition budget');
  }

  if (value.partition.mode === 'finite' && value.partition.completion.kind === 'exact_count') {
    const minimumRuns = Math.ceil(
      value.partition.completion.expected / value.budgets.maxPartitionsPerRun,
    );
    if (value.lifetime.kind === 'single_run' && minimumRuns > 1) {
      errors.push('single_run lifetime cannot cover the declared partition count within its budget');
    }
    if (value.lifetime.kind === 'bounded_runs' && minimumRuns > value.lifetime.maximumRuns) {
      errors.push('bounded_runs lifetime cannot cover the declared partition count within its run budget');
    }
  }

  if (value.dataset) {
    const datasetFields = value.dataset.schema.fields;
    for (const duplicate of duplicateStrings(datasetFields.map((field) => field.name))) {
      errors.push(`duplicate dataset field "${duplicate}"`);
    }
    const fieldNames = new Set(datasetFields.map((field) => field.name));
    for (const duplicate of duplicateIds(value.dataset.identity.rules)) {
      errors.push(`duplicate identity rule id "${duplicate}"`);
    }
    for (const rule of value.dataset.identity.rules) {
      if (rule.match === 'compound' && rule.fields.length < 2) {
        errors.push(`compound identity rule "${rule.id}" requires at least two fields`);
      }
      for (const field of rule.fields) {
        if (!fieldNames.has(field)) {
          errors.push(`identity rule "${rule.id}" references unknown field "${field}"`);
        }
      }
    }
    for (const duplicate of duplicateStrings(value.dataset.merge.fieldPolicies.map((policy) => policy.field))) {
      errors.push(`duplicate merge policy for field "${duplicate}"`);
    }
    for (const policy of value.dataset.merge.fieldPolicies) {
      if (!fieldNames.has(policy.field)) {
        errors.push(`merge policy references unknown field "${policy.field}"`);
      }
    }
    const identityFields = new Set(
      value.dataset.identity.rules.flatMap((rule) => rule.fields),
    );
    for (const policy of value.dataset.merge.fieldPolicies) {
      if (
        identityFields.has(policy.field)
        && policy.onConflict !== 'keep_existing'
        && policy.onConflict !== 'review_required'
      ) {
        errors.push(`identity field "${policy.field}" cannot be changed by an automatic merge policy`);
      }
    }
    const requiredProvenance = new Set(value.dataset.provenance.requiredReferences);
    for (const reference of ['source_ref', 'run_ref', 'observed_at'] as const) {
      if (!requiredProvenance.has(reference)) {
        errors.push(`dataset provenance must require "${reference}"`);
      }
    }
  }

  return [...new Set(errors)].sort();
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function canonicalStringSet(values: readonly string[], normalize = normalizeText): string[] {
  return [...new Set(values.map(normalize))].sort((left, right) => left.localeCompare(right));
}

/** Canonicalize all set-like collections while preserving authored semantics. */
export function canonicalAutomationOpportunity(
  opportunity: AutomationOpportunityV1,
): AutomationOpportunityV1 {
  const canonicalPartition = (
    partition: AutomationPartitionContractV1,
  ): AutomationPartitionContractV1 => {
    if (partition.mode === 'single') {
      return {
        ...partition,
        completion: {
          ...partition.completion,
          evidence: canonicalStringSet(partition.completion.evidence),
        },
      };
    }
    if (partition.mode === 'finite') {
      return {
        ...partition,
        keyFields: canonicalStringSet(partition.keyFields, (value) => value.trim()),
        dimensions: canonicalStringSet(partition.dimensions, (value) => value.trim()),
        completion: partition.completion.kind === 'exact_count'
          ? { ...partition.completion }
          : {
            ...partition.completion,
            evidence: canonicalStringSet(partition.completion.evidence),
          },
      };
    }
    return {
      ...partition,
      keyFields: canonicalStringSet(partition.keyFields, (value) => value.trim()),
      dimensions: canonicalStringSet(partition.dimensions, (value) => value.trim()),
      completion: {
        ...partition.completion,
        evidence: canonicalStringSet(partition.completion.evidence),
      },
    };
  };
  const partition = canonicalPartition(opportunity.partition);

  const dataset = opportunity.dataset
    ? {
      schema: {
        ...opportunity.dataset.schema,
        fields: [...opportunity.dataset.schema.fields]
          .map((field) => ({ ...field, name: field.name.trim() }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      },
      identity: {
        ...opportunity.dataset.identity,
        rules: [...opportunity.dataset.identity.rules]
          .map((rule) => ({
            ...rule,
            fields: canonicalStringSet(rule.fields, (value) => value.trim()),
            normalizers: canonicalStringSet(rule.normalizers, (value) => value.trim()) as typeof rule.normalizers,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      },
      merge: {
        ...opportunity.dataset.merge,
        fieldPolicies: [...opportunity.dataset.merge.fieldPolicies]
          .map((policy) => ({ ...policy, field: policy.field.trim() }))
          .sort((left, right) => left.field.localeCompare(right.field)),
      },
      provenance: {
        ...opportunity.dataset.provenance,
        requiredReferences: canonicalStringSet(
          opportunity.dataset.provenance.requiredReferences,
          (value) => value.trim(),
        ) as typeof opportunity.dataset.provenance.requiredReferences,
      },
    }
    : undefined;

  const recurrence = opportunity.recurrence.mode === 'proposed'
    ? {
      ...opportunity.recurrence,
      cadence: opportunity.recurrence.cadence.kind === 'calendar'
        ? {
          ...opportunity.recurrence.cadence,
          expression: normalizeText(opportunity.recurrence.cadence.expression),
          timezone: opportunity.recurrence.cadence.timezone.trim(),
        }
        : { ...opportunity.recurrence.cadence },
    }
    : { ...opportunity.recurrence };

  return {
    ...opportunity,
    title: normalizeText(opportunity.title),
    objective: normalizeText(opportunity.objective),
    rationale: normalizeText(opportunity.rationale),
    lifetime: { ...opportunity.lifetime },
    recurrence,
    trigger: opportunity.trigger.kind === 'event'
      ? {
        ...opportunity.trigger,
        eventContract: normalizeText(opportunity.trigger.eventContract),
        dedupeKey: opportunity.trigger.dedupeKey.trim(),
      }
      : { ...opportunity.trigger },
    partition,
    capabilityRequirements: [...opportunity.capabilityRequirements]
      .map((requirement) => ({
        ...requirement,
        description: normalizeText(requirement.description),
        constraints: canonicalStringSet(requirement.constraints),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    phases: [...opportunity.phases]
      .map((phase) => ({
        ...phase,
        objective: normalizeText(phase.objective),
        dependsOn: canonicalStringSet(phase.dependsOn, (value) => value.trim()),
        capabilityRequirementIds: canonicalStringSet(
          phase.capabilityRequirementIds,
          (value) => value.trim(),
        ),
        outputEvidence: canonicalStringSet(phase.outputEvidence),
        effect: { ...phase.effect },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    effectCeiling: { ...opportunity.effectCeiling },
    ...(dataset ? { dataset } : {}),
    deliverables: [...opportunity.deliverables]
      .map((deliverable) => ({
        ...deliverable,
        description: normalizeText(deliverable.description),
        successCriterionIds: canonicalStringSet(
          deliverable.successCriterionIds,
          (value) => value.trim(),
        ),
        evidence: canonicalStringSet(deliverable.evidence),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    missingInputs: [...opportunity.missingInputs]
      .map((missing) => ({
        ...missing,
        description: normalizeText(missing.description),
        blockingPhaseIds: canonicalStringSet(missing.blockingPhaseIds, (value) => value.trim()),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    successCriteria: [...opportunity.successCriteria]
      .map((criterion) => ({
        ...criterion,
        description: normalizeText(criterion.description),
        evidence: canonicalStringSet(criterion.evidence),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    pilot: {
      ...opportunity.pilot,
      effectCeiling: { ...opportunity.pilot.effectCeiling },
      successCriterionIds: canonicalStringSet(
        opportunity.pilot.successCriterionIds,
        (value) => value.trim(),
      ),
    },
    budgets: { ...opportunity.budgets },
  };
}

/** Parse strictly, validate references/safety, then return canonical bytes. */
export function validateAutomationOpportunity(input: unknown): AutomationOpportunityValidation {
  const parsed = automationOpportunitySchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : 'opportunity';
      return `${location}: ${issue.message}`;
    });
    return { ok: false, errors: [...new Set(errors)].sort() };
  }

  const errors = structuralErrors(parsed.data);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: canonicalAutomationOpportunity(parsed.data) };
}

export function parseAutomationOpportunity(input: unknown): AutomationOpportunityV1 {
  const validation = validateAutomationOpportunity(input);
  if (!validation.ok) throw new AutomationOpportunityValidationError(validation.errors);
  return validation.value;
}

/** Stable JSON encoder used exclusively after strict validation. */
export function canonicalAutomationOpportunityJson(input: AutomationOpportunityV1): string {
  const encode = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new AutomationOpportunityValidationError(['non-finite number']);
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((entry) => encode(entry)).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    throw new AutomationOpportunityValidationError(['unsupported value in canonical encoding']);
  };

  return encode(parseAutomationOpportunity(input));
}

/** SHA-256 identity of the validated semantic contract. */
export function automationOpportunityDigest(input: AutomationOpportunityV1): string {
  return createHash('sha256')
    .update(canonicalAutomationOpportunityJson(input), 'utf8')
    .digest('hex');
}

export function isAutomationOpportunityDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * Narrow adapter boundary to the existing disposition vocabulary. It omits
 * kind, activation estimates, and manifest on purpose: those require canonical
 * runtime items and executor binding, neither of which a review proposal owns.
 */
export type AutomationOpportunityDispositionDraft = Pick<
  WorkDisposition,
  'objective' | 'successCriteria' | 'missingRequiredInputs' | 'effectCeiling'
>;

export function automationOpportunityToDispositionDraft(
  input: AutomationOpportunityV1,
): AutomationOpportunityDispositionDraft {
  const opportunity = parseAutomationOpportunity(input);
  const effectCeiling: WorkDisposition['effectCeiling'] = opportunity.effectCeiling.class === 'read'
    ? 'read'
    : 'write';
  return {
    objective: opportunity.objective,
    successCriteria: opportunity.successCriteria.map((criterion) => criterion.description),
    missingRequiredInputs: opportunity.missingInputs
      .filter((missing) => missing.required)
      .map((missing) => missing.description),
    effectCeiling,
  };
}
