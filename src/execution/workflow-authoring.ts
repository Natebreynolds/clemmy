import {
  type WorkflowDefinition,
  type WorkflowEventTrigger,
  type WorkflowInputDef,
  type WorkflowStepInput,
  type WorkflowTrigger,
} from '../memory/workflow-store.js';
import {
  workflowExecutionSurfaceChanged,
  prepareWorkflowForWrite,
  workflowNeedsCreationTest,
  type WorkflowWritePrep,
} from './workflow-enforce.js';
import {
  analyzeWorkflowGaps,
  type WorkflowGap,
} from './workflow-gap-test.js';
import { missingWorkflowRunInputs, normalizeWorkflowRunInputs } from './workflow-inputs.js';
import { validateCronExpression } from '../shared/cron.js';
export {
  deleteWorkflowAndSyncTriggers,
  syncWorkflowTriggersBestEffort,
  writeWorkflowAndSyncTriggers,
} from './workflow-write.js';

export interface WorkflowReadinessGapPayload {
  stepId?: string;
  question: string;
  why: string;
}

export interface WorkflowTriggerCreateInput {
  manual?: boolean;
  schedule?: string;
  timezone?: string;
  webhookPath?: string;
  events?: WorkflowEventTrigger[];
}

export interface WorkflowTriggerPatchInput {
  triggerSchedule?: string;
  clearTriggerSchedule?: boolean;
  timezone?: string;
  triggerWebhookPath?: string;
  clearTriggerWebhookPath?: boolean;
  triggerEvents?: WorkflowEventTrigger[];
  clearTriggerEvents?: boolean;
}

export type WorkflowPrepareStatus = 'ready' | 'invalid' | 'readiness_gaps';
export type WorkflowModelPortabilityPreference = 'preserve' | 'portable';

export interface WorkflowPreparedWrite {
  status: WorkflowPrepareStatus;
  def: WorkflowDefinition;
  errors: string[];
  repairs: string[];
  warnings: string[];
  gaps: WorkflowGap[];
}

export interface WorkflowVerificationPrep {
  needsTest: boolean;
  inputs: Record<string, string>;
  missing: string[];
}

interface WorkflowPrepareForWriteOptions {
  allowInvalidDisabled?: boolean;
  modelPortability?: WorkflowModelPortabilityPreference;
}

export function workflowSlugFromName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
}

export function workflowReadinessGapPayload(def: WorkflowDefinition): WorkflowReadinessGapPayload[] {
  return analyzeWorkflowGaps(def).map((gap) => ({
    ...(gap.stepId ? { stepId: gap.stepId } : {}),
    question: gap.question,
    why: gap.why,
  }));
}

export function workflowModelPortabilityFromUnknown(body: Record<string, unknown>): WorkflowModelPortabilityPreference {
  const raw = body.modelPortability ?? body.model_portability ?? body.portableModels ?? body.portable_models;
  if (raw === true || raw === 'portable' || raw === 'portable_models' || raw === 'any_model') return 'portable';
  return 'preserve';
}

export function renderReadinessHold(name: string): string {
  return `Workflow "${name}" stayed DISABLED because the readiness gap test still has unanswered questions. `
    + 'Answer/refine those gaps with workflow_update, then enable it.';
}

export function workflowDefaultRunInputs(def: WorkflowDefinition): Record<string, string> {
  return Object.fromEntries(Object.entries(def.inputs ?? {}).map(([k, m]) => [k, m.default ?? '']));
}

export function workflowSmokeInputs(def: WorkflowDefinition, provided: Record<string, string>): Record<string, string> {
  return normalizeWorkflowRunInputs({
    ...workflowDefaultRunInputs(def),
    ...provided,
  });
}

