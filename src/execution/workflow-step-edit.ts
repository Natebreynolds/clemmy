/**
 * Reversible workflow-step prompt edits — the apply path for the self-improvement
 * proposer's `workflow_step` kind (improvement-proposer.ts).
 *
 * A workflow that has accumulated run history can be improved by appending a
 * guidance line to a failing step's prompt. This is the lightest, safest edit to
 * a workflow DEFINITION: additive (never rewrites the author's prompt), validated
 * through the same checkWorkflowForWrite gate every workflow write passes, and
 * REVERSIBLE — the prior full definition is snapshotted before the write so a bad
 * change is one `revertStepEdit(id)` away.
 *
 * Deliberately avoids the agent runtime, so the proposer can import it without
 * pulling in the Doctor's model stack. Mirrors the Doctor's fix-backup discipline
 * (workflow-diagnosis.ts) but for proposer-applied edits, kept in its own backup
 * namespace.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from '../memory/db.js';
import { readWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
import { mismatchHint } from '../shared/edit-mismatch.js';
import { writeWorkflowAndSyncTriggers } from './workflow-write.js';
import { normalizeWorkflowSteps, prepareWorkflowUpdateForWrite, renderReadinessHold } from './workflow-authoring.js';

const BACKUPS_DIR = path.join(STATE_DIR, 'workflow-step-edit-backups');

export interface StepEditBackup {
  id: string;
  workflow: string;
  stepId: string;
  priorDefinition: WorkflowDefinition;
  description: string;
  createdAt: string;
}

export interface StepEditResult {
  ok: boolean;
  message: string;
  /** Set when the edit snapshotted a reversible backup. */
  backupId?: string;
  errors?: string[];
}

type RejectedStepEdit = StepEditResult & { ok: false };
interface PreparedStepEdit {
  ok: true;
  def: WorkflowDefinition;
  readinessHeld: boolean;
  repairs: string[];
}

function prepareStepEditedWorkflow(before: WorkflowDefinition, after: WorkflowDefinition): RejectedStepEdit | PreparedStepEdit {
  const prep = prepareWorkflowUpdateForWrite(before, after, { allowInvalidDisabled: false });
  if (prep.status === 'invalid') {
    return { ok: false, message: 'The edited workflow would fail validation; not applied.', errors: prep.errors };
  }
  return {
    ok: true,
    def: prep.def,
    readinessHeld: prep.status === 'readiness_gaps',
    repairs: prep.repairs,
  };
}

/** Deterministic backup id (no Date.now/random — derived from what changed +
 *  the timestamp the caller supplies), so it's stable and testable. */
function backupId(workflow: string, stepId: string, at: string): string {
  return 'wfedit-' + createHash('sha1').update(`${workflow}:${stepId}:${at}`).digest('hex').slice(0, 8);
}

function recordBackup(workflow: string, stepId: string, priorDefinition: WorkflowDefinition, description: string, at: string): string | null {
  try {
    mkdirSync(BACKUPS_DIR, { recursive: true });
    const id = backupId(workflow, stepId, at);
    const backup: StepEditBackup = { id, workflow, stepId, priorDefinition, description, createdAt: at };
    writeFileSync(path.join(BACKUPS_DIR, `${id}.json`), JSON.stringify(backup, null, 2));
    return id;
  } catch {
    return null;
  }
}

/**
 * Make a TARGETED, reversible find/replace edit to ONE step's prompt. The
 * `find` must appear VERBATIM in the current step prompt — that verbatim
 * requirement IS the grounding: an agent that didn't read the real definition
 * (via workflow_get) can't produce a matching find, so a blind edit fails with
 * a precise near-miss hint instead of silently clobbering the wrong thing.
 * Mirrors space_edit_view. Validated through checkWorkflowForWrite and
 * snapshotted (revertStepEdit) before writing. Returns ok:false (no mutation)
 * on a missing workflow/step, a non-matching find, or a validation failure.
 */