export function renderMissingSmokeInputs(name: string, missing: string[]): string {
  const quoted = missing.map((key) => `\`${key}\``).join(', ');
  const jsonHint = missing.map((key) => `"${key}": "<value>"`).join(', ');
  return `Verification did not start because the smoke test is missing ${quoted}. `
    + `The workflow stayed DISABLED so it cannot run blind. Provide \`test_inputs\` like {${jsonHint}} and enable/update again.`;
}

export function prepareWorkflowVerification(def: WorkflowDefinition, provided: Record<string, string> = {}): WorkflowVerificationPrep {
  const needsTest = workflowNeedsCreationTest(def);
  const inputs = workflowSmokeInputs(def, provided);
  return {
    needsTest,
    inputs,
    missing: needsTest ? missingWorkflowRunInputs(def, inputs) : [],
  };
}

export function workflowUpdateNeedsVerification(before: WorkflowDefinition, after: WorkflowDefinition): boolean {
  return before.enabled === true && workflowExecutionSurfaceChanged(before, after);
}

export function normalizeWorkflowSteps(steps: Array<Partial<WorkflowStepInput> & { id: string }>): WorkflowStepInput[] {
  return steps.map((s) => ({
    id: s.id,
    prompt: s.prompt ?? '',
    project: s.project,
    dependsOn: s.dependsOn,
    orderingOnlyDeps: s.orderingOnlyDeps,
    model: s.model,
    intent: s.intent,
    tier: s.tier,
    maxTurns: s.maxTurns,
    useHarness: s.useHarness,
    forEach: s.forEach,
    forEachNewOnly: s.forEachNewOnly,
    deterministic: s.deterministic,
    call: s.call,
    allowedTools: s.allowedTools,
    sideEffect: s.sideEffect,
    usesSkill: s.usesSkill,
    requiresApproval: s.requiresApproval,
    approvalPreview: s.approvalPreview,
    inputs: s.inputs,
    output: s.output,
    retryBudget: s.retryBudget,
    loopUntil: s.loopUntil,
    loopSafe: s.loopSafe,
  }));
}

export function validateWorkflowStepGraph(steps: Array<Pick<WorkflowStepInput, 'id' | 'dependsOn'>>): string | null {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return 'Duplicate workflow step IDs found.';
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) return `Step "${step.id}" depends on unknown step "${dep}".`;
    }
  }
  return null;
}

export function normalizeWorkflowModelPortability(
  def: WorkflowDefinition,
  preference: WorkflowModelPortabilityPreference = 'preserve',
  opts: { stepIds?: string[] } = {},
): { def: WorkflowDefinition; repairs: string[]; warnings: string[] } {
  if (preference !== 'portable') return { def, repairs: [], warnings: [] };
  const repairs: string[] = [];
  const scoped = new Set((opts.stepIds ?? []).filter(Boolean));
  const steps = def.steps.map((step) => {
    if (scoped.size > 0 && !scoped.has(step.id)) return step;
    const pinned = step.model?.trim();
    if (!pinned) return step;
    const { model: _drop, ...rest } = step;
    if (step.call?.tool || step.deterministic?.runner) {
      repairs.push(`Removed pinned model "${pinned}" from direct step "${step.id}" because it runs without a model.`);
    } else if (step.intent) {
      repairs.push(`Replaced pinned model "${pinned}" on step "${step.id}" with portable intent routing "${step.intent}".`);
    } else {
      repairs.push(`Replaced pinned model "${pinned}" on step "${step.id}" with portable default model routing.`);
    }
    return rest;
  });
  if (repairs.length === 0) return { def, repairs, warnings: [] };
  return { def: { ...def, steps }, repairs, warnings: [] };
}

export function buildWorkflowTrigger(input: WorkflowTriggerCreateInput = {}): { ok: true; trigger: WorkflowTrigger } | { ok: false; error: string } {
  const schedule = input.schedule?.trim() ?? '';
  const timezone = input.timezone?.trim() ?? '';
  const webhookPath = input.webhookPath?.trim() ?? '';
  const events = input.events;
  if (schedule && !validateCronExpression(schedule)) {
    return { ok: false, error: `invalid cron expression: "${schedule}"` };
  }
  return {
    ok: true,
    trigger: {
      manual: input.manual ?? true,
      ...(schedule ? { schedule } : {}),
      ...(timezone ? { timezone } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(events && events.length > 0 ? { events } : {}),
    },
  };
}

export function workflowTriggerCreateInputFromUnknown(body: Record<string, unknown>): { ok: true; input: WorkflowTriggerCreateInput } | { ok: false; error: string } {
  const nestedTrigger = body.trigger && typeof body.trigger === 'object' && !Array.isArray(body.trigger)
    ? body.trigger as { manual?: unknown; schedule?: unknown; timezone?: unknown; webhookPath?: unknown; events?: unknown }
    : undefined;
  if (nestedTrigger) {
    const allowed = new Set(['manual', 'schedule', 'timezone', 'webhookPath', 'events']);
    const unknown = Object.keys(nestedTrigger).filter((k) => !allowed.has(k));
    if (unknown.length > 0) return { ok: false, error: `unrecognized trigger field(s): ${unknown.join(', ')}` };
  }
  return {
    ok: true,
    input: {
      manual: typeof nestedTrigger?.manual === 'boolean' ? nestedTrigger.manual : true,
      schedule: typeof body.triggerSchedule === 'string'
        ? body.triggerSchedule
        : typeof nestedTrigger?.schedule === 'string' ? nestedTrigger.schedule : undefined,
      timezone: typeof body.timezone === 'string'
        ? body.timezone
        : typeof nestedTrigger?.timezone === 'string' ? nestedTrigger.timezone : undefined,
      webhookPath: typeof body.triggerWebhookPath === 'string'
        ? body.triggerWebhookPath
        : typeof nestedTrigger?.webhookPath === 'string' ? nestedTrigger.webhookPath : undefined,
      events: Array.isArray(body.triggerEvents)
        ? body.triggerEvents as WorkflowEventTrigger[]
        : Array.isArray(nestedTrigger?.events) ? nestedTrigger.events as WorkflowEventTrigger[] : undefined,
    },
  };
}

export function applyWorkflowTriggerPatch(
  current: WorkflowTrigger | undefined,
  patch: WorkflowTriggerPatchInput,
): { ok: true; trigger: WorkflowTrigger; changed: boolean } | { ok: false; error: string } {
  const existingTz = current?.timezone;
  const tz = patch.timezone?.trim() || existingTz;
  const withTz = <T extends Record<string, unknown>>(t: T): T => (tz ? { ...t, timezone: tz } : t);
  let nextTrigger: WorkflowTrigger = { ...(current ?? { manual: true }) };
  let changed = false;

  if (patch.clearTriggerSchedule === true) {
    const { schedule: _drop, ...rest } = nextTrigger;
    nextTrigger = withTz({ ...rest, manual: true }) as WorkflowTrigger;
    changed = true;
  } else if (patch.triggerSchedule !== undefined) {
    const schedule = patch.triggerSchedule.trim();
    if (schedule && !validateCronExpression(schedule)) {
      return { ok: false, error: `invalid cron: ${schedule}` };
    }
    if (schedule) nextTrigger = withTz({ ...nextTrigger, schedule, manual: nextTrigger.manual ?? true }) as WorkflowTrigger;
    else {
      const { schedule: _drop, ...rest } = nextTrigger;
      nextTrigger = withTz({ ...rest, manual: true }) as WorkflowTrigger;
    }
    changed = true;
  } else if (tz !== existingTz) {
    nextTrigger = withTz({ ...(current ?? { manual: true }) }) as WorkflowTrigger;
    changed = true;
  }

  if (patch.clearTriggerWebhookPath === true) {
    const { webhookPath: _drop, ...rest } = nextTrigger;
    nextTrigger = rest;
    changed = true;
  } else if (patch.triggerWebhookPath !== undefined) {
    const hook = patch.triggerWebhookPath.trim();
    if (hook) nextTrigger = { ...nextTrigger, webhookPath: hook };
    else {
      const { webhookPath: _drop, ...rest } = nextTrigger;
      nextTrigger = rest;
    }
    changed = true;
  }

  if (patch.clearTriggerEvents === true) {
    const { events: _drop, ...rest } = nextTrigger;
    nextTrigger = rest;
    changed = true;
  } else if (patch.triggerEvents !== undefined) {
    if (patch.triggerEvents.length > 0) nextTrigger = { ...nextTrigger, events: patch.triggerEvents };
    else {
      const { events: _drop, ...rest } = nextTrigger;
      nextTrigger = rest;
    }
    changed = true;
  }

  return { ok: true, trigger: nextTrigger, changed };
}

function preparedFromWrite(
  prep: WorkflowWritePrep,
  status: WorkflowPrepareStatus,
  def: WorkflowDefinition,
  gaps: WorkflowGap[] = [],
  extra: { repairs?: string[]; warnings?: string[] } = {},
): WorkflowPreparedWrite {
  return {
    status,
    def,
    errors: prep.errors,
    repairs: [...(extra.repairs ?? []), ...prep.repairs],
    warnings: [...(extra.warnings ?? []), ...prep.warnings],
    gaps,
  };
}

export function prepareWorkflowCreateForWrite(
  def: WorkflowDefinition,
  opts: Pick<WorkflowPrepareForWriteOptions, 'modelPortability'> = {},
): WorkflowPreparedWrite {
  const portability = normalizeWorkflowModelPortability(def, opts.modelPortability);
  const prep = prepareWorkflowForWrite(portability.def);
  if (portability.def.enabled && !prep.ok) return preparedFromWrite(prep, 'invalid', prep.def, [], portability);
  const gaps = analyzeWorkflowGaps(prep.def);
  const defToWrite = gaps.length > 0 ? { ...prep.def, enabled: false } : prep.def;
  return preparedFromWrite(prep, gaps.length > 0 ? 'readiness_gaps' : 'ready', defToWrite, gaps, portability);
}

export function prepareWorkflowUpdateForWrite(
  _before: WorkflowDefinition,
  next: WorkflowDefinition,
  opts: WorkflowPrepareForWriteOptions = {},
): WorkflowPreparedWrite {
  const portability = normalizeWorkflowModelPortability(next, opts.modelPortability);
  const prep = prepareWorkflowForWrite(portability.def);
  const allowInvalidDisabled = opts.allowInvalidDisabled ?? true;
  if ((!allowInvalidDisabled || prep.def.enabled) && !prep.ok) return preparedFromWrite(prep, 'invalid', prep.def, [], portability);
  if (prep.def.enabled) {
    const gaps = analyzeWorkflowGaps(prep.def);
    if (gaps.length > 0) {
      return preparedFromWrite(prep, 'readiness_gaps', { ...prep.def, enabled: false }, gaps, portability);
    }
  }
  return preparedFromWrite(prep, 'ready', prep.def, [], portability);
}

export function prepareWorkflowEnableForWrite(def: WorkflowDefinition): WorkflowPreparedWrite {
  const prep = prepareWorkflowForWrite({ ...def, enabled: true });
  if (!prep.ok) return preparedFromWrite(prep, 'invalid', prep.def);
  const gaps = analyzeWorkflowGaps(prep.def);
  if (gaps.length > 0) return preparedFromWrite(prep, 'readiness_gaps', { ...prep.def, enabled: false }, gaps);
  return preparedFromWrite(prep, 'ready', { ...prep.def, enabled: true });
}

export function normalizeWorkflowInputs(input: unknown): Record<string, WorkflowInputDef> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input as Record<string, WorkflowInputDef>;
}