export function applyStepPromptEdit(
  workflow: string,
  stepId: string,
  find: string,
  replace: string,
  opts: { description?: string; nowIso?: string } = {},
): StepEditResult {
  const entry = readWorkflow(workflow);
  if (!entry) return { ok: false, message: `Workflow "${workflow}" not found.` };
  const def = entry.data;
  const idx = def.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return { ok: false, message: `Step "${stepId}" not found in "${workflow}".` };
  if (!find) return { ok: false, message: 'Empty find string — nothing to match.' };

  const prompt = def.steps[idx].prompt ?? '';
  const occurrences = prompt.split(find).length - 1;
  if (occurrences === 0) {
    const hint = mismatchHint(prompt, find);
    return {
      ok: false,
      message: hint && hint.matchedChars > 0
        ? `That find string isn't in step "${stepId}" — it matched the first ${hint.matchedChars} char(s), then your find had ${hint.findHad} but the step has ${hint.haystackHad}. Re-read with workflow_get("${workflow}", step:"${stepId}") and copy the exact characters (watch tabs vs spaces), then retry.`
        : `That find string isn't in step "${stepId}". Re-read with workflow_get("${workflow}", step:"${stepId}") and copy an exact snippet.`,
    };
  }

  const nextPrompt = prompt.split(find).join(replace);
  if (nextPrompt === prompt) return { ok: false, message: 'find and replace are identical — nothing to change.' };
  if (!nextPrompt.trim()) return { ok: false, message: 'That edit would empty the step prompt; a step must keep a prompt.' };

  const updated: WorkflowDefinition = {
    ...def,
    steps: def.steps.map((s, i) => (i === idx ? { ...s, prompt: nextPrompt } : s)),
  };
  const prepared = prepareStepEditedWorkflow(def, updated);
  if (!prepared.ok) return prepared;

  const at = opts.nowIso ?? new Date().toISOString();
  const id = recordBackup(workflow, stepId, def, opts.description ?? `find/replace edit to ${stepId}`, at);
  writeWorkflowAndSyncTriggers(workflow, prepared.def);
  const occNote = occurrences > 1 ? ` (replaced all ${occurrences} occurrences)` : '';
  const readinessNote = prepared.readinessHeld ? ` ${renderReadinessHold(workflow)}` : '';
  return {
    ok: true,
    backupId: id ?? undefined,
    message: id
      ? `Updated "${workflow}" step "${stepId}"${occNote}.${readinessNote} Revert with revertStepEdit("${id}") if it doesn't help.`
      : `Updated "${workflow}" step "${stepId}"${occNote} (backup unavailable — not reversible).${readinessNote}`,
  };
}

/** The step fields a targeted patch may change. Everything the authoring
 *  schema accepts for a step except its id; the host owns `call.account`. */
export const STEP_PATCH_FIELDS = [
  'prompt', 'call', 'transform', 'dependsOn', 'allowedTools', 'requiresApproval', 'approvalPreview',
  'inputs', 'output', 'sideEffect', 'forEach', 'forEachNewOnly', 'model', 'intent', 'tier', 'maxTurns',
  'useHarness', 'usesSkill', 'project', 'loopUntil', 'loopSafe', 'retryBudget', 'subgraph',
] as const;

/**
 * Make a TARGETED, reversible patch to ONE step: only the named fields change,
 * `null` removes a field, and the merged step passes the same normalization
 * and validation an authored step passes. This is the repair path for
 * everything that is not prompt text (a wrong call argument, a missing output
 * contract, an approval flag); it never needs the whole step graph resent.
 */
export function applyStepPatch(
  workflow: string,
  stepId: string,
  patch: Record<string, unknown>,
  opts: { description?: string; nowIso?: string } = {},
): StepEditResult {
  const entry = readWorkflow(workflow);
  if (!entry) return { ok: false, message: `Workflow "${workflow}" not found.` };
  const def = entry.data;
  const idx = def.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return { ok: false, message: `Step "${stepId}" not found in "${workflow}".` };
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, message: 'Empty patch — name at least one step field to change.' };
  if ('id' in patch && patch.id !== stepId) {
    return { ok: false, message: 'A patch cannot rename a step; edit the graph with workflow_update to change ids.' };
  }
  const allowed = new Set<string>(STEP_PATCH_FIELDS);
  const unknown = keys.filter((key) => key !== 'id' && !allowed.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown step field(s) in patch: ${unknown.join(', ')}. Patchable fields: ${STEP_PATCH_FIELDS.join(', ')}.`,
    };
  }
  const current = def.steps[idx] as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  let normalized: WorkflowDefinition['steps'][number];
  try {
    normalized = normalizeWorkflowSteps([merged as never])[0] as unknown as WorkflowDefinition['steps'][number];
  } catch (error) {
    return { ok: false, message: `That patch is not a valid step: ${error instanceof Error ? error.message : String(error)}` };
  }
  // A patch that does not touch the call keeps the host's own bindings on it
  // (the exact account the owner chose) byte for byte.
  if (!('call' in patch) && current.call !== undefined) {
    (normalized as unknown as Record<string, unknown>).call = current.call;
  }
  const changed = keys.filter((key) => key !== 'id' && JSON.stringify(current[key] ?? null) !== JSON.stringify((normalized as unknown as Record<string, unknown>)[key] ?? null));
  if (changed.length === 0) return { ok: false, message: 'That patch leaves the step exactly as it is — nothing to change.' };
  const updated: WorkflowDefinition = {
    ...def,
    steps: def.steps.map((s, i) => (i === idx ? normalized : s)),
  };
  const prepared = prepareStepEditedWorkflow(def, updated);
  if (!prepared.ok) return prepared;

  const at = opts.nowIso ?? new Date().toISOString();
  const id = recordBackup(workflow, stepId, def, opts.description ?? `patch to ${stepId} (${changed.join(', ')})`, at);
  writeWorkflowAndSyncTriggers(workflow, prepared.def);
  const readinessNote = prepared.readinessHeld ? ` ${renderReadinessHold(workflow)}` : '';
  return {
    ok: true,
    backupId: id ?? undefined,
    message: id
      ? `Updated "${workflow}" step "${stepId}" (${changed.join(', ')}).${readinessNote} Revert with revertStepEdit("${id}") if it doesn't help.`
      : `Updated "${workflow}" step "${stepId}" (${changed.join(', ')}) (backup unavailable — not reversible).${readinessNote}`,
  };
}

/**
 * Append a guidance line to a workflow step's prompt, reversibly. Validates the
 * edited workflow through checkWorkflowForWrite BEFORE writing — a proposed edit
 * can never write a workflow that would fail the gate. Returns ok:false (no
 * mutation) on a missing workflow/step or a validation failure.
 */
export function applyStepPromptAddendum(
  workflow: string,
  stepId: string,
  addendum: string,
  opts: { description?: string; nowIso?: string } = {},
): StepEditResult {
  const entry = readWorkflow(workflow);
  if (!entry) return { ok: false, message: `Workflow "${workflow}" not found.` };
  const def = entry.data;
  const idx = def.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return { ok: false, message: `Step "${stepId}" not found in "${workflow}".` };

  const line = addendum.trim();
  if (!line) return { ok: false, message: 'Empty addendum — nothing to apply.' };
  // Idempotent: never append the same guidance twice.
  if ((def.steps[idx].prompt ?? '').includes(line)) {
    return { ok: false, message: 'This guidance is already present on the step.' };
  }

  const updated: WorkflowDefinition = {
    ...def,
    steps: def.steps.map((s, i) => (i === idx ? { ...s, prompt: `${s.prompt}\n\n${line}` } : s)),
  };
  const prepared = prepareStepEditedWorkflow(def, updated);
  if (!prepared.ok) return prepared;

  const at = opts.nowIso ?? new Date().toISOString();
  const id = recordBackup(workflow, stepId, def, opts.description ?? `prompt addendum to ${stepId}`, at);
  writeWorkflowAndSyncTriggers(workflow, prepared.def);
  const readinessNote = prepared.readinessHeld ? ` ${renderReadinessHold(workflow)}` : '';
  return {
    ok: true,
    backupId: id ?? undefined,
    message: id
      ? `Updated "${workflow}" step "${stepId}".${readinessNote} Revert with revertStepEdit("${id}") if it doesn't help.`
      : `Updated "${workflow}" step "${stepId}" (backup unavailable — not reversible).${readinessNote}`,
  };
}

export function listStepEditBackups(): StepEditBackup[] {
  if (!existsSync(BACKUPS_DIR)) return [];
  return readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(path.join(BACKUPS_DIR, f), 'utf8')) as StepEditBackup; } catch { return null; } })
    .filter((x): x is StepEditBackup => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Restore the workflow to its pre-edit definition. Reverses a proposer-applied
 *  step edit that made things worse. */
export function revertStepEdit(id: string): StepEditResult {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(BACKUPS_DIR, `${safe}.json`);
  if (!existsSync(file)) return { ok: false, message: `No revertable step edit found with id "${id}".` };
  let backup: StepEditBackup;
  try { backup = JSON.parse(readFileSync(file, 'utf8')) as StepEditBackup; }
  catch { return { ok: false, message: `Step-edit backup "${id}" is unreadable.` }; }
  if (!readWorkflow(backup.workflow)) return { ok: false, message: `Workflow "${backup.workflow}" no longer exists.` };
  writeWorkflowAndSyncTriggers(backup.workflow, backup.priorDefinition);
  try { unlinkSync(file); } catch { /* best-effort */ }
  return { ok: true, message: `Reverted "${backup.workflow}" step "${backup.stepId}" to its pre-edit definition.` };
}
