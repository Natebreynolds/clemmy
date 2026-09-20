import { workflowProjectCreationErrors } from '../execution/workflow-project-preflight.js';
import { requestsToolkitUse } from './workflow-toolkit-intent.js';
import { randomBytes } from 'node:crypto';
import { TOOL_REGISTRY } from './tool-registry.js';
import { listReviewedCliReadDescriptors } from '../runtime/harness/reviewed-cli-read-config.js';
import { currentManifestOperationContract } from '../runtime/harness/current-manifest-operation-semantics.js';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkflowStepOutputContractSchema } from './workflow-output-schema.js';
import {
  CRON_FILE,
} from '../memory/vault.js';
import {
  listWorkflows,
  readWorkflow,
  type WorkflowDefinition,
  type WorkflowEntry,
  type WorkflowResourceBinding,
  type WorkflowStepInput,
} from '../memory/workflow-store.js';
import { workflowExecutionSurfaceChanged, workflowNeedsCreationTest } from '../execution/workflow-enforce.js';
import { describeWorkflowPlainEnglish, describeWorkflowOneLine, describeCron, deriveStepDataSources, renderWorkflowDataSources } from '../execution/workflow-describe.js';
import { applyStepPromptEdit, revertStepEdit } from '../execution/workflow-step-edit.js';
import { validateCronExpression, getNextRun } from '../shared/cron.js';
import { deriveRunnerProvenance } from '../shared/runner-provenance.js';
import { draftWorkflowFromSession, type WorkflowDraft } from '../execution/trace-to-workflow.js';
import { preflightWorkflow } from '../execution/workflow-preflight.js';
import { applyWorkflowContractUpgrades, proposeWorkflowContractUpgrades, renderWorkflowContractProposalReport } from '../execution/workflow-contract-proposals.js';
import { listCachedToolkits } from '../integrations/composio/client.js';
import { clearWorkflowFailures } from '../execution/workflow-failure-ledger.js';
import { analyzeWorkflowGaps, renderWorkflowGapQuestions } from '../execution/workflow-gap-test.js';
import {
  applyWorkflowTriggerPatch,
  buildWorkflowTrigger,
  deleteWorkflowAndSyncTriggers,
  normalizeWorkflowResources,
  normalizeWorkflowSteps,
  prepareWorkflowCreateForWrite,
  prepareWorkflowEnableForWrite,
  prepareWorkflowUpdateForWrite,
  prepareWorkflowVerification,
  renderMissingSmokeInputs,
  renderReadinessHold,
  validateWorkflowStepGraph,
  warmExactScheduledSendSchemaAuthorityForWrite,
  workflowUpdateNeedsVerification,
  workflowSlugFromName,
  workflowSmokeInputs,
  writeWorkflowAndSyncTriggers,
  type WorkflowModelPortabilityPreference,
} from '../execution/workflow-authoring.js';
import {
  CRON_PROGRESS_DIR,
  CRON_RUNS_DIR,
  CRON_TRIGGERS_DIR,
  WORKFLOW_RUNS_DIR,
  ensureDir,
  textResult,
  nonWriteTextResult,
} from './shared.js';
import {
  getWorkflowImportJob,
  listRecentWorkflowImportJobs,
  startWorkflowFrameworkImport,
} from '../runtime/workflow-installer.js';
import {
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from '../execution/workflow-inputs.js';
import {
  buildWorkflowExecutionPlanWithReadiness,
  renderWorkflowVisualContract,
} from '../execution/workflow-run-readiness.js';
import type { WorkflowExecutionPlan } from '../dashboard/workflow-execution-plan.js';
import { listFinalFailedItems } from '../execution/workflow-events.js';
import {
  queueWorkflowCreationTest,
  requeueWorkflowFailedItemsFromRun,
} from './workflow-run-queue.js';
import {
  TURN_SCOPED_HOLD_STATUS,
  TURN_SCOPED_HOLD_LABEL,
  describeTurnScopedHold,
} from './workflow-turn-scoped-hold.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { isWorkflowImprovementSessionId } from '../execution/workflow-improvement-session.js';
import {
  listEvents,
  getSession,
} from '../runtime/harness/eventlog.js';
export { _setWorkflowDispatchEventAppenderForTests } from '../runtime/harness/workflow-chat-dispatch-prepare.js';
import {
  resolveWorkflowName,
  workflowNamesEqual,
  type ResolverEntry,
} from './workflow-resolve.js';
import { uniqueEnabledWorkflowMatch } from './named-workflow-match.js';
import { admitNamedWorkflowRunFromAcceptedSource } from './admit-named-workflow-run.js';
import { addNotification } from '../runtime/notifications.js';
import { notifyWorkflowAwaitingEnable } from '../execution/workflow-enable-inbox.js';
import { matchToolChoicesForStep, slugifyIntent, type StepToolChoiceMatch, type ToolChoiceRecord } from '../memory/tool-choice-store.js';
import { readDurableBindings, type RoleBinding } from '../runtime/harness/model-roles.js';
import {
  applyWorkflowVisualContractFixes,
  type WorkflowVisualContractFixKind,
} from '../execution/workflow-visual-contract-fixes.js';
import {
  certifyWorkflow,
  renderWorkflowCertification,
  type WorkflowCertification,
} from '../execution/workflow-certification.js';
import {
  buildWorkflowResourceBindingReportFromRuntime,
  renderWorkflowResourceBindingReport,
} from '../execution/workflow-resource-binding.js';
import {
  deriveWorkflowTerminalOutcome,
  workflowTerminalOutcomeLabel,
  workflowTerminalOutcomeNeedsAttention,
  type WorkflowTerminalOutcome,
} from '../execution/workflow-terminal-outcome.js';
import { withWorkflowCommit, workflowConsoleUrl } from '../execution/workflow-commit.js';

function originatingAcceptedUserText(): string {
  const ctx = getToolOutputContext();
  if (
    !ctx?.sessionId
    || !Number.isSafeInteger(ctx.sourceUserSeq)
    || (ctx.sourceUserSeq ?? 0) <= 0
  ) return '';
  const source = listEvents(ctx.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === ctx.sourceUserSeq);
  const display = typeof source?.data.displayText === 'string' ? source.data.displayText : '';
  const text = typeof source?.data.text === 'string' ? source.data.text : '';
  return (display || text).trim();
}

/**
 * Parse the workflow_run `inputs` field, which the model passes as a JSON
 * string (mirrors composio_execute_tool's `arguments`). A JSON-string param
 * fills reliably under the codex strict-mode function-calling that an open
 * `z.record` map does NOT (the map was emitted `{}` 223/223 in history).
 * Empty/whitespace → {}. Throws a descriptive error on malformed JSON so the
 * model self-corrects instead of looping. Values are coerced toward strings
 * downstream by normalizeWorkflowRunInputs.
 */
/**
 * Render non-blocking authoring advisories (output-contract / forEach hints)
 * into the workflow_create/_update tool result so the AUTHORING agent sees them
 * and can self-correct before relying on the workflow. Advisory only — the
 * write already succeeded. Empty string when there is nothing to flag, so a
 * clean authoring run is byte-identical.
 */
export interface AuthoredWorkflowResult {
  ok: boolean;
  errors: string[];
  savedDef: WorkflowDefinition;
  executionPlan: WorkflowExecutionPlan;
  repairs: string[];
  warnings: string[];
  boundNotes: string[];
  advisories: string[];
  gaps: ReturnType<typeof analyzeWorkflowGaps>;
}

/**
 * Canonical "author and persist a NEW workflow" core, shared by workflow_create
 * and workflow_from_session so promotion can never drift from the create path.
 * Binds proven tool-choices → auto-repairs + validates → persists (only when
 * valid) → gap-tests. Returns the structured result; each caller composes its
 * own response text. (This is the F4 consolidation, justified now that a second
 * real consumer — promotion — needs the exact same author behavior.)
 */
export function commitAuthoredWorkflow(
  def: WorkflowDefinition,
  dirName: string,
  opts: { modelPortability?: WorkflowModelPortabilityPreference } = {},
): AuthoredWorkflowResult {
  const routeNotes = autoTagStepsWithModelRoleIntents(def.steps);
  const bind = bindStepsToToolChoices(def.steps);
  const prep = prepareWorkflowCreateForWrite(def, { modelPortability: opts.modelPortability });
  const executionPlan = buildWorkflowExecutionPlanWithReadiness(prep.def, dirName);
  const errors = [...prep.errors, ...workflowProjectCreationErrors(prep.def.enabled, executionPlan.toolReadiness.items)];
  if (errors.length > 0) {
    return {
      ok: false, errors, savedDef: prep.def, executionPlan, repairs: prep.repairs,
      warnings: prep.warnings, boundNotes: [...routeNotes, ...bind.boundNotes, ...prep.codifyNotes], advisories: bind.advisories, gaps: [],
    };
  }
  writeWorkflowAndSyncTriggers(dirName, prep.def);
  return {
    ok: true, errors: [], savedDef: prep.def, executionPlan, repairs: prep.repairs,
    warnings: prep.warnings, boundNotes: [...routeNotes, ...bind.boundNotes, ...prep.codifyNotes], advisories: bind.advisories,
    gaps: prep.gaps,
  };
}

/** Build a WorkflowDefinition from a session-trace draft. Saved DISABLED so a
 *  reconstructed workflow is reviewed (and smoke-tested) before it can fire.
 *  Pure + exported for tests. */
export function draftToDefinition(name: string, draft: WorkflowDraft): WorkflowDefinition {
  return {
    name,
    description: `Reusable workflow built from a chat session (${draft.toolCallCount} action${draft.toolCallCount === 1 ? '' : 's'}).`,
    enabled: false,
    trigger: { manual: true },
    steps: draft.steps.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      forEach: s.forEach,
      allowedTools: s.allowedTools,
      output: s.output,
      ...(s.call ? { call: s.call } : {}),
      ...(s.requiresApproval ? { requiresApproval: true, approvalPreview: s.approvalPreview } : {}),
    })),
  };
}

export interface PromotedSessionWorkflowResult {
  ok: boolean;
  status:
    | 'created'
    | 'no_session'
    | 'session_not_found'
    | 'invalid_name'
    | 'duplicate'
    | 'empty'
    | 'invalid_workflow';
  message: string;
  sessionId?: string;
  name?: string;
  slug?: string;
  draft?: WorkflowDraft;
  savedDef?: WorkflowDefinition;
  built?: AuthoredWorkflowResult;
  promoteBindNotes?: string[];
  preflight?: ReturnType<typeof preflightWorkflow>;
  errors?: string[];
}

export function promoteWorkflowFromSession(input: {
  name: string;
  sessionId?: string | null;
}): PromotedSessionWorkflowResult {
  const name = input.name.trim();
  const sid = input.sessionId?.trim() || getToolOutputContext()?.sessionId;
  if (!sid) {
    return {
      ok: false,
      status: 'no_session',
      message: 'I can\'t tell which chat to turn into a workflow (no session context). Run this from the chat where you did the work.',
    };
  }
  if (!getSession(sid)) {
    return {
      ok: false,
      status: 'session_not_found',
      sessionId: sid,
      message: `I couldn't find a chat session to promote${input.sessionId ? ` (no session "${input.sessionId}")` : ''}. Run this from the chat where you did the work.`,
    };
  }
  if (!/[a-zA-Z0-9]/.test(name)) {
    return {
      ok: false,
      status: 'invalid_name',
      sessionId: sid,
      message: 'Please give the workflow a name with at least one letter or number.',
    };
  }
  const dirName = workflowSlugFromName(name);
  if (readWorkflow(dirName)) {
    return {
      ok: false,
      status: 'duplicate',
      sessionId: sid,
      name,
      slug: dirName,
      message: `A workflow named "${name}" already exists — pick a different name, or update it with workflow_update.`,
    };
  }
  const draft = draftWorkflowFromSession(sid);
  if (draft.steps.length === 0) {
    return {
      ok: false,
      status: 'empty',
      sessionId: sid,
      name,
      slug: dirName,
      draft,
      message: `There's nothing to turn into a workflow yet: ${draft.notes[0] ?? 'no actions found in this chat.'}`,
    };
  }
  const def = draftToDefinition(name, draft);
  // Same citation-then-binding order as workflow_create: a step that already
  // names its operation is bound by that citation, not by a toolkit guess.
  recordAuthoredStepCitations(def.steps);
  const promoteBind = bindChatDiscussedToolkits(def.steps, sid);
  const built = commitAuthoredWorkflow(def, dirName);
  if (!built.ok) {
    return {
      ok: false,
      status: 'invalid_workflow',
      sessionId: sid,
      name,
      slug: dirName,
      draft,
      built,
      promoteBindNotes: promoteBind.boundNotes,
      errors: built.errors,
      message: `I couldn't build "${name}" from this chat — these need fixing first:\n- ${built.errors.join('\n- ')}`,
    };
  }
  return {
    ok: true,
    status: 'created',
    sessionId: sid,
    name,
    slug: dirName,
    draft,
    savedDef: built.savedDef,
    built,
    promoteBindNotes: promoteBind.boundNotes,
    preflight: preflightWorkflow(built.savedDef),
    message: `Built a draft workflow "${name}" from this chat — saved DISABLED so you can review before it runs.`,
  };
}

export function renderAuthoringAdvisories(warnings: string[] | undefined): string {
  if (!warnings || warnings.length === 0) return '';
  return `\n\nHeads up (advisory — the workflow was saved):\n- ${warnings.join('\n- ')}`;
}

function appendVisualContract(plan: WorkflowExecutionPlan | undefined): string {
  const block = renderWorkflowVisualContract(plan);
  return block ? `\n\n${block}` : '';
}

function renderWorkflowCertificationCommandHint(cert: WorkflowCertification): string {
  const quotedName = JSON.stringify(cert.workflow);
  switch (cert.state) {
    case 'needs_resource_binding':
      return `Next command: workflow_update name=${quotedName} resources='{"resource_id":{"kind":"sheet","toolkit":"googlesheets","resourceId":"<id or url>"}}'`;
    case 'needs_creation_inputs':
      return `Next command: workflow_certify name=${quotedName} test_inputs='{"${cert.missingTestInputs[0] ?? 'input'}":"<non-secret test value>"}'`;
    case 'needs_creation_test':
      return `Next command: workflow_set_enabled name=${quotedName} enabled=true test_inputs='<same test_inputs>'`;
    case 'ready_to_enable':
      return `Next command: workflow_set_enabled name=${quotedName} enabled=true`;
    case 'needs_run_inputs':
      return `Next command: workflow_run name=${quotedName} inputs='{"${cert.missingRunInputs[0] ?? 'input'}":"<value>"}'`;
    case 'ready_to_run':
      return `Next command: workflow_run name=${quotedName} inputs='<run inputs if any>'`;
    case 'needs_info':
      return `Next command: workflow_update name=${quotedName} ...`;
    case 'blocked':
      return `Next command: fix the listed blockers, then rerun workflow_certify name=${quotedName}`;
  }
}

/** Author-time data-source review block (trailing-padded for the response body),
 *  or '' when no step has a derivable source. Surfaced on create/update so a
 *  wrong connector binding is caught the moment it's authored. */
function appendDataSources(def: WorkflowDefinition): string {
  const block = renderWorkflowDataSources(def);
  return block ? `${block}\n\n` : '';
}

export interface StepBindResult {
  /** Confirmation lines from explicit authoring bindings. */
  boundNotes: string[];
  /** Optional retrieval candidates; never binding or required work. */
  advisories: string[];
}

/** Marker delimiting the engine-appended bind directive from the author's
 *  prompt. A step carrying it is already engine-bound (skip + don't re-match the
 *  directive's own prose, which would otherwise let a 2nd workflow_update bind a
 *  different choice off boilerplate words). */
const BIND_DIRECTIVE_MARKER = '\n\n→ Proven tool (engine-bound):';

function slugContainsPhrase(haystackSlug: string, phraseSlug: string): boolean {
  if (!haystackSlug || !phraseSlug) return false;
  return `-${haystackSlug}-`.includes(`-${phraseSlug}-`);
}

function stepMatchesIntent(step: Pick<WorkflowStepInput, 'id' | 'prompt'>, intent: string): boolean {
  const intentSlug = slugifyIntent(intent);
  if (!intentSlug) return false;
  const haystackSlug = slugifyIntent(`${step.id} ${step.prompt}`);
  if (slugContainsPhrase(haystackSlug, intentSlug)) return true;

  const tokens = intentSlug.split('-').filter(Boolean);
  // Multi-word user categories like "product design" should match a step that
  // says "design the product hero", but single-word categories stay exact.
  return tokens.length > 1 && tokens.every((token) => slugContainsPhrase(haystackSlug, token));
}

export function autoTagStepsWithModelRoleIntents(
  steps: Array<WorkflowStepInput | { id: string; prompt: string; intent?: string; model?: string }>,
  bindings: RoleBinding[] = readDurableBindings(),
): string[] {
  const workerIntents = bindings
    .filter((b) => b.role === 'worker' && typeof b.whenIntent === 'string' && b.whenIntent.trim().length > 0)
    .map((b) => ({ ...b, intentSlug: slugifyIntent(b.whenIntent as string) }))
    .filter((b) => b.intentSlug.length > 0)
    .sort((a, b) => b.intentSlug.length - a.intentSlug.length);
  if (workerIntents.length === 0) return [];

  const notes: string[] = [];
  for (const step of steps) {
    if (step.intent || step.model) continue;
    const match = workerIntents.find((b) => stepMatchesIntent(step, b.intentSlug));
    if (!match) continue;
    step.intent = match.intentSlug;
    notes.push(`Step \`${step.id}\` auto-tagged intent \`${match.intentSlug}\` → worker model ${match.modelId}.`);
  }
  return notes;
}

/** Convert `{{var}}` placeholders to `<var>` so a baked command is GUIDANCE, not
 *  a workflow template token — otherwise checkMalformedTokens would reject the
 *  workflow on its own injected `{{soql}}`, and renderTemplate can't fill it. */
function neutralizeTemplatePlaceholders(s: string): string {
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '<$1>');
}

/** Lock a step's allowedTools to a bound family: keep any explicitly-allowed
 *  NON-composio tools the author listed, drop composio_* (the drift gateway),
 *  and ensure the family is present. A wildcard/empty list becomes the family. */
function lockAllowedToolsTo(existing: string[] | undefined, family: string[]): string[] {
  const kept = (existing ?? []).filter((t) => t && t !== '*' && !t.startsWith('composio'));
  return [...new Set<string>([...kept, ...family])];
}

/** Historical name retained for authoring callers. Remembered procedures are
 * retrieval candidates only: the authored step owns its effect, prompt and tool
 * scope. A prose overlap cannot create another operation or lock a tool family.
 * Omitted effects stay unspecified; they are never defaulted to read here. */
export function bindStepsToToolChoices(
  steps: Array<Pick<WorkflowStepInput, 'id' | 'prompt' | 'allowedTools' | 'usesSkill' | 'sideEffect' | 'call'>>,
  opts: { choices?: ToolChoiceRecord[] } = {},
): StepBindResult {
  const advisories: string[] = [];
  for (const step of steps) {
    if (step.usesSkill || step.call || step.prompt.includes(BIND_DIRECTIVE_MARKER)) continue;
    if (!step.sideEffect) continue;
    const effect = step.sideEffect === 'read' ? 'read' : 'write';
    let matches: StepToolChoiceMatch[];
    try { matches = matchToolChoicesForStep(step.prompt, { choices: opts.choices }); } catch { continue; }
    const top = matches.find((m) => !m.alreadyBound && m.effectClass === effect);
    if (!top) continue;
    advisories.push(
      `Optional discovery candidate for step \`${step.id ?? '?'}\`: remembered ${top.kind} \`${neutralizeTemplatePlaceholders(top.command)}\`. Confirm that it serves the authored step and inspect its current argument and account contract before selecting it.`,
    );
  }
  return { boundNotes: [], advisories };
}

// ── Chat-aware toolkit binding (correct-by-construction authoring) ──────────
//
// The failure: a user asked "what's the best Facebook scraper" → Clem
// recommended Apify (available via Composio) → "build a workflow" → the scrape
// step was authored vaguely ("Apify if configured, else web scraping") and at
// run time improvised a raw urllib GET that returned nothing. The decision the
// chat established (use Apify) wasn't COMMITTED into the workflow.
//
// Fix: when a step's prompt NAMES a Composio toolkit that was discussed in this
// chat (and exists in the catalog), bind it concretely — lock allowedTools to
// the composio family and inject a firm directive to use that toolkit (and NOT
// improvise raw HTTP/manual scraping). High-precision (the step already named
// the toolkit + it was discussed + it's real), so it never over-fires.

const TOOLKIT_BIND_MARKER = '\n\n→ Toolkit (chat-bound):';

/** Catalog toolkits whose NAME appears in the recent chat text. Best-effort +
 *  sync; returns [] on any read failure. Names <4 chars are skipped (too noisy). */
function toolkitsDiscussedInChat(sessionId: string | undefined): Array<{ slug: string; name: string }> {
  if (!sessionId) return [];
  let toolkits: Array<{ slug: string; name: string }>;
  let chatText: string;
  try {
    toolkits = listCachedToolkits().map((t) => ({ slug: t.slug, name: t.name }));
    if (toolkits.length === 0) return [];
    const events = listEvents(sessionId, { types: ['user_input_received', 'conversation_completed'], limit: 60, desc: true });
    chatText = events
      .map((e) => {
        const d = e.data as Record<string, unknown>;
        return [d.text, d.reply, d.summary].filter((x): x is string => typeof x === 'string').join(' ');
      })
      .join(' \n ')
      .toLowerCase();
  } catch {
    return [];
  }
  if (!chatText) return [];
  const seen = new Set<string>();
  const out: Array<{ slug: string; name: string }> = [];
  for (const tk of toolkits) {
    const name = (tk.name ?? '').trim();
    if (name.length < 4 || seen.has(tk.slug)) continue;
    // Word-boundary, case-insensitive presence of the toolkit name in the chat.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(chatText)) { out.push({ slug: tk.slug, name }); seen.add(tk.slug); }
  }
  return out;
}

// A toolkit NAME followed by a content noun is the scrape TARGET (e.g.
// "Facebook page/posts"), not the tool to use — never bind those.
const TOOLKIT_TARGET_NOUN = /(?:page|pages|post|posts|profile|profiles|account|accounts|group|groups|feed|feeds|channel|channels|video|videos|story|stories|reel|reels)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this prompt name an exact operation — a reviewed CLI read or a
 *  registry tool — rather than a family of them? Data, not a tool list: the
 *  descriptor registry and the tool registry answer it. */
export function promptNamesExactOperation(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  try {
    for (const descriptor of listReviewedCliReadDescriptors()) {
      if (descriptor.operationId && lower.includes(descriptor.operationId.toLowerCase())) return true;
    }
  } catch {
    // A missing descriptor registry only means no reviewed read is named here.
  }
  return TOOL_REGISTRY.some((entry) => entry.name.includes('_') && lower.includes(entry.name.toLowerCase()));
}

// ── Authored-step citations ────────────────────────────────────────────────
//
// An authoring turn cites the exact operation IT calls. Until now it cited
// nothing for the steps of the workflow it AUTHORS: those operations lived only
// as prose inside a step prompt, so the toolkit binder below had to infer them
// at run time. Live 2026-09-18, that inference bound a Salesforce read to the
// Composio family the step's own prompt forbade, and validation then failed the
// workflow the same turn had just built.
//
// A citation is a FIELD, never a sentence: the operations an authored step
// names structurally, resolved against the current callable catalog by
// identity. Recording is strictly additive — a cited operation joins the step's
// tool scope, an uncited step keeps exactly the scope it already had.

/** The operations an authored step NAMES structurally — its direct call and any
 *  explicit tool scope. The prompt is deliberately not consulted. */
function namedOperationsOfAuthoredStep(
  step: Pick<WorkflowStepInput, 'allowedTools' | 'call'>,
): string[] {
  return [...(step.call?.tool ? [step.call.tool] : []), ...(step.allowedTools ?? [])]
    .map((name) => String(name ?? '').trim())
    .filter((name) => name.length > 0 && name !== '*');
}

/** Reopen each named operation from the CURRENT callable catalog. Identity
 *  decides, never tokens; an absent or ambiguous operation resolves to nothing,
 *  the same fail-closed reading publication already applies to a plan's own
 *  steps. Returns the canonical operation ids this step has cited. */
export function citedOperationsForAuthoredStep(
  step: Pick<WorkflowStepInput, 'allowedTools' | 'call'>,
): string[] {
  const cited: string[] = [];
  for (const named of namedOperationsOfAuthoredStep(step)) {
    let operationId: string | null = null;
    try { operationId = currentManifestOperationContract(named)?.operationId ?? null; } catch {
      // A catalog that cannot be read names no operation here.
    }
    if (operationId && !cited.includes(operationId)) cited.push(operationId);
  }
  return cited;
}

/** Land every resolved citation in the authored step's own tool scope, so
 *  nothing has to infer it later. UNION ONLY: this never removes a tool and
 *  never gives scope to a step that cited nothing, so a workflow that runs
 *  today runs identically after it. */
export function recordAuthoredStepCitations(
  steps: Array<Pick<WorkflowStepInput, 'id' | 'allowedTools' | 'call'>>,
): { citedNotes: string[] } {
  const citedNotes: string[] = [];
  for (const step of steps) {
    const cited = citedOperationsForAuthoredStep(step);
    if (cited.length === 0) continue;
    const scope = [...new Set<string>([...(step.allowedTools ?? []), ...cited])];
    const added = cited.filter((id) => !(step.allowedTools ?? []).includes(id));
    step.allowedTools = scope;
    if (added.length > 0) citedNotes.push(`Step \`${step.id}\` cites ${added.join(', ')}.`);
  }
  return { citedNotes };
}

/** Pure step-binder: commit a DISCUSSED toolkit into any step whose prompt NAMES
 *  it AS A TOOL (not as a scrape target) — lock the tool surface to composio +
 *  append a use-this-toolkit directive. Mutates the steps. Exported for tests so
 *  the precision (Apify-the-tool vs Facebook-the-target) is pinned without a DB. */
export function bindDiscussedToolkitsIntoSteps(
  steps: WorkflowDefinition['steps'],
  discussed: Array<{ slug: string; name: string }>,
): { boundNotes: string[] } {
  if (discussed.length === 0) return { boundNotes: [] };
  const boundNotes: string[] = [];
  for (const step of steps) {
    const prompt = step.prompt ?? '';
    if (!prompt || prompt.includes(TOOLKIT_BIND_MARKER)) continue;
    // A STEP THAT NAMES ITS EXACT OPERATION HAS ALREADY CHOSEN.
    //
    // Live 2026-09-18: a reviewed plan said "use only the authenticated local
    // sf CLI / salesforce_sf_soql_query; never use Composio Salesforce". The
    // toolkit name appeared twice — once as the exact thing to avoid — so this
    // binder locked the step to the composio family, the workflow's own
    // validation then failed it for holding that access, and the run was left
    // disabled. Naming an operation is a decision; a toolkit guess must not
    // overrule it, and a prohibition must never read as a request.
    if (promptNamesExactOperation(prompt)) continue;
    // A STEP CARRYING A RESOLVED CITATION HAS ALREADY BEEN BOUND.
    //
    // The structural half of the rule above: the prompt check reads a sentence,
    // this reads the step's own fields against the current catalog. A cited
    // step needs no toolkit guess and must never be widened into one.
    if (citedOperationsForAuthoredStep(step).length > 0) continue;
    const named = discussed.find((tk) => {
      const nm = escapeRe(tk.name);
      if (!new RegExp(`\\b${nm}\\b`, 'i').test(prompt)) return false;
      // Skip when the name reads as a TARGET ("<name> page/posts/…").
      if (new RegExp(`\\b${nm}\\b\\s+(?:\\w+\\s+){0,1}${TOOLKIT_TARGET_NOUN.source}`, 'i').test(prompt)) return false;
      // Skip a prohibition: "never use <name>", "not via <name>", "without <name>".
      if (new RegExp(`\\b(?:never|not|no|avoid|without|don'?t|do not|rather than|instead of)\\b[^.!?\\n]{0,60}\\b${nm}\\b`, 'i').test(prompt)) return false;
      // A report may mention both a provider and "crawl" or "actor" without
      // requesting another call. Require an explicit instruction to use it.
      return requestsToolkitUse(prompt, tk.name);
    });
    if (!named) continue;
    step.allowedTools = lockAllowedToolsTo(step.allowedTools, ['composio_execute_tool', 'composio_search_tools']);
    step.prompt = `${prompt}${TOOLKIT_BIND_MARKER} use the ${named.name} toolkit via composio (run composio_search_tools to find the exact ${named.name} action, then composio_execute_tool). Do NOT improvise raw HTTP / urllib / manual scraping — if ${named.name} can't return the data, stop with a clear blocked status and reason instead of silently falling back.`;
    boundNotes.push(`🔗 Bound step \`${step.id}\` to the ${named.name} toolkit (you discussed it in this chat) and locked off raw-HTTP improvisation.`);
  }
  return { boundNotes };
}

/** Commit a chat-discussed toolkit into any step that names it. Reads the chat
 *  (catalog toolkits named in the recent session text), then delegates to the
 *  pure binder above. */
export function bindChatDiscussedToolkits(
  steps: WorkflowDefinition['steps'],
  sessionId: string | undefined,
): { boundNotes: string[] } {
  return bindDiscussedToolkitsIntoSteps(steps, toolkitsDiscussedInChat(sessionId));
}

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finalizing',
  'parked',
  'blocked_capability',
  'blocked_mutation',
  // A run held for the turn-end seal IS active — it is about to run, and it was
  // the run the model had just started. Excluding it filed the one run the user
  // was asking about under "recent", or hid it entirely past the five-row slice.
  TURN_SCOPED_HOLD_STATUS,
]);

function formatRunAge(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Render a compact overview of workflow runs for chat recall ("what's running?"):
 * every in-flight (queued/running/finalizing/parked/dependency/mutation-review) or needs-attention run, plus the few
 * most-recent finished ones. Reads the run-record files directly — token-cheap.
 */
export function renderWorkflowRunsOverview(limit = 15): string {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return 'No workflow runs yet — nothing is running.';
  interface RunRow {
    id: string;
    workflow: string;
    status: string;
    createdAt?: string;
    needsAttention?: boolean;
    terminalOutcome?: WorkflowTerminalOutcome;
  }
  const rows: RunRow[] = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      if (typeof r.id !== 'string') continue;
      const terminalOutcome = deriveWorkflowTerminalOutcome({
        status: r.status,
        finishedAt: r.finishedAt,
        needsAttention: r.needsAttention,
        terminalOutcome: r.terminalOutcome,
        reportBack: r.reportBack && typeof r.reportBack === 'object' && !Array.isArray(r.reportBack)
          ? { outcome: (r.reportBack as Record<string, unknown>).outcome }
          : undefined,
      });
      rows.push({
        id: r.id,
        workflow: typeof r.workflow === 'string' ? r.workflow : '(unknown)',
        status: typeof r.status === 'string' ? r.status : 'unknown',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
        needsAttention: r.needsAttention === true
          || r.status === 'blocked_capability'
          || r.status === 'blocked_mutation'
          || workflowTerminalOutcomeNeedsAttention(terminalOutcome),
        terminalOutcome,
      });
    } catch { /* skip malformed run file */ }
  }
  if (rows.length === 0) return 'No workflow runs yet — nothing is running.';
  const byCreated = (a: RunRow, b: RunRow) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  const active = rows.filter((r) => ACTIVE_RUN_STATUSES.has(r.status) || r.needsAttention).sort(byCreated);
  const recent = rows.filter((r) => !ACTIVE_RUN_STATUSES.has(r.status) && !r.needsAttention).sort(byCreated).slice(0, 5);
  const fmt = (r: RunRow) => {
    const state = r.terminalOutcome
      ? `outcome ${workflowTerminalOutcomeLabel(r.terminalOutcome)}`
      // Every other status reads as English; this one printed as a bare enum,
      // which is what a status looks like when nobody has explained it.
      : r.status === TURN_SCOPED_HOLD_STATUS
        ? TURN_SCOPED_HOLD_LABEL
        : r.status;
    return `- ${r.workflow} · ${state}${r.needsAttention ? ' · NEEDS ATTENTION' : ''} · run ${r.id}${r.createdAt ? ` · ${formatRunAge(r.createdAt)}` : ''}`;
  };
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(`${active.length} active run${active.length === 1 ? '' : 's'} (in-flight / needs attention):`);
    parts.push(...active.slice(0, limit).map(fmt));
  } else {
    parts.push('No workflows are running right now.');
  }
  if (recent.length > 0) {
    parts.push('', 'Recently finished:', ...recent.map(fmt));
  }
  return parts.join('\n');
}

export function parseWorkflowRunInputsJson(raw: string | null | undefined): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid workflow inputs JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workflow inputs must be a JSON object, e.g. {"url":"https://example.com"}.');
  }
  return parsed as Record<string, string>;
}

/**
 * Parse the workflow_create/_update `inputs` SCHEMA field — a JSON string
 * mapping input names to per-input metadata {type?, default?, description?}.
 * Same JSON-string rationale as parseWorkflowRunInputsJson; distinct because
 * the values are objects, not flat strings.
 */
export function parseWorkflowInputsSchemaJson(
  raw: string | null | undefined,
): Record<string, { type?: 'string' | 'number'; default?: string; description?: string }> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid workflow inputs schema JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workflow inputs schema must be a JSON object mapping input names to {type, default, description}.');
  }
  return parsed as Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
}

/**
 * Parse workflow_create/_update `resources` — durable source/account/object
 * bindings, not per-run inputs. Keep this a JSON string for the same function
 * calling reliability reason as `inputs`.
 */
export function parseWorkflowResourcesJson(
  raw: string | null | undefined,
): Record<string, WorkflowResourceBinding> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid workflow resources JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workflow resources must be a JSON object mapping resource ids to {kind, toolkit?, resourceId?/url?/name?, ...}.');
  }
  const resources = normalizeWorkflowResources(parsed);
  return resources ?? {};
}


const WorkflowStepInputBindingSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional()
    .describe('Expected value type for this step argument.'),
  required: z.boolean().optional()
    .describe('Defaults to true unless a default is supplied.'),
  from: z.string().optional()
    .describe('Binding source: input.<key>, steps.<id>.output[.path], item[.path], project.path, project.name, or date. Omit to bind from workflow input with the same name.'),
  default: z.unknown().optional()
    .describe('Literal fallback value when the source is absent.'),
  description: z.string().optional()
    .describe('One-line note on why the step needs this argument.'),
});

const WorkflowReadParallelSubgraphSchema = z.object({
  mode: z.literal('read_parallel_v1'),
  specialists: z.array(z.object({
    id: z.string().min(1).max(32)
      .describe('Stable specialist id within this reducer step.'),
    prompt: z.string().min(3)
      .describe('Narrow read-only analysis assignment over upstream results/artifacts.'),
    label: z.string().optional(),
    model: z.string().optional(),
    intent: z.string().optional(),
    maxTurns: z.number().int().min(1).max(20).optional(),
  })).min(2).max(6),
}).describe(
  'Compile this sideEffect:"read" step into 2–6 parallel result-only specialists, then run the authored step once as their reducer. '
  + 'Specialists cannot write, send, call external tools, nest fan-out, or request approval; put data-fetch and effect nodes elsewhere in the workflow graph.',
);

const STEP_INPUT_CONTRACT_DESC =
  'Argument bindings keyed by argument name; see each binding for source syntax. '
  + 'Declare inputs and output on mechanical single-tool steps to allow compilation to direct calls. '
  + 'Example: {"target":{"from":"input.domain","type":"string"}}.';

const STEP_OUTPUT_CONTRACT_DESC =
  'Verified before step completion; violations fail and report back instead of feeding downstream steps. '
  + 'Declare for downstream dependencies and always for the final deliverable; omit for free-form conversation. '
  + 'With forEach, object/string/number/boolean checks each item; array checks the aggregate [{itemKey,output}].';

const WorkflowLoopUntilSchema = z.object({
  maxAttempts: z.number().min(1).max(10).optional(),
  until: WorkflowStepOutputContractSchema.optional()
    .describe('Exit when output satisfies this contract, e.g. {"required_keys":["done"],"non_empty":["done"]}.'),
});

const WorkflowTriggerEventSchema = z.object({
  type: z.string().min(1).describe('System event type to subscribe to (e.g. "crm.lead.created").'),
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe('Shallow payload match — every entry must equal payload.<key> (dot-paths ok). Omit to fire on every event of this type.'),
  dedupeKey: z.string().optional()
    .describe('Template rendered against the payload (e.g. "lead-{{payload.id}}"). The same rendered key fires ONCE ever. Omit → dedupe on full payload hash.'),
});

const WORKFLOW_VISUAL_CONTRACT_FIX_KINDS = [
  'fix_graph_structure',
  'increase_concurrency',
  'make_fanout_resumable',
  'add_judge_gate',
  'confirm_tool_connection',
  'install_skill',
  'add_workflow_script',
  'select_local_project',
  'make_models_portable',
] as const satisfies readonly WorkflowVisualContractFixKind[];
const WorkflowVisualContractFixKindSchema = z.enum(WORKFLOW_VISUAL_CONTRACT_FIX_KINDS);

const LOOP_UNTIL_DESC =
  'Step-level loop whose exit condition is the step\'s own output contract (retry until the contract passes, bounded by maxAttempts). Use an exact read call when each attempt must observe external state. Plain LLM read steps may loop; write needs loopSafe; send never loops.';

// The cron TOOL surfaces (add_cron_job / cron_list / cron_run_history /
// trigger_cron_job / cron_progress_write) were retired; only cron_progress_read
// remains for the daemon's own CRON.md runner, which reads/writes CRON.md
// directly and is unaffected by this subtraction. safeName is kept for it.
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Thin alias so existing callsites that wanted `entry.file` keep working.
// The shared store returns WorkflowEntry with `filePath` + `layout`; we
// expose the basename here for log readability.
function listWorkflowFiles(): WorkflowEntry[] {
  return listWorkflows();
}

export function registerOrchestrationTools(server: McpServer): void {
  server.tool(
    'workflow_list',
    'List all workflows with description, steps, and trigger metadata.',
    {},
    async () => {
      const workflows = listWorkflowFiles();
      if (workflows.length === 0) return textResult('No workflows found.');
      return textResult(
        workflows
          .map(({ data }) => {
            // Plain-English one-liner (name — when · N steps · pauses for approval),
            // then the description so the user can pick the right one at a glance.
            const summary = describeWorkflowOneLine(data);
            const enabled = data.enabled ? '' : ' [disabled]';
            const desc = data.description ? `\n  ${data.description}` : '';
            return `**${summary}**${enabled}${desc}`;
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'workflow_contract_proposals',
    'Scan one workflow or all installed workflows and propose pinned goal, input, and step output-contract upgrades. Read-only by default; pass apply=true to persist safe metadata-only upgrades. Use before enabling old workflows or tagging a release.',
    {
      name: z.string().optional().describe('Optional workflow name. Omit to scan every installed workflow. Fuzzy names are resolved the same way workflow_get resolves them.'),
      include_clean: z.boolean().optional().describe('When true, include workflows with no proposed changes. Default false.'),
      apply: z.boolean().optional().describe('When true, apply safe metadata-only upgrades (declared inputs, pinned goals, output contracts). Default false.'),
    },
    async ({ name, include_clean, apply }) => {
      const all = listWorkflowFiles();
      if (all.length === 0) return textResult('No workflows found.');
      let targets = all;
      if (name) {
        let entry = all.find((w) => w.data.name === name);
        if (!entry) {
          const resolution = resolveWorkflowName(
            name,
            all.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
          );
          if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
            entry = all.find((w) => workflowNamesEqual(w.data.name, resolution.name));
          } else if (resolution.kind === 'ambiguous') {
            return textResult(
              `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_contract_proposals with that exact name.`,
            );
          }
        }
        if (!entry) {
          const names = all.map((w) => `"${w.data.name}"`).join(', ');
          return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
        }
        targets = [entry];
      }
      const proposals = targets
        .map((entry) => proposeWorkflowContractUpgrades(entry.data))
        .filter((proposal) => include_clean === true || proposal.needsUpgrade);
      const report = renderWorkflowContractProposalReport(proposals);
      if (apply !== true) return textResult(report, { maxChars: 40_000 });

      const byName = new Map(targets.map((entry) => [entry.data.name, entry]));
      const appliedLines: string[] = [];
      for (const proposal of proposals) {
        const entry = byName.get(proposal.workflowName);
        if (!entry) continue;
        const applied = applyWorkflowContractUpgrades(entry.data, proposal);
        if (applied.changes.length === 0) {
          appliedLines.push(`- ${proposal.workflowName}: no metadata changes needed.`);
          continue;
        }
        await warmExactScheduledSendSchemaAuthorityForWrite(applied.def);
        const prep = prepareWorkflowUpdateForWrite(entry.data, applied.def);
        if (prep.status === 'invalid') {
          appliedLines.push(`- ${proposal.workflowName}: NOT applied — repaired definition still has blocking issue(s): ${prep.errors.join('; ')}`);
          continue;
        }
        writeWorkflowAndSyncTriggers(path.basename(entry.dir), prep.def);
        appliedLines.push(`- ${proposal.workflowName}: ${[...applied.changes, ...prep.repairs].join(' ')}`);
      }
      return textResult(
        `${report}\n\nApplied workflow contract upgrades:\n${appliedLines.length ? appliedLines.join('\n') : '- No matching upgrades to apply.'}`,
        { maxChars: 40_000 },
      );
    },
  );

  server.tool(
    'workflow_apply_contract_fixes',
    'Apply safe, machine-readable fixes from a workflow visual contract. This is the repair path after workflow_create/update reports "Recommended contract fixes". It automatically handles metadata-only fixes like portable model routing and judge/output-contract gates, and reports manual-only fixes for missing skills, scripts, projects, graph edits, or account/tool connections. It never invents missing files/accounts.',
    {
      name: z.string().min(1).describe('Workflow name. Fuzzy names are resolved the same way workflow_get resolves them.'),
      fixes: z.array(WorkflowVisualContractFixKindSchema).optional()
        .describe('Specific visual-contract remediation kind(s) to apply. Omit to apply every currently visible safe fix and report the manual-only fixes.'),
      step_ids: z.array(z.string().min(1)).optional()
        .describe('Optional step filter. Use when applying a visual-contract fix to only the affected graph node(s).'),
      assume_stable_item_keys: z.boolean().optional()
        .describe('Only for make_fanout_resumable: true means each fan-out item has a stable id/key/slug, so write fan-out may be marked forEachNewOnly. Send fan-out is still not auto-fixed.'),
      dry_run: z.boolean().optional().describe('Preview changes without writing. Default false.'),
    },
    async ({ name, fixes, step_ids, assume_stable_item_keys, dry_run }) => {
      const all = listWorkflowFiles();
      let entry = all.find((w) => w.data.name === name);
      if (!entry) {
        const resolution = resolveWorkflowName(
          name,
          all.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
        );
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = all.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(
            `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_apply_contract_fixes with that exact name.`,
          );
        }
      }
      if (!entry) {
        const names = all.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }

      const fixed = applyWorkflowVisualContractFixes(entry.data, entry.name, {
        fixes,
        stepIds: step_ids,
        assumeStableItemKeys: assume_stable_item_keys === true,
      });
      let finalDef = fixed.def;
      let persisted = false;
      let prepRepairs: string[] = [];
      let readinessHold = '';
      if (fixed.changes.length > 0) {
        await warmExactScheduledSendSchemaAuthorityForWrite(fixed.def);
        const prep = prepareWorkflowUpdateForWrite(entry.data, fixed.def);
        if (prep.status === 'invalid') {
          return textResult(
            `Workflow "${entry.data.name}" contract fixes were NOT applied — the repaired definition still has blocking issue(s):\n- ${prep.errors.join('\n- ')}`
              + `\n\n${renderWorkflowVisualContract(fixed.beforePlan)}`,
            { maxChars: 40_000 },
          );
        }
        finalDef = prep.def;
        prepRepairs = prep.repairs;
        if (prep.status === 'readiness_gaps') readinessHold = renderReadinessHold(entry.data.name);
        if (dry_run !== true) {
          writeWorkflowAndSyncTriggers(entry.name, finalDef);
          persisted = true;
          addNotification({
            id: `workflow-contract-fixes-${entry.name}-${Date.now()}`,
            kind: 'workflow',
            title: `Workflow contract fixed: ${entry.data.name}`,
            body: `Applied ${fixed.changes.length} visual-contract fix${fixed.changes.length === 1 ? '' : 'es'}.`,
            createdAt: new Date().toISOString(),
            read: false,
            silent: true,
            metadata: {
              source: 'workflow_apply_contract_fixes',
              workflowName: entry.data.name,
              changed: fixed.changes,
            },
          });
        }
      }
      const finalPlan = buildWorkflowExecutionPlanWithReadiness(finalDef, entry.name);
      const lines = [
        dry_run === true
          ? `Workflow "${entry.data.name}" visual contract fix preview (no files changed).`
          : persisted
            ? `Workflow "${entry.data.name}" visual contract fixes applied.`
            : `Workflow "${entry.data.name}" has no automatic visual contract fixes to apply.`,
      ];
      const allChanges = [...fixed.changes, ...prepRepairs];
      if (allChanges.length > 0) {
        lines.push('', dry_run === true ? 'Would apply:' : 'Applied:', ...allChanges.map((change) => `- ${change}`));
      }
      if (fixed.skipped.length > 0) {
        lines.push('', 'Manual / not automatic:', ...fixed.skipped.map((skip) => `- ${skip}`));
      }
      if (readinessHold) lines.push('', readinessHold);
      const contract = renderWorkflowVisualContract(finalPlan);
      if (contract) lines.push('', contract);
      return textResult(lines.join('\n'), { maxChars: 40_000 });
    },
  );

  server.tool(
    'workflow_create',
    "Create a reusable workflow from the step graph you author. Saved goals apply to EVERY future run: express correctness against current inputs, not today's example answer. Verify example-specific expected values after the current run. "
      + "For absolute-path file work, omit project unless the user selected a verified configured workspace. A file's parent directory is not a project binding. "
      + "Choose the executor for each job: exact known tool/arguments use `call`; parsing, filtering, counts, sums and data shaping use `transform`; use a model prompt for reasoning that those executors cannot express. Do not turn deterministic arithmetic into a model step. Transforms are closed v1 JSON expressions; their schema lists the operations. Raw script runners are legacy and refused. "
      + "Keep meaningful steps and declare sideEffect (read/write/send), dependsOn for required upstream data, and output contracts for downstream consumers. `inputs` binds tool arguments from input.<key> or steps.<id>.output.<path>. Upstream outputs also arrive in STEP CONTEXT. Independent branches can run concurrently; forEach handles collections. Heavy read-only analysis can use subgraph read_parallel_v1 with 2–6 result-only specialists; keep fetches and effects separate. "
      + "Enabling provides one-time workflow consent; requiresApproval can pause irreversible actions. Sends never auto-retry; interrupted writes/sends need reconciliation. Declare loopSafe only for genuinely idempotent writes. A saved goal is checked at completion; max_attempts bounds re-pursuit and irreversible effects prevent replay. "
      + "Create directly under a new name; duplicates leave the existing workflow unchanged. Use workflow_list for discovery/comparison and workflow_get before updates. The host validates your graph and never invents missing business steps.",
    {
      name: z.string().min(1),
      description: z.string().min(1),
      enabled: z.boolean().optional().describe('False saves a disabled draft and keeps it disabled after verification. Omit for normal activation after successful verification.'),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().optional().describe('Model task; omit for call/transform. Dependencies arrive in STEP CONTEXT.upstream. Templates: {{steps.<id>.output}}, {{input.<key>}}, {{project.path}}, {{project.name}}, {{item}} with forEach.'),
        project: z.string().optional().describe('Configured workspace/project identity this step requires, not a file output directory. Use a verified configured name/path; otherwise omit. Omission inherits the workflow project.'),
        dependsOn: z.array(z.string()).optional().describe('Upstream step IDs; wait for these and receive their outputs in STEP CONTEXT.upstream.'),
        model: z.string().optional(),
        intent: z.string().optional().describe('Worker routing category, e.g. "design". Uses its bound worker model unless model is explicit.'),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional().describe('Array source (upstream output, input.<key>, or JSON array text). Runs per item; returns [{itemKey,output}]. Object/scalar contracts check items; array contracts check aggregate.'),
        forEachNewOnly: z.boolean().optional().describe('With forEach, skip items completed in prior runs using stable item.id/key/slug. Failed items retry next run.'),
        subgraph: WorkflowReadParallelSubgraphSchema.optional(),
        transform: z.string().optional().describe('PURE REVIEWED TRANSFORM as exact JSON text: {"version":1,"expression":<expr>}. Closed expr ops: literal(value), get(from input.<key> | steps.<id>.output[.<path>] | item[.<path>] inside map), jsonParse(value), jsonStringify(value), object(fields:[{key,value}]), array(items), count(value), map(value,each), sort(value,by:[{column,direction:"asc"|"desc"}]), unique(value,keys:[column]), select(value,where?,columns?,limit?), aggregate(value,groupBy:[column],metrics:[{fn:"count"|"sum"|"avg"|"min"|"max",column?}]). Metrics use fn, not op; count needs no column. Output keys are count or <fn>_<column> (for example sum_amount); rename with object/map if needed. No code, shell, network, files, tools, or ambient clock. Declare sideEffect:"read" and dependsOn for every referenced upstream step.'),
        call: z.object({
          tool: z.string().min(1).describe('Exact discovered tool name (e.g. read_file), not capabilityRef.'),
          args_json: z.string().optional().describe('Preferred JSON-object text; preserves nested types. Omit args. {{input.x}} templates resolve at execution.'),
          args: z.record(z.string(), z.unknown()).optional().describe('Legacy args; prefer args_json. Templates: {{input.x}}, {{steps.<id>.output[.path]}}, {{item[.path]}}, {{project.path}}, {{date}}. A sole template preserves the raw object/array.'),
        }).optional().describe('No model: invoke known tool/args. Use prompt for selection/ambiguity. read_file JSON content: steps.<id>.output.data.content; parse it. Composio retains {successful,data,...}; bind/verify data.records. forEach permits read calls only.'),
        allowedTools: z.array(z.string()).optional().describe('Allowed discovered tool names, not capabilityRef/variantId. Args select mode; omit to inherit workflow scope.'),
        usesSkill: z.string().optional().describe('Installed skills/ directory name. Prefer one reusable skill to many prompt steps.'),
        requiresApproval: z.boolean().optional(),
        approvalPreview: z.string().optional(),
        inputs: z.record(z.string(), WorkflowStepInputBindingSchema).optional().describe(STEP_INPUT_CONTRACT_DESC),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
        sideEffect: z.enum(['read', 'write', 'send']).optional().describe("Declare effect: read gathers data; write reversibly mutates local/remote state; send is irreversible email/publish/post. Sends never auto-retry; interrupted writes/sends halt on resume. Omission uses prose heuristics."),
        loopUntil: WorkflowLoopUntilSchema.optional().describe(LOOP_UNTIL_DESC),
        loopSafe: z.boolean().optional().describe('Assert this write is idempotent (e.g. stable-key upsert). Required for write loops; permits goal re-pursuit past it.'),
      })).min(1).describe('REQUIRED model-authored semantic graph. Include every business step in execution order/dependency form; the host validates and compiles this graph but does not invent missing steps.'),
      project: z.string().optional().describe('Verified configured workspace/project name or path. Omit for ordinary absolute-path file work; an output folder is not a project binding. Step-level project overrides it.'),
      trigger_schedule: z.string().optional(),
      trigger_once_at: z.string().optional().describe('One-time absolute ISO timestamp with Z or UTC offset. Use instead of trigger_schedule for a single future run; the host consumes the occurrence without a self-edit step.'),
      trigger_timezone: z.string().optional().describe('IANA schedule timezone, e.g. America/Los_Angeles. Set for user-local times.'),
      trigger_webhook_path: z.string().optional().describe('URL-safe slug for token-gated POST /api/hooks/workflows/<path>. Fires on incoming webhooks.'),
      trigger_events: z.array(WorkflowTriggerEventSchema).optional().describe('Fire on matching internal events (Composio, watcher, workflow). Prefer events over cron polling for arrivals.'),
      inputs: z.string().optional().describe('JSON text mapping workflow input names to {type?,default?,description?}, e.g. {"text":{"type":"string"}}. Distinct from steps[].inputs bindings. Event fields bind matching names; "payload" receives the whole event.'),
      resources: z.string().optional().describe('JSON durable bindings, e.g. {"lead_sheet":{"kind":"sheet","toolkit":"googlesheets","resourceId":"<id>"}} or {"calendar":{"kind":"workspace","id":"<slug>"}}. Fixed accounts, folders, channels, repos, CLIs and endpoints belong here, not run inputs.'),
      test_inputs: z.string().optional().describe('JSON concrete non-secret smoke-test inputs, e.g. {"url":"https://example.com"}. Required for external reads without input defaults; otherwise stays disabled pending verification.'),
      synthesis_prompt: z.string().optional(),
      portable_models: z.boolean().optional().describe('True removes per-step model pins, using intent/default routing. Omit/false preserves pins.'),
      allowSends: z.boolean().optional().describe('Allow autonomous sends/publishes without approval gates. Defaults to true (autonomous). Set false for strict mode: any send-looking step must then carry requiresApproval: true or the save is refused.'),
      goal: z.object({
        objective: z.string().min(4).describe('What a completed run must achieve — judged externally at run completion.'),
        success_criteria: z.array(z.string()).optional().describe('Reusable pass/fail rules for each run against its current inputs. Keep sample-specific expected values in the current acceptance check, not the saved goal, unless the user requires that constant on every run. File paths are checked deterministically; other criteria by a judge. Empty means judge the objective.'),
        max_attempts: z.number().min(1).max(3).optional().describe('Total run attempts (original + automatic re-pursuits). Default 2, ceiling 3 — re-pursuit re-runs the whole workflow.'),
      }).optional().describe('External completion check. Failure re-runs with feedback, bounded by max_attempts; never after an irreversible step. Exhaustion reports criterion evidence.'),
    },
    async ({ name, description, enabled, steps, project, trigger_schedule, trigger_once_at, trigger_timezone, trigger_webhook_path, trigger_events, inputs, resources, test_inputs, synthesis_prompt, portable_models, allowSends, goal }) => {
      // The already-running primary model owns semantic topology. Refuse a
      // missing graph even for direct/internal callers that bypass the tool
      // schema; keyword synthesis here would be a second, less-informed author.
      if (!steps || steps.length === 0) {
        return nonWriteTextResult('invalid_graph', 'Workflow was NOT created: provide at least one explicit model-authored semantic step. The host validates and compiles steps but does not infer a graph from description keywords.');
      }

      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return nonWriteTextResult('invalid_inputs', error instanceof Error ? error.message : String(error));
      }
      let resourceBindings: Record<string, WorkflowResourceBinding>;
      try {
        resourceBindings = parseWorkflowResourcesJson(resources);
      } catch (error) {
        return nonWriteTextResult('invalid_resources', error instanceof Error ? error.message : String(error));
      }
      let providedSmokeInputs: Record<string, string>;
      try {
        providedSmokeInputs = parseWorkflowRunInputsJson(test_inputs);
      } catch (error) {
        return nonWriteTextResult('invalid_test_inputs', error instanceof Error ? error.message : String(error));
      }
      const stepGraphError = validateWorkflowStepGraph(steps);
      if (stepGraphError) return nonWriteTextResult('invalid_graph', stepGraphError);
      const triggerResult = buildWorkflowTrigger({
        schedule: trigger_schedule,
        onceAt: trigger_once_at,
        timezone: trigger_timezone,
        webhookPath: trigger_webhook_path,
        events: trigger_events,
      });
      if (!triggerResult.ok) return nonWriteTextResult('invalid_trigger', triggerResult.error);

      if (!/[a-zA-Z0-9]/.test(name)) {
        return nonWriteTextResult('invalid_name', 'Please give the workflow a name with at least one letter or number.');
      }
      const dirName = workflowSlugFromName(name);
      // Changed nothing. Reported as a typed non-write so the settlement cannot
      // record it as a successful mutation (live 2026-09-07: it did, and the
      // committer then told the owner their unchanged file had drifted).
      if (readWorkflow(dirName)) {
        return nonWriteTextResult(
          'duplicate',
          // Deliberately does NOT offer workflow_update. Live 2026-09-07: with that
          // suggestion in the text, a create request whose name already existed was
          // "repaired" by overwriting the existing workflow's description — an
          // authorization the owner never gave. Creating and modifying someone's
          // existing artifact are different acts; only the safe repair belongs in a
          // repairable outcome.
          `Workflow "${name}" already exists, so nothing was created and it is unchanged. `
          + 'Create it under a different name, or stop and ask the user before changing the existing one.',
        );
      }

      let normalizedSteps: WorkflowStepInput[];
      try {
        normalizedSteps = normalizeWorkflowSteps(steps);
      } catch (error) {
        // Normalization is pure and precedes every write. Preserve that
        // negative outcome through the adapter instead of an SDK error string.
        return nonWriteTextResult('invalid_workflow', error instanceof Error ? error.message : String(error));
      }
      const def: WorkflowDefinition = {
        name,
        description,
        ...(typeof project === 'string' && project.trim() ? { project: project.trim() } : {}),
        enabled: enabled !== false,
        trigger: triggerResult.trigger,
        steps: normalizedSteps,
        ...(allowSends !== undefined ? { allowSends } : {}),
        ...(goal ? { goal: { objective: goal.objective, successCriteria: goal.success_criteria, maxAttempts: goal.max_attempts } } : {}),
        resources: Object.keys(resourceBindings).length > 0 ? resourceBindings : undefined,
        inputs: Object.keys(inputsSchema).length > 0 ? inputsSchema : undefined,
        synthesis: synthesis_prompt ? { prompt: synthesis_prompt } : undefined,
      };
      // Citations first: land every operation an authored step already names in
      // that step's own tool scope, so the binder below never has to infer one
      // and execution never has to rediscover it.
      recordAuthoredStepCitations(def.steps);
      // Chat-aware binding: commit any toolkit the user discussed in THIS chat
      // into the step that names it (e.g. "Apify" → lock the scrape step to
      // composio + a use-Apify directive) BEFORE validation/persist, so the
      // decision the chat established can't get dropped into a vague step.
      const chatBind = bindChatDiscussedToolkits(def.steps, getToolOutputContext()?.sessionId);
      // Part B — REAL creation-time test. When the workflow has a read-only step
      // that actually gathers external data (scrape/fetch/query), save it
      // DISABLED and run those steps for real against the tools first (mutating
      // steps are previewed, not executed); it auto-enables on a clean pass, or
      // stays disabled with a one-line fix if a read step returns nothing. This
      // is what stops a doomed workflow (acme: scrape step bound no tool,
      // improvised raw HTTP, returned empty, reported success) from being saved
      // live + untested. Pure-LLM / all-mutating workflows skip the gate
      // (nothing real to validate). External-read workflows with missing smoke
      // inputs stay disabled until `test_inputs` or input defaults can bind
      // a real creation test.
      const preWriteNeedsCreationTest = workflowNeedsCreationTest(def);
      if (preWriteNeedsCreationTest) def.enabled = false;
      await warmExactScheduledSendSchemaAuthorityForWrite(def);
      // Author through the canonical core (bind → auto-repair + validate →
      // persist → gap-test). Auto-repair saves a runnable workflow in one shot
      // instead of bouncing the author into a token-burning re-author loop;
      // refuse only if the repaired workflow still can't flow. Shared with
      // workflow_from_session so promotion can't drift from this path.
      const created = commitAuthoredWorkflow(def, dirName, {
        modelPortability: portable_models ? 'portable' : 'preserve',
      });
      if (!created.ok) {
        // The canonical core refused validation before its persistence call.
        return nonWriteTextResult('invalid_workflow',
          `Workflow "${name}" was NOT created — fix these first:\n- ${created.errors.join('\n- ')}`,
        );
      }
      const needsCreationTest = workflowNeedsCreationTest(created.savedDef);
      if (needsCreationTest && created.savedDef.enabled) {
        created.savedDef.enabled = false;
        writeWorkflowAndSyncTriggers(dirName, created.savedDef);
      }
      const createBindReport = [...chatBind.boundNotes, ...created.boundNotes].length > 0
        ? `\n\n${[...chatBind.boundNotes, ...created.boundNotes].join('\n')}` : '';
      const advisoryTail = `${renderAuthoringAdvisories([...created.repairs, ...created.warnings, ...created.advisories])}`
        + (created.gaps.length ? `\n\nOptional authoring review (does not block this workflow):${renderWorkflowGapQuestions(created.gaps)}` : '');
      if (needsCreationTest) {
        const testInputs = workflowSmokeInputs(created.savedDef, providedSmokeInputs);
        const missingSmokeInputs = missingWorkflowRunInputs(created.savedDef, testInputs);
        if (missingSmokeInputs.length > 0) {
          return textResult(withWorkflowCommit(
            dirName,
            `Created workflow "${name}" (saved DISABLED pending verification). Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
            + `${appendDataSources(created.savedDef)}`
            + `${appendVisualContract(created.executionPlan)}`
            + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}\n\n`
            + `${renderMissingSmokeInputs(name, missingSmokeInputs)}${advisoryTail}`,
          ));
        }
        const queued = queueWorkflowCreationTest(name, testInputs, {
          originSessionId: getToolOutputContext()?.sessionId,
          activateAfterCreationTest: enabled !== false,
        });
        return textResult(withWorkflowCommit(
          dirName,
          `Created workflow "${name}" (saved DISABLED while I test it). Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
          + `${appendDataSources(created.savedDef)}`
          + `${appendVisualContract(created.executionPlan)}`
          + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}\n\n`
          + `${queued.message}${advisoryTail}`,
        ));
      }
      return textResult(withWorkflowCommit(
        dirName,
        `Created workflow "${name}". Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
        + `${appendDataSources(created.savedDef)}`
        + `${appendVisualContract(created.executionPlan)}`
        + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}`
        + `${advisoryTail}`,
      ));
    },
  );

  server.tool(
    'workflow_from_session',
    'Turn what you JUST did in this chat into a reusable, repeatable workflow. Call this only when the user asks to save/repeat/automate what they just did (confirm with them first). It reads this session\'s tool-call trace, reconstructs the steps — locking each to the exact tool you actually used (so future runs are deterministic) and preserving any approval pause — and saves a DISABLED draft. Returns a plain-English summary to review. After saving, refine any step with workflow_update and enable it with workflow_set_enabled when it\'s ready.',
    {
      name: z.string().min(1).describe('A short name for the new workflow, e.g. "Weekly Prospect Outreach".'),
      sessionId: z.string().optional().describe('Defaults to the CURRENT chat session. Only pass this to promote a different session.'),
    },
    async ({ name, sessionId }) => {
      const promoted = promoteWorkflowFromSession({ name, sessionId });
      if (!promoted.ok) return textResult(promoted.message);
      const draft = promoted.draft as WorkflowDraft;
      const built = promoted.built as AuthoredWorkflowResult;
      const n = draft.toolCallCount;
      const preflight = promoted.preflight ?? preflightWorkflow(built.savedDef);
      const promoteBindReport = (promoted.promoteBindNotes?.length ?? 0) > 0 ? `\n\n${promoted.promoteBindNotes?.join('\n')}` : '';
      return textResult(
        `Built a draft workflow "${name}" from this chat — saved DISABLED so you can review before it runs.\n\n`
          + describeWorkflowPlainEnglish(built.savedDef)
          + `\n\n${appendDataSources(built.savedDef)}`.trimEnd()
          + appendVisualContract(built.executionPlan)
          + promoteBindReport
          + `\n\n${preflight.ok ? '✅' : '⚠️'} ${preflight.summary}`
          + `\n\nReconstructed from ${n} action${n === 1 ? '' : 's'} you took. Before enabling:\n- ${draft.notes.join('\n- ')}`
          + renderWorkflowGapQuestions(built.gaps)
          + `\n\nRefine any step with workflow_update, dry-run it to smoke-test, then enable it with workflow_set_enabled when it's ready.`,
      );
    },
  );

  server.tool(
    'workflow_certify',
    'One-door workflow certification. Use this before enabling or running a workflow: it composes readiness gaps, dry-run effects, creation-test requirements, missing inputs, visual-contract advisories, and the exact next command. Read-only; it never queues or enables by itself.',
    {
      name: z.string().min(1).describe('Workflow name. Fuzzy names are resolved the same way workflow_get resolves them.'),
      inputs: z.string().optional().describe('JSON object of run inputs to test whether workflow_run can queue now, e.g. {"url":"https://example.com"}.'),
      test_inputs: z.string().optional().describe('JSON object of concrete non-secret creation-test inputs, e.g. {"url":"https://example.com"}.'),
    },
    async ({ name, inputs, test_inputs }) => {
      let runInputs: Record<string, string>;
      let testInputs: Record<string, string>;
      try {
        runInputs = parseWorkflowRunInputsJson(inputs);
        testInputs = parseWorkflowRunInputsJson(test_inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }

      const all = listWorkflowFiles();
      let entry = all.find((w) => w.data.name === name);
      if (!entry) {
        const resolution = resolveWorkflowName(
          name,
          all.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
        );
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = all.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(
            `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_certify with that exact name.`,
          );
        }
      }
      if (!entry) {
        const names = all.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }

      const cert = certifyWorkflow(entry.data, {
        workflowSlug: entry.name,
        runInputs,
        testInputs,
      });
      return textResult(
        `${renderWorkflowCertification(cert)}\n\n${renderWorkflowCertificationCommandHint(cert)}`,
        { maxChars: 40_000 },
      );
    },
  );

  server.tool(
    'workflow_resource_proposals',
    'Inspect durable workflow resources and propose concrete bindings from connected Composio accounts, local CLIs, URL/project bindings, and cached capability inventory. Use after workflow_certify reports NEEDS RESOURCE BINDING, or before enabling a no-input recurring workflow that should remember sheets/accounts/folders/channels/campaigns across runs.',
    {
      name: z.string().min(1).describe('Workflow name. Fuzzy names are resolved the same way workflow_get resolves them.'),
    },
    async ({ name }) => {
      const all = listWorkflowFiles();
      let entry = all.find((w) => w.data.name === name);
      if (!entry) {
        const resolution = resolveWorkflowName(
          name,
          all.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
        );
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = all.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(
            `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_resource_proposals with that exact name.`,
          );
        }
      }
      if (!entry) {
        const names = all.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }
      const report = await buildWorkflowResourceBindingReportFromRuntime(entry.data);
      return textResult(renderWorkflowResourceBindingReport(report), { maxChars: 40_000 });
    },
  );

  server.tool(
    'workflow_run',
    'Dispatch a workflow to run in the BACKGROUND (fire-and-forget) — it runs in the daemon and reports its outcome back to this chat automatically on completion; you do not wait or poll. Call workflow_get first and pass every required input, for example inputs.url for URL-based audit workflows. Missing required inputs are rejected without queuing. '
      + 'You may pass the user\'s loose name (e.g. "prospecting flow"): if it is not an exact match the tool returns the CLOSEST workflow (or asks which of several) so you can confirm with the user — "Just to confirm, did you want me to kick off your <X> workflow? I\'ll report back once it\'s done." — then call again with that exact name. Only an exact name runs straight through.',
    {
      name: z.string().min(1),
      inputs: z.string().optional().describe('JSON object of the workflow\'s inputs, e.g. {"url":"https://example.com"}. Call workflow_get first to see the required input names.'),
    },
    async ({ name, inputs }) => {
      const all = listWorkflowFiles();
      const resolverEntries: ResolverEntry[] = all.map((e) => ({
        name: e.data.name,
        slug: path.basename(e.dir),
      }));
      // Match by NAME, not just the exact direct name: a user who says "kick off
      // my prospecting flow" should land on "Morning Prospect Prep" — but Clem
      // CONFIRMS the close match before running, and asks which one when several
      // fit. Only an exact name runs straight through.
      const resolution = resolveWorkflowName(name, resolverEntries);
      if (resolution.kind === 'none') {
        const names = resolverEntries.map((e) => `"${e.name}"`).join(', ');
        return textResult(
          resolverEntries.length === 0
            ? `No workflow matches "${name}", and there are no saved workflows. Just do the task directly.`
            : `No workflow closely matches "${name}". Saved workflows: ${names}. If the user meant one of these, confirm which and call workflow_run with its exact name; otherwise just do the task ad-hoc.`,
        );
      }
      if (resolution.kind === 'ambiguous') {
        const opts = resolution.candidates.map((c) => `"${c}"`).join(', ');
        return textResult(
          `"${name}" could mean more than one workflow: ${opts}. Ask the user which one they want — e.g. "Did you mean ${resolution.candidates.map((c) => `your ${c}`).join(' or ')}?" — then call workflow_run with that exact name.`,
        );
      }
      if (resolution.kind === 'fuzzy') {
        const turnMatch = uniqueEnabledWorkflowMatch(originatingAcceptedUserText());
        if (!turnMatch || !workflowNamesEqual(turnMatch.name, resolution.name)) {
          return textResult(
            `No workflow is named exactly "${name}". The closest match is "${resolution.name}". `
              + `Confirm with the user before running it — e.g. "Just to confirm, did you want me to kick off your ${resolution.name} workflow? I'll report back once it's done." — `
              + `then call workflow_run with name "${resolution.name}".`,
          );
        }
        // The accepted turn already uniquely named this workflow. Re-asking
        // for the same identity is a second confirmation of work the owner
        // already identified (live 2026-08-29: "run my platform 49 workflow").
      }
      // Exact (or accepted-source unique fuzzy) match → the shared admit path.
      // The old name-literal "unrequested workflow" guard was DELETED here
      // (live 2026-07-23): it refused a user-confirmed run because the slug
      // only appeared in the assistant's own question, and it manufactured a
      // robotic name-confirmation beat before every chat-triggered run. The
      // protection it aimed at (a silently-invoked workflow heading toward an
      // external write, 2026-05-31) is carried by the EFFECT layer now: every
      // irreversible send inside a run hits the approval gates and parks a
      // card in the origin chat. Constrain effects, not methods.
      let parsedInputs: Record<string, string>;
      try {
        parsedInputs = parseWorkflowRunInputsJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const toolCtx = getToolOutputContext();
      const admitted = admitNamedWorkflowRunFromAcceptedSource({
        workflowName: resolution.name,
        sessionId: toolCtx?.sessionId,
        sourceUserSeq: toolCtx?.sourceUserSeq,
        inputs: parsedInputs,
      });
      if (admitted.status === 'certification_failed') {
        const workflow = all.find((entry) => workflowNamesEqual(entry.data.name, admitted.workflowName));
        const cert = workflow
          ? certifyWorkflow(workflow.data, {
              workflowSlug: workflow.name,
              runInputs: normalizeWorkflowRunInputs(parsedInputs),
            })
          : null;
        return nonWriteTextResult('workflow_certification_failed',
          cert
            ? `${admitted.message}\n\n${renderWorkflowCertificationCommandHint(cert)}`
            : admitted.message,
        );
      }
      return textResult(admitted.message);
    },
  );

  server.tool(
    'workflow_get',
    'Read one workflow by name or exact saved slug. For its frontmatter/metadata — schedule, timezone, enabled state, description, inputs/resources, or step IDs — use section="metadata"; that bounded view omits every step prompt. '
      + 'Omit section (or use section="full") only when you need the full definition, including every step\'s line-numbered prompt and derived DATA SOURCES. Read the full or one-step view BEFORE editing so you can copy a VERBATIM prompt snippet into workflow_edit_step.',
    {
      name: z.string().min(1),
      section: z.enum(['metadata', 'full']).optional().describe('Use "metadata" for a bounded frontmatter/overview read with no step prompt text. Use "full" (the backward-compatible default) only when the complete definition is needed. Do not combine "metadata" with step.'),
      step: z.string().optional().describe('Optional step id — return just this step\'s full text + data sources (use when a workflow is too large to read whole).'),
    },
    async ({ name, section, step }) => {
      const allGet = listWorkflowFiles();
      const exactMatches = allGet.filter((w) => w.data.name === name || w.name === name);
      if (exactMatches.length > 1) {
        return textResult(`Workflow identity "${name}" is ambiguous. Use a unique exact saved name or slug.`, { isError: true });
      }
      let entry: WorkflowEntry | undefined = exactMatches[0];
      if (!entry) {
        // Match by name, not just the exact direct name — same resolver the
        // run path uses, so workflow_get("prospecting flow") still finds it.
        const resolution = resolveWorkflowName(
          name,
          allGet.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
        );
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = allGet.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(
            `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_get with that exact name.`,
          );
        }
      }
      if (!entry) {
        const names = allGet.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }
      const w = entry.data;
      if (section === 'metadata') {
        if (step) {
          return textResult('Choose either section="metadata" for the bounded workflow overview or step="<id>" for one full step; they cannot be combined.');
        }
        // A structural, provider-neutral bounded read. Keep the scheduling and
        // identity fields first, preserve useful top-level authoring metadata,
        // and deliberately summarize steps without carrying any prompt-shaped
        // fields (prompt, codifiedFrom.prompt, specialist prompts, call args).
        // textResult supplies the hard output cap even for an unusually large
        // resource/input manifest; trigger evidence therefore cannot be pushed
        // out by the variable-length tail.
        const metadata = {
          name: w.name,
          console_url: workflowConsoleUrl(w.name),
          description: w.description,
          enabled: w.enabled,
          trigger: {
            schedule: w.trigger.schedule ?? null,
            onceAt: w.trigger.onceAt ?? null,
            timezone: w.trigger.timezone ?? null,
            manual: w.trigger.manual ?? false,
          },
          ...(w.whenToUse ? { when_to_use: w.whenToUse } : {}),
          ...(w.project ? { project: w.project } : {}),
          ...(w.allowedTools && w.allowedTools.length > 0 ? { allowed_tools: w.allowedTools } : {}),
          ...(w.resources && Object.keys(w.resources).length > 0 ? { resources: w.resources } : {}),
          step_count: w.steps.length,
          steps: w.steps.map((stp) => ({
            id: stp.id,
            ...(stp.dependsOn && stp.dependsOn.length > 0 ? { depends_on: stp.dependsOn } : {}),
            ...(stp.project ? { project: stp.project } : {}),
            ...(stp.model ? { model: stp.model } : {}),
            ...(stp.intent ? { intent: stp.intent } : {}),
            ...(stp.forEach ? { for_each: stp.forEach } : {}),
            ...(stp.sideEffect ? { side_effect: stp.sideEffect } : {}),
            ...(stp.requiresApproval ? { requires_approval: true } : {}),
            executor: stp.deterministic?.runner
              ? { kind: 'script', runner: stp.deterministic.runner }
              : stp.call?.tool
                ? { kind: 'tool', tool: stp.call.tool }
                : stp.transform
                  ? { kind: 'transform', version: stp.transform.version }
                  : stp.subgraph
                    ? { kind: 'subgraph', mode: stp.subgraph.mode, specialist_ids: stp.subgraph.specialists.map((specialist) => specialist.id) }
                    : { kind: 'model' },
          })),
          ...(w.inputs && Object.keys(w.inputs).length > 0 ? { inputs: w.inputs } : {}),
          ...(w.models ? { models: w.models } : {}),
          ...(w.allowSends === true || w.allowSends === false ? { allow_sends: w.allowSends } : {}),
          ...(w.goal ? { goal: w.goal } : {}),
        };
        return textResult(
          `Workflow metadata (step prompts and workflow body omitted):\n${JSON.stringify(metadata, null, 2)}`,
          { maxChars: 4_000 },
        );
      }
      // Render one step with its FULL prompt line-numbered (cat -n style, so the
      // agent can copy a VERBATIM snippet into workflow_edit_step) and its
      // derived data sources (the real connectors/scripts it uses — kills the
      // "is this Salesforce or Composio?" blind spot). Mirrors space_get_view's
      // renderViewForRead. The "<n>\t" prefix is NOT part of the prompt text.
      const renderStepForRead = (stp: typeof w.steps[number]): string => {
        const deps = stp.dependsOn && stp.dependsOn.length > 0 ? ` (depends on: ${stp.dependsOn.join(', ')})` : '';
        const project = stp.project ? ` project=${stp.project}` : w.project ? ` project=${w.project}` : '';
        const model = stp.model ? ` model=${stp.model}` : '';
        const forEach = stp.forEach ? ` forEach=${stp.forEach}` : '';
        const subgraph = stp.subgraph
          ? ` subgraph=${stp.subgraph.mode}[${stp.subgraph.specialists.map((specialist) => specialist.id).join(',')}]`
          : '';
        const det = stp.deterministic ? ` deterministic=${stp.deterministic.runner}` : '';
        const transformLine = stp.transform ? `    transform: ${JSON.stringify(stp.transform)}` : '';
        const sources = deriveStepDataSources(stp);
        const sourcesLine = sources.length > 0 ? `    data: ${sources.join(' · ')}` : '';
        // For a deterministic step, READ the runner's source and surface WHAT it
        // actually reaches (the connector/CLI/SOQL/host) — the runner twin of the
        // step data-source line, mirroring space_get_runner. Kills the "is this
        // script hitting Salesforce or Composio?" blind spot at edit time.
        // The path resolution MIRRORS the runtime's resolveDeterministicRunner:
        // stay inside this workflow's scripts/ dir (reject absolute / '..'), honor
        // an already-"scripts/"-prefixed runner, and only the directory layout has
        // a scripts/ dir (flat legacy workflows can't carry a runner).
        let runnerLine = '';
        if (stp.deterministic?.runner) {
          const raw = stp.deterministic.runner.trim();
          let prov: string[];
          if (!raw || /\s/.test(raw) || path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
            prov = ['(invalid runner path)'];
          } else if (entry.layout !== 'directory') {
            prov = ['(script file missing)']; // flat legacy workflows have no scripts/ dir
          } else {
            const scriptsDir = path.resolve(entry.dir, 'scripts');
            const rel = raw.startsWith('scripts/') || raw.startsWith('scripts\\') ? raw : path.join('scripts', raw);
            const runnerFile = path.resolve(entry.dir, rel);
            // Belt-and-suspenders: the resolved path must stay inside scripts/.
            if (runnerFile !== scriptsDir && !runnerFile.startsWith(`${scriptsDir}${path.sep}`)) {
              prov = ['(invalid runner path)'];
            } else {
              try { prov = existsSync(runnerFile) ? deriveRunnerProvenance(readFileSync(runnerFile, 'utf-8')) : ['(script file missing)']; }
              catch { prov = ['(unreadable)']; }
            }
          }
          runnerLine = `    runner data: ${prov.join(' · ') || '(no external calls detected)'}`;
        }
        const promptLines = (stp.prompt ?? '').split('\n');
        const pwidth = String(promptLines.length).length;
        const numbered = promptLines.map((l, i) => `      ${String(i + 1).padStart(pwidth)}\t${l}`).join('\n');
        const specialistLines = stp.subgraph?.specialists.flatMap((specialist) => [
          `    specialist ${specialist.id}`
            + (specialist.label ? ` label=${JSON.stringify(specialist.label)}` : '')
            + (specialist.model ? ` model=${specialist.model}` : '')
            + (specialist.intent ? ` intent=${specialist.intent}` : '')
            + (specialist.maxTurns !== undefined ? ` maxTurns=${specialist.maxTurns}` : ''),
          `      prompt: ${JSON.stringify(specialist.prompt)}`,
        ]) ?? [];
        return [
          `  ${stp.id}${deps}${project}${model}${forEach}${subgraph}${det}`,
          sourcesLine,
          runnerLine,
          transformLine,
          ...specialistLines,
          '    prompt:',
          numbered,
        ].filter(Boolean).join('\n');
      };
      // step=<id> targeting: when a workflow is large, read just one step in full.
      if (step) {
        const one = w.steps.find((s) => s.id === step);
        if (!one) {
          return textResult(`Workflow "${w.name}" has no step "${step}". Steps: ${w.steps.map((s) => `"${s.id}"`).join(', ') || '(none)'}.`);
        }
        return textResult(
          `Step "${step}" of "${w.name}" (the "<n>\\t" prefix is the line number, NOT part of the prompt — copy a VERBATIM snippet into workflow_edit_step):\n${renderStepForRead(one)}`,
        );
      }
      // Whole-workflow read, capped — if the full step text overflows, tell the
      // agent to target a single step rather than silently clipping logic.
      const WORKFLOW_GET_CHAR_CAP = 24_000;
      const renderedSteps: string[] = [];
      let stepsBudget = WORKFLOW_GET_CHAR_CAP;
      let stepsTruncated = false;
      for (const stp of w.steps) {
        const rendered = renderStepForRead(stp);
        stepsBudget -= rendered.length + 1;
        if (stepsBudget < 0) { stepsTruncated = true; break; }
        renderedSteps.push(rendered);
      }
      if (stepsTruncated) {
        renderedSteps.push(`  … workflow is large — read remaining steps in full with workflow_get("${w.name}", step:"<id>").`);
      }
      const stepsBlock = renderedSteps.join('\n');
      const inputsBlock = w.inputs && Object.keys(w.inputs).length > 0
        ? Object.entries(w.inputs).map(([k, meta]) => `  - ${k}: ${meta.type ?? 'string'}${meta.default !== undefined ? ` (default: ${meta.default})` : ''}${meta.description ? ` — ${meta.description}` : ''}`).join('\n')
        : '  (none)';
      const resourcesBlock = w.resources && Object.keys(w.resources).length > 0
        ? Object.values(w.resources).map((resource) => {
          const surface = resource.toolkit ?? resource.tool ?? resource.cli ?? resource.mcpServer ?? '(unbound surface)';
          const selector = resource.resourceId ?? resource.url ?? resource.name ?? resource.account ?? resource.connectionId
            ?? (resource.scope ? JSON.stringify(resource.scope) : '(unbound selector)');
          const label = resource.label ? ` — ${resource.label}` : '';
          const required = resource.required === false ? ' (optional)' : '';
          return `  - ${resource.id}: ${resource.kind}${label} via ${surface} -> ${selector}${required}`;
        }).join('\n')
        : '  (none)';
      const trigger = w.trigger.onceAt ? `once at: ${w.trigger.onceAt}` : w.trigger.schedule ? `schedule: ${w.trigger.schedule}` : (w.trigger.manual ? 'manual only' : 'manual');
      const allowed = w.allowedTools && w.allowedTools.length > 0
        ? w.allowedTools.map((t) => (typeof t === 'string' ? t : `${t.name}${t.approval === 'required' ? ' (approval)' : ''}`)).join(', ')
        : '(any)';
      // Lead with the plain-English summary — what a human actually wants to
      // read ("what does this do, when, what it needs/produces, where it
      // pauses") — then keep the technical block below for precise editing.
      return textResult([
        describeWorkflowPlainEnglish(w),
        `Open workflow: ${workflowConsoleUrl(w.name)}`,
        '',
        '— technical detail —',
        `File: ${path.relative(path.dirname(entry.dir), entry.filePath)}`,
        w.whenToUse ? `When to use: ${w.whenToUse}` : '',
        w.project ? `Project: ${w.project}` : '',
        `Trigger: ${trigger}`,
        `Allowed tools: ${allowed}`,
        `Resources:`,
        resourcesBlock,
        `Steps (${w.steps.length}) — each shows its DATA sources + FULL prompt; the "<n>\\t" prefix is the line number, NOT part of the prompt (copy a VERBATIM snippet into workflow_edit_step):`,
        stepsBlock,
        `Inputs:`,
        inputsBlock,
        w.synthesis?.prompt ? `Synthesis: ${w.synthesis.prompt.slice(0, 600)}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  server.tool(
    'workflow_set_enabled',
    'Approve or disable a workflow. Sub-agents (Executor / Deployer) only fire approved workflows. Use enabled=true to approve a workflow for autonomous execution; enabled=false to pause it without deleting.',
    {
      name: z.string().min(1),
      enabled: z.boolean(),
      test_inputs: z.string().optional().describe('JSON object with concrete non-secret inputs for the verification run when enabling a workflow with external read steps, e.g. {"url":"https://example.com"}.'),
    },
    async ({ name, enabled, test_inputs }) => {
      let providedSmokeInputs: Record<string, string> = {};
      if (enabled) {
        try {
          providedSmokeInputs = parseWorkflowRunInputsJson(test_inputs);
        } catch (error) {
          return nonWriteTextResult('invalid_test_inputs', error instanceof Error ? error.message : String(error));
        }
      }
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return nonWriteTextResult('not_found', `Workflow "${name}" not found.`);
      // A workflow whose data can't flow can't be ENABLED (disabling is
      // always allowed). Auto-repair the fixable binding gaps first, so
      // enabling an older workflow with a dangling reference fixes it in
      // place instead of refusing.
      if (enabled) {
        if (entry.data.steps.some((step) => step.invocationPlan !== undefined)) {
          return nonWriteTextResult('invocation_plan_requires_consent',
            `Workflow "${name}" was NOT enabled — an exact invocation-plan workflow requires a successful one-shot pilot and a separate formal recurrence consent card. Generic workflow_set_enabled cannot grant standing authority.`,
          );
        }
        // Enable-time exact-send readiness is self-healing but bounded: refresh
        // only structurally pinned slugs, then let canonical validation decide.
        const enabledCandidate = { ...entry.data, enabled: true };
        await warmExactScheduledSendSchemaAuthorityForWrite(enabledCandidate);
        const prep = prepareWorkflowEnableForWrite(entry.data);
        if (prep.status === 'invalid') {
          return nonWriteTextResult('invalid_workflow',
            `Workflow "${name}" was NOT enabled — fix these first:\n- ${prep.errors.join('\n- ')}`,
          );
        }
        // Verify-by-running (2026-06-11): enabling means "set to run" — when
        // the workflow has testable read steps, run the creation test now and
        // let the PASS enable it, instead of trusting the config. Same strict
        // input policy as create: no bindable smoke inputs means stay disabled.
        const enableVerification = prepareWorkflowVerification(prep.def, providedSmokeInputs);
        if (enableVerification.needsTest) {
          writeWorkflowAndSyncTriggers(entry.name, { ...prep.def, enabled: false });
          clearWorkflowFailures(entry.name);
          if (enableVerification.missing.length > 0) {
            // The user asked for this ON and it is still OFF. That is a
            // decision waiting on them, not a line of prose in one chat turn.
            notifyWorkflowAwaitingEnable({
              workflowName: entry.name,
              displayName: name,
              cause: 'verification_inputs_missing',
            });
            return textResult(withWorkflowCommit(entry.name,
              `Workflow "${name}" was NOT enabled. ${renderMissingSmokeInputs(name, enableVerification.missing)}`,
            ));
          }
          const queued = queueWorkflowCreationTest(entry.name, enableVerification.inputs, { originSessionId: getToolOutputContext()?.sessionId });
          return textResult(withWorkflowCommit(entry.name,
            `Verifying "${name}" before it goes live — ${queued.message}`
              + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
          ));
        }
        writeWorkflowAndSyncTriggers(entry.name, prep.def);
        // Re-enabling is a deliberate fresh start — clear any chronic-failure
        // streak so auto-heal/escalation resets (#6).
        clearWorkflowFailures(entry.name);
        const gapTail = prep.gaps.length > 0
          ? `\n\nWorth tightening when you have a minute (advisory, not blocking):${renderWorkflowGapQuestions(prep.gaps)}`
          : '';
        return textResult(withWorkflowCommit(entry.name,
          `Workflow "${name}" is now approved (enabled).${gapTail}`
            + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
        ));
      }
      writeWorkflowAndSyncTriggers(entry.name, { ...entry.data, enabled });
      return textResult(withWorkflowCommit(entry.name, `Workflow "${name}" is now disabled.`));
    },
  );

  server.tool(
    'workflow_update',
    'Modify an existing workflow by exact saved name or slug: update description, trigger schedule, steps, inputs, or synthesis. Pass only the fields you want to change — others are preserved. Step IDs and dependencies are re-validated. '
      + 'IMPORTANT: when `steps` is present it REPLACES THE ENTIRE STEP GRAPH; never send one step as a patch. Read and resend every step for a graph change, or use workflow_edit_step for a targeted prompt edit. '
      + 'Design THIN agentic steps: a few capable steps (each doing a whole meaningful chunk), not many micro-steps. `dependsOn` both orders steps and carries upstream outputs into the downstream STEP CONTEXT. '
      + 'For a heavy read-only analysis, `subgraph: {mode:"read_parallel_v1", specialists:[...]}` compiles 2–6 concurrent result-only branches and uses the authored step as their reducer; keep fetch/effect nodes separate. '
      + 'For mechanical tool steps, declare `inputs` argument bindings plus `output`, or use `call` directly when the exact tool and args are known. Raw deterministic/probe runners are legacy migration fields and are refused before execution.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().optional().describe('Model task; omit for call/transform. Dependencies arrive in STEP CONTEXT.upstream. Templates: {{steps.<id>.output}}, {{input.<key>}}, {{project.path}}, {{project.name}}, {{item}} with forEach.'),
        project: z.string().optional().describe('Verified configured workspace/project identity, not a file output directory. Omit to inherit the workflow-level project.'),
        dependsOn: z.array(z.string()).optional().describe('Upstream step IDs; wait for these and receive their outputs in STEP CONTEXT.upstream.'),
        model: z.string().optional(),
        intent: z.string().optional().describe('Worker routing category, e.g. "design". Uses its bound worker model unless model is explicit.'),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional().describe('Array source (upstream output, input.<key>, or JSON array text). Runs per item; returns [{itemKey,output}]. Object/scalar contracts check items; array contracts check aggregate.'),
        forEachNewOnly: z.boolean().optional().describe('With forEach, skip items completed in prior runs using stable item.id/key/slug. Failed items retry next run.'),
        subgraph: WorkflowReadParallelSubgraphSchema.optional(),
        transform: z.string().optional().describe('PURE REVIEWED TRANSFORM as exact JSON text: {"version":1,"expression":<expr>}. Closed expr ops: literal, get, jsonParse, jsonStringify, object, array, count, map, sort, unique, select, aggregate(value,groupBy:[column],metrics:[{fn:"count"|"sum"|"avg"|"min"|"max",column?}]). Metrics use fn, not op; count needs no column. Output keys are count or <fn>_<column> (for example sum_amount). No code or effect access. Declare sideEffect:"read" and dependsOn for referenced upstream steps.'),
        call: z.object({
          tool: z.string().min(1).describe('Exact discovered tool name (e.g. read_file), not capabilityRef.'),
          args_json: z.string().optional().describe('Preferred JSON-object text; preserves nested types. Omit args. {{input.x}} templates resolve at execution.'),
          args: z.record(z.string(), z.unknown()).optional().describe('Legacy args; prefer args_json. Templates: {{input.x}}, {{steps.<id>.output[.path]}}, {{item[.path]}}, {{project.path}}, {{date}}. A sole template preserves the raw object/array.'),
        }).optional().describe('No model: invoke known tool/args. Use prompt for selection/ambiguity. read_file JSON content: steps.<id>.output.data.content; parse it. Composio retains {successful,data,...}; bind/verify data.records. forEach permits read calls only.'),
        allowedTools: z.array(z.string()).optional().describe('Allowed discovered tool names, not capabilityRef/variantId. Args select mode; omit to inherit workflow scope.'),
        requiresApproval: z.boolean().optional().describe('Set true to pause this step for user approval before execution (for irreversible sends / publishes).'),
        approvalPreview: z.string().optional().describe('One-line preview shown on the approval card when requiresApproval is set.'),
        usesSkill: z.string().optional().describe('Installed skills/ directory name. Prefer one reusable skill to many prompt steps.'),
        inputs: z.record(z.string(), WorkflowStepInputBindingSchema).optional().describe(STEP_INPUT_CONTRACT_DESC),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
        sideEffect: z.enum(['read', 'write', 'send']).optional().describe("External side-effect class ('read' | 'write' | 'send'). Drives the safety law: send never auto-retries, crash-resume halts on interrupted writes/sends."),
        loopUntil: WorkflowLoopUntilSchema.optional().describe(LOOP_UNTIL_DESC),
        loopSafe: z.boolean().optional().describe('Author assertion that re-running this WRITE step is idempotent. Required for loopUntil on write steps; also allows goal re-pursuit past this step.'),
      })).optional().describe('COMPLETE REPLACEMENT graph. If provided, this array replaces ALL existing steps; it is not an upsert/patch. Include every step you intend to keep. For one prompt-only edit, use workflow_edit_step instead.'),
      project: z.string().optional().describe('Set or clear the workflow-level default local workspace/project. Empty string clears it.'),
      clear_project: z.boolean().optional().describe('Pass true to remove the workflow-level default local project.'),
      trigger_schedule: z.string().optional(),
      trigger_once_at: z.string().optional().describe('One-time absolute ISO timestamp with Z or UTC offset. Use instead of trigger_schedule for a single future run; the host consumes the occurrence without a self-edit step.'),
      trigger_timezone: z.string().optional().describe('IANA timezone for trigger_schedule, e.g. "America/Los_Angeles". Pass when changing scheduled local-time workflows.'),
      clear_trigger_once_at: z.boolean().optional().describe('Remove the one-time trigger. Does not cancel an already queued or executing run.'),
      clear_trigger_schedule: z.boolean().optional().describe('Pass true to remove an existing schedule (e.g. switch back to manual-only).'),
      trigger_webhook_path: z.string().optional().describe('URL-safe slug: the workflow fires when an external service POSTs to /api/hooks/workflows/<path> (token-gated). Pass an empty string or clear_trigger_webhook_path=true to remove it.'),
      clear_trigger_webhook_path: z.boolean().optional().describe('Pass true to remove an existing webhook trigger path.'),
      trigger_events: z.array(WorkflowTriggerEventSchema).optional().describe('Replace the workflow event subscriptions. Pass [] or clear_trigger_events=true to remove existing event triggers.'),
      clear_trigger_events: z.boolean().optional().describe('Pass true to remove existing internal event trigger subscriptions.'),
      inputs: z.string().optional().describe('Workflow-level input schema as a JSON-encoded string, not a shorthand line and not the structured steps[].inputs binding object. Map input names to metadata {type?, default?, description?}. Example JSON text: {"text":{"type":"string","description":"Text supplied at runtime to summarize"}}. Pass that text as this string field inside args_json. Pass only to change the input schema; omit to preserve it.'),
      resources: z.string().optional().describe('JSON object mapping durable resource IDs to bindings, e.g. {"ads_account":{"kind":"account","toolkit":"googleads","account":"123-456-7890"}} or {"content_calendar":{"kind":"workspace","id":"my-workspace-slug"}}. Pass only to replace resource bindings; omit to preserve them.'),
      clear_resources: z.boolean().optional().describe('Pass true to remove all workflow resource bindings.'),
      test_inputs: z.string().optional().describe('JSON object with concrete non-secret inputs for the re-verification smoke test when this update changes an enabled workflow, e.g. {"url":"https://example.com"}.'),
      synthesis_prompt: z.string().optional(),
      portable_models: z.boolean().optional().describe('Set true when this update should make the workflow portable across model providers by removing exact per-step model pins. Omit/false to preserve intentional model pins.'),
      allowSends: z.boolean().optional().describe('Allow autonomous sends/publishes without approval gates. Defaults to true (autonomous). Set false for strict mode: any send-looking step must then carry requiresApproval: true or the save is refused.'),
      goal: z.object({
        objective: z.string().min(4).describe('What a completed run must achieve — judged externally at run completion.'),
        success_criteria: z.array(z.string()).optional().describe('Reusable pass/fail rules against current run inputs. Do not freeze sample-specific expected answers unless they must remain constant on every run. Empty means judge the objective.'),
        max_attempts: z.number().min(1).max(3).optional().describe('Total run attempts (original + automatic re-pursuits). Default 2, ceiling 3.'),
      }).optional().describe('PINNED RUN GOAL (run-to-completion) — see workflow_create. Pass to set/replace; use clear_goal to remove.'),
      clear_goal: z.boolean().optional().describe('Pass true to remove an existing pinned goal.'),
    },
    async ({ name, description, steps, project, clear_project, trigger_schedule, trigger_once_at, clear_trigger_once_at, trigger_timezone, clear_trigger_schedule, trigger_webhook_path, clear_trigger_webhook_path, trigger_events, clear_trigger_events, inputs, resources, clear_resources, test_inputs, synthesis_prompt, portable_models, allowSends, goal, clear_goal }) => {
      // OpenAI strict function schemas materialize omitted nullable optionals as
      // `null`. workflow_update is a PATCH surface: null must mean "omitted",
      // never "clear this field" and never `.trim()` on null. Preserve explicit
      // false / [] / "" values because those carry real patch semantics.
      description = description ?? undefined;
      steps = steps ?? undefined;
      project = project ?? undefined;
      clear_project = clear_project ?? undefined;
      trigger_schedule = trigger_schedule ?? undefined;
      trigger_once_at = trigger_once_at ?? undefined;
      clear_trigger_once_at = clear_trigger_once_at ?? undefined;
      trigger_timezone = trigger_timezone ?? undefined;
      clear_trigger_schedule = clear_trigger_schedule ?? undefined;
      trigger_webhook_path = trigger_webhook_path ?? undefined;
      clear_trigger_webhook_path = clear_trigger_webhook_path ?? undefined;
      trigger_events = trigger_events ?? undefined;
      clear_trigger_events = clear_trigger_events ?? undefined;
      inputs = inputs ?? undefined;
      resources = resources ?? undefined;
      clear_resources = clear_resources ?? undefined;
      test_inputs = test_inputs ?? undefined;
      synthesis_prompt = synthesis_prompt ?? undefined;
      portable_models = portable_models ?? undefined;
      allowSends = allowSends ?? undefined;
      goal = goal ?? undefined;
      clear_goal = clear_goal ?? undefined;

      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return nonWriteTextResult('invalid_inputs', error instanceof Error ? error.message : String(error));
      }
      let resourceBindings: Record<string, WorkflowResourceBinding>;
      try {
        resourceBindings = parseWorkflowResourcesJson(resources);
      } catch (error) {
        return nonWriteTextResult('invalid_resources', error instanceof Error ? error.message : String(error));
      }
      let providedSmokeInputs: Record<string, string>;
      try {
        providedSmokeInputs = parseWorkflowRunInputsJson(test_inputs);
      } catch (error) {
        return nonWriteTextResult('invalid_test_inputs', error instanceof Error ? error.message : String(error));
      }
      const inputsProvided = Object.keys(inputsSchema).length > 0;
      const resourcesProvided = resources !== undefined;
      // Updates select one durable identity. Read-only fuzzy retrieval does
      // not authorize choosing a write target, and a name/slug collision must
      // not make filesystem listing order decide which workflow is edited.
      const exactMatches = listWorkflowFiles().filter((w) => w.data.name === name || w.name === name);
      if (exactMatches.length > 1) {
        return nonWriteTextResult('ambiguous_identity', `Workflow identity "${name}" is ambiguous. Use a unique exact saved name or slug.`);
      }
      const entry = exactMatches[0];
      if (!entry) return nonWriteTextResult('not_found', `Workflow "${name}" not found. Use its exact saved name or slug.`);

      if (steps) {
        const stepGraphError = validateWorkflowStepGraph(steps);
        if (stepGraphError) return nonWriteTextResult('invalid_graph', stepGraphError.replace('found.', 'in update.'));
      }

      const next: WorkflowDefinition = { ...entry.data };
      if (description !== undefined) next.description = description;
      if (clear_project) delete next.project;
      else if (project !== undefined) {
        const trimmedProject = project.trim();
        if (trimmedProject) next.project = trimmedProject;
        else delete next.project;
      }
      if (steps) {
        try {
          next.steps = normalizeWorkflowSteps(steps);
        } catch (error) {
          return nonWriteTextResult('invalid_workflow', error instanceof Error ? error.message : String(error));
        }
      }
      // Tight authoring: bind any newly-provided steps to proven tool-choices.
      const updateRouteNotes = steps ? autoTagStepsWithModelRoleIntents(next.steps) : [];
      const updateBind = steps ? bindStepsToToolChoices(next.steps) : { boundNotes: [], advisories: [] };
      if (inputsProvided) next.inputs = inputsSchema;
      if (clear_resources) delete next.resources;
      else if (resourcesProvided) next.resources = Object.keys(resourceBindings).length > 0 ? resourceBindings : undefined;
      if (synthesis_prompt !== undefined) next.synthesis = { prompt: synthesis_prompt };
      if (allowSends !== undefined) next.allowSends = allowSends;
      if (clear_goal) {
        delete next.goal;
      } else if (goal) {
        next.goal = { objective: goal.objective, successCriteria: goal.success_criteria, maxAttempts: goal.max_attempts };
      }

      const triggerPatch = applyWorkflowTriggerPatch(next.trigger, {
        triggerSchedule: trigger_schedule,
        triggerOnceAt: trigger_once_at,
        clearTriggerOnceAt: clear_trigger_once_at,
        clearTriggerSchedule: clear_trigger_schedule,
        timezone: trigger_timezone,
        triggerWebhookPath: trigger_webhook_path,
        clearTriggerWebhookPath: clear_trigger_webhook_path,
        triggerEvents: trigger_events,
        clearTriggerEvents: clear_trigger_events,
      });
      if (!triggerPatch.ok) return nonWriteTextResult('invalid_trigger', triggerPatch.error);
      if (triggerPatch.changed) next.trigger = triggerPatch.trigger;

      // Auto-repair the fixable binding gaps before persisting so an edit
      // that left a dangling {{steps.X.output}} / forEach / {{input.X}}
      // saves runnable.
      await warmExactScheduledSendSchemaAuthorityForWrite(next);
      const updatePrep = prepareWorkflowUpdateForWrite(entry.data, next, {
        modelPortability: portable_models ? 'portable' : 'preserve',
        codifyMechanicalSteps: Boolean(steps),
      });
      const savedNext = updatePrep.def;
      // P0-4: an ENABLED workflow must be valid — it runs on schedule. Auto-repair
      // fixes mechanical gaps, but non-repairable defects (cycles, ungated sends,
      // unknown deps) must NOT go live silently. This was the ONLY write seam that
      // computed validation then discarded it; gate it like every other seam
      // (create / dashboard PATCH / set_enabled / schedule). A DISABLED draft may
      // still save invalid so the user can keep iterating.
      if (updatePrep.status === 'invalid') {
        return nonWriteTextResult('invalid_workflow',
          `Workflow "${entry.name}" was NOT updated — it's enabled and these must be fixed first (or disable it to keep iterating):\n- ${updatePrep.errors.join('\n- ')}`,
        );
      }
      if (updatePrep.status === 'readiness_gaps') {
        writeWorkflowAndSyncTriggers(entry.name, savedNext);
      }
      // Re-smoke on edit (2026-06-11): an edit that changes what an ENABLED
      // workflow EXECUTES is re-verified the same way a new workflow is —
      // saved disabled, creation test runs the read-only steps against the
      // REAL tools, auto-enables on pass / stays disabled with the reason on
      // fail. "It's set and working" must mean "I watched it run", never
      // "I read the config". Schedule/description-only edits never re-test.
      let reSmoke: { message: string } | null = null;
      // Clem's own self-improvement turn edits an ENABLED workflow that was
      // just asked to run; the improvement consumer re-queues that run the
      // moment the code guard accepts the rewrite, and that run is the
      // verification. Parking the rewrite disabled behind a creation test
      // here made every faithful rewrite trip the guard's "enabled flag
      // changed" and get reverted (live 2026-09-01, sixteen attempts in a row).
      // Validity is still gated above; only the re-smoke is skipped.
      const selfImprovementTurn = isWorkflowImprovementSessionId(getToolOutputContext()?.sessionId);
      if (!selfImprovementTurn && updatePrep.status !== 'readiness_gaps' && workflowUpdateNeedsVerification(entry.data, savedNext)) {
        const updateVerification = prepareWorkflowVerification(savedNext, providedSmokeInputs);
        if (updateVerification.needsTest) {
          savedNext.enabled = false;
          writeWorkflowAndSyncTriggers(entry.name, savedNext);
          // This is the exact trap the second user hit on 2026-09-10: every
          // repair to a broken scheduled workflow switched it off, and nothing
          // outside that one chat reply ever said so.
          notifyWorkflowAwaitingEnable({
            workflowName: entry.name,
            displayName: entry.data.name || entry.name,
            cause: 'edit_needs_verification',
            ...(updateVerification.missing.length > 0
              ? { detail: 'Its own test needs an input before it can re-check itself.' }
              : {}),
          });
          reSmoke = updateVerification.missing.length > 0
            ? { message: renderMissingSmokeInputs(entry.name, updateVerification.missing) }
            : queueWorkflowCreationTest(entry.name, updateVerification.inputs, { originSessionId: getToolOutputContext()?.sessionId });
        }
      }
      if (!reSmoke && updatePrep.status !== 'readiness_gaps') writeWorkflowAndSyncTriggers(entry.name, savedNext);
      const changed = [
        description !== undefined ? 'description' : '',
        steps ? 'steps' : '',
        inputsProvided ? 'inputs' : '',
        resourcesProvided || clear_resources ? 'resources' : '',
        synthesis_prompt !== undefined ? 'synthesis' : '',
        portable_models ? 'model portability' : '',
        trigger_schedule !== undefined || clear_trigger_schedule || trigger_once_at !== undefined || clear_trigger_once_at ? 'schedule' : '',
        trigger_webhook_path !== undefined || clear_trigger_webhook_path ? 'webhook trigger' : '',
        trigger_events !== undefined || clear_trigger_events ? 'event triggers' : '',
      ].filter(Boolean);
      addNotification({
        id: `workflow-update-${entry.name}-${Date.now()}`,
        kind: 'workflow',
        title: `Workflow updated: ${entry.name}`,
        body: changed.length > 0
          ? `Saved workflow changes (${changed.join(', ')}).`
          : 'Saved workflow changes.',
        createdAt: new Date().toISOString(),
        read: false,
        silent: true,
        metadata: {
          source: 'workflow_update',
          workflowName: entry.name,
          changed,
        },
      });
      // Non-blocking authoring advisories (output-contract / forEach hints).
      // Update has never gated on validation; keep it that way — surface the
      // hints so the author can sharpen the workflow without blocking the save.
      const updateBindNotes = [...updateRouteNotes, ...updateBind.boundNotes, ...updatePrep.codifyNotes];
      const updateBindReport = updateBindNotes.length > 0 ? `\n\n${updateBindNotes.join('\n')}` : '';
      const updateAdvisories = renderAuthoringAdvisories([
        ...updatePrep.repairs,
        ...updatePrep.warnings,
        ...updateBind.advisories,
      ]);
      // Re-run the gap test on the edited workflow so remaining gaps stay
      // visible until the author actually closes them.
      const updateGaps = renderWorkflowGapQuestions(updatePrep.status === 'readiness_gaps' ? updatePrep.gaps : analyzeWorkflowGaps(savedNext));
      const updateExecutionPlan = buildWorkflowExecutionPlanWithReadiness(savedNext, entry.name);
      const updateContractReport = appendVisualContract(updateExecutionPlan);
      return textResult(withWorkflowCommit(
        entry.name,
        `Workflow "${name}" updated. Here's what it does now:\n\n${describeWorkflowPlainEnglish(savedNext)}\n\n`
          + `${appendDataSources(savedNext)}`
          + `${updateContractReport}${updateContractReport ? '\n\n' : ''}`
          + `${updatePrep.status === 'readiness_gaps' ? `${renderReadinessHold(name)}\n\n` : ''}`
          + `${reSmoke ? `${reSmoke.message}\n\n` : ''}`
          + `${updateBindReport}${updateAdvisories}${updateGaps}`.trim(),
      ));
    },
  );

  server.tool(
    'workflow_edit_step',
    [
      "Make a TARGETED, reversible edit to ONE step's prompt in an existing workflow — the FAST, grounded way to change a step's logic (fix a data source, add a missing instruction, change a tool).",
      'Provide step_id + {find, replace}: `find` must appear VERBATIM in that step\'s current prompt — call workflow_get("<name>", step:"<step_id>") FIRST to read the exact current text (it is line-numbered; the "<n>\\t" prefix is NOT part of the prompt). It snapshots the prior definition (revert with workflow_revert_step) and re-validates before saving.',
      "Prefer this over workflow_update for a single-step change: it cannot clobber sibling steps or trip whole-array validation, and a blind edit (you did not read the real step) fails with a precise hint instead of silently mis-editing.",
    ].join('\n'),
    {
      name: z.string().min(1).describe('Workflow name.'),
      step_id: z.string().min(1).describe('The step to edit.'),
      find: z.string().min(1).max(8000).describe('Exact substring currently in the step prompt to replace (copy VERBATIM from workflow_get).'),
      replace: z.string().max(8000).describe('Replacement text (may be empty to delete the found text).'),
    },
    async ({ name, step_id, find, replace }) => {
      const all = listWorkflowFiles();
      let entry = all.find((w) => w.data.name === name);
      if (!entry) {
        const resolution = resolveWorkflowName(name, all.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })));
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = all.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(`"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Call workflow_edit_step with the exact name.`);
        }
      }
      if (!entry) {
        const names = all.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }
      const before = entry.data;
      // The entry owns the durable on-disk identity; frontmatter `name` is the
      // human-facing label and may contain spaces or case. Every edit, backup,
      // reload, persistence, and re-smoke stays on the entry slug. Only text
      // returned to the user is translated back to the display name.
      const workflowSlug = entry.name;
      const displayName = before.name;
      const displayMessage = (message: string): string => workflowSlug === displayName
        ? message
        : message.replaceAll(`"${workflowSlug}"`, `"${displayName}"`);
      await warmExactScheduledSendSchemaAuthorityForWrite(before);
      const result = applyStepPromptEdit(workflowSlug, step_id, find, replace, {
        description: `workflow_edit_step ${step_id}`,
      });
      const resultMessage = displayMessage(result.message);
      if (!result.ok) {
        // Structured, NON-silent failure (change #4): the user AND the model see
        // the edit did not land and exactly what to do next — never a quiet no-op.
        return textResult(
          `Edit NOT applied to "${displayName}" step "${step_id}".\n${resultMessage}`
            + (result.errors?.length ? `\n- ${result.errors.join('\n- ')}` : ''),
        );
      }
      // Re-smoke parity with workflow_update: if the workflow is ENABLED and this
      // edit changed what it executes, re-verify by running (saved disabled,
      // auto-enables on pass) instead of trusting the edited config. Schedule/copy
      // edits that don't change execution skip the test.
      const updated = listWorkflowFiles().find((w) => w.name === workflowSlug)?.data;
      let reSmokeMsg = '';
      if (updated && before.enabled && workflowExecutionSurfaceChanged(before, updated)) {
        const runTest = workflowNeedsCreationTest(updated);
        if (runTest) {
          const testInputs = workflowSmokeInputs(updated, {});
          const missingSmokeInputs = missingWorkflowRunInputs(updated, testInputs);
          writeWorkflowAndSyncTriggers(workflowSlug, { ...updated, enabled: false });
          // It was RUNNING before this edit and it is not running now. Whoever
          // owns it hears that from the product, not from whether they happened
          // to read the reply.
          notifyWorkflowAwaitingEnable({
            workflowName: workflowSlug,
            displayName,
            cause: 'edit_needs_verification',
          });
          reSmokeMsg = missingSmokeInputs.length > 0
            ? `\n\n${renderMissingSmokeInputs(workflowSlug, missingSmokeInputs)}`
            : `\n\n${displayMessage(queueWorkflowCreationTest(
                workflowSlug,
                testInputs,
                { originSessionId: getToolOutputContext()?.sessionId },
              ).message)}`;
        }
      }
      addNotification({
        id: `workflow-edit-step-${workflowSlug}-${step_id}-${Date.now()}`,
        kind: 'workflow',
        title: `Workflow step edited: ${displayName}`,
        body: `Edited step "${step_id}".`,
        createdAt: new Date().toISOString(),
        read: false,
        silent: true,
        metadata: { source: 'workflow_edit_step', workflowName: workflowSlug, stepId: step_id },
      });
      return textResult(withWorkflowCommit(
        workflowSlug,
        `${resultMessage}${reSmokeMsg}`,
      ));
    },
  );

  server.tool(
    'workflow_revert_step',
    'Undo the most recent workflow_edit_step / step edit, restoring the workflow to its pre-edit definition. Pass the backup id returned by workflow_edit_step.',
    {
      backup_id: z.string().min(1).describe('The revert id from a prior workflow_edit_step result (e.g. "wfedit-1a2b3c4d").'),
    },
    async ({ backup_id }) => {
      const result = revertStepEdit(backup_id);
      return textResult(result.message);
    },
  );

  server.tool(
    'workflow_import_framework',
    'Import workflow framework packages from a local folder or GitHub repo. Discovers workflows/<name>/SKILL.md and .clementine/workflows/<name>/SKILL.md, preserves scripts/references/tests, and writes source metadata. Use dryRun=true first when reviewing third-party packages.',
    {
      source: z.string().min(1).describe('Local folder path, GitHub URL, git@github.com URL, owner/repo shorthand, or npx skills add owner/repo style reference.'),
      dryRun: z.boolean().optional().describe('Preview discovered workflows without copying files. Default false.'),
      overwrite: z.boolean().optional().describe('Replace existing framework files for same-named workflows, preserving runs/. Default false.'),
    },
    async ({ source, dryRun, overwrite }) => {
      try {
        const job = startWorkflowFrameworkImport(source, { dryRun, overwrite });
        return textResult([
          `Started workflow framework import ${job.id}.`,
          `Status: ${job.status}`,
          `Source: ${job.normalizedSource}`,
          `Dry run: ${job.dryRun ? 'yes' : 'no'}`,
          `Overwrite: ${job.overwrite ? 'yes' : 'no'}`,
          'Call workflow_import_status with this job id for results.',
        ].join('\n'));
      } catch (err) {
        return textResult(`Workflow import failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'workflow_import_status',
    'Check a workflow framework import job. Omit job_id to list recent import jobs.',
    {
      job_id: z.string().optional(),
    },
    async ({ job_id }) => {
      if (!job_id) {
        const recent = listRecentWorkflowImportJobs().slice(0, 10);
        if (recent.length === 0) return textResult('No workflow import jobs yet.');
        return textResult(recent.map((job) =>
          `- ${job.id} [${job.status}] source=${job.normalizedSource} discovered=${job.discovered.length} installed=${job.installed.length} skipped=${job.skipped.length}`,
        ).join('\n'));
      }
      const job = getWorkflowImportJob(job_id);
      if (!job) return textResult(`No workflow import job found with id ${job_id}.`);
      return textResult([
        `Workflow import ${job.id}`,
        `Status: ${job.status}`,
        `Source: ${job.normalizedSource}`,
        `Discovered: ${job.discovered.length}`,
        ...job.discovered.map((item) => `  - ${item.name}: ${item.pathInSource}`),
        `Installed: ${job.installed.length}`,
        ...job.installed.map((item) => `  - ${item.name}: ${item.filePath}`),
        `Skipped: ${job.skipped.length}`,
        ...job.skipped.map((item) => `  - ${item.name}: ${item.reason}`),
        job.error ? `Error: ${job.error}` : '',
        job.output ? `\nLog:\n${job.output}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  server.tool(
    'workflow_delete',
    'Permanently delete a workflow definition file. Pending queued runs are NOT cancelled — call workflow_run_status on any in-flight runs first.',
    {
      name: z.string().min(1),
      confirm: z.boolean().describe('Must be true to proceed. Guard against accidental deletion.'),
    },
    async ({ name, confirm }) => {
      if (!confirm) return textResult('Refusing to delete: pass confirm=true.');
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);
      const ok = deleteWorkflowAndSyncTriggers(entry.name);
      if (!ok) return textResult(`Workflow "${name}" delete failed (file system error).`);
      return textResult(`Workflow "${name}" deleted.`);
    },
  );

  server.tool(
    'workflow_capability_resolve',
    'Resolve a workflow Needs You capability pause without creating a new run. Use action=choose_account only with the exact coordinates shown by workflow_run_status after the user chooses an account; use action=retry after the user reconnects an account or asks to retry exact metadata. This host-only control never calls the provider itself.',
    {
      action: z.enum(['choose_account', 'retry']),
      run_id: z.string().min(1),
      step_id: z.string().optional(),
      tool: z.string().optional(),
      retry_count: z.number().int().positive().optional(),
      choice_set_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      capability_id: z.string().optional(),
      account_id: z.string().optional(),
    },
    async ({ action, run_id, step_id, tool, retry_count, choice_set_digest, capability_id, account_id }) => {
      const runner = await import('../execution/workflow-runner.js');
      const { requestWorkflowRunDrainKick } = await import('../execution/workflow-origin-group.js');
      if (action === 'retry') {
        if (!step_id?.trim() || !tool?.trim() || retry_count === undefined) {
          return textResult(
            'retry requires the exact step_id, tool, and retry_count from workflow_run_status. Nothing was changed.',
          );
        }
        const resolved = runner.resolveWorkflowCapabilityRetry({
          runId: run_id,
          stepId: step_id,
          tool,
          retryCount: retry_count,
          selectedBy: 'clem-tool',
        });
        if (!resolved.ok) return textResult(`Capability retry was not applied: ${resolved.message}`);
        requestWorkflowRunDrainKick([run_id]);
        return textResult(
          `Run ${run_id} is ${resolved.status === 'already_resumed' ? 'already resuming' : 'resuming'} from the exact preserved capability pause. No new run was created; Clementine will report back automatically. Do not poll or redo the work.`,
        );
      }
      if (
        !step_id?.trim()
        || !tool?.trim()
        || retry_count === undefined
        || !choice_set_digest
        || !capability_id?.trim()
        || !account_id?.trim()
      ) {
        return textResult(
          'choose_account requires the exact step_id, tool, retry_count, choice_set_digest, capability_id, and account_id from workflow_run_status. Nothing was changed.',
        );
      }
      const resolved = runner.resolveWorkflowCapabilityAccountChoice({
        runId: run_id,
        stepId: step_id,
        tool,
        retryCount: retry_count,
        choiceSetDigest: choice_set_digest,
        capabilityId: capability_id,
        accountId: account_id,
        selectedBy: getToolOutputContext()?.sessionId ?? 'user',
      });
      if (!resolved.ok) return textResult(`${resolved.message} Nothing was dispatched.`);
      requestWorkflowRunDrainKick([run_id]);
      return textResult(
        resolved.status === 'already_selected'
          ? `Account ${resolved.accountId} was already saved for step ${resolved.stepId}; run ${resolved.runId} remains on its same-run resume path. No duplicate dispatch was authorized.`
          : `Saved exact account ${resolved.accountId} for step ${resolved.stepId} and resumed run ${resolved.runId}. No new run was created; Clementine will report back automatically. Do not poll or redo the work.`,
      );
    },
  );

  server.tool(
    'workflow_run_status',
    'Check workflow runs. Pass run_id for one run\'s detail, OR omit it to LIST what is running right now — use the no-id form to answer "what workflows are running / how is my flow going". Lists in-flight (queued/running/parked/mutation-review) + needs-attention runs and the few most-recent finished ones.',
    {
      run_id: z.string().optional().describe('A specific run id for its full record. Omit to list active + recent runs.'),
    },
    async ({ run_id }) => {
      if (run_id && run_id.trim()) {
        const filePath = path.join(WORKFLOW_RUNS_DIR, `${run_id}.json`);
        if (!existsSync(filePath)) return textResult(`Workflow run "${run_id}" not found.`);
        try {
          const record = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
          // Per-step ledger: which steps produced what / which blocked — the
          // detail a user actually needs to diagnose "step 3 of 7 failed"
          // without opening the console. Values truncated; the run record on
          // disk keeps the full outputs.
          const stepOutputs = record.stepOutputs && typeof record.stepOutputs === 'object' && !Array.isArray(record.stepOutputs)
            ? Object.entries(record.stepOutputs as Record<string, unknown>)
            : [];
          const blockedSteps = Array.isArray(record.blockedSteps)
            ? (record.blockedSteps as Array<{ stepId?: unknown; reason?: unknown }>)
            : [];
          const blockedIds = new Set(blockedSteps.map((b) => String(b.stepId ?? '')));
          const workflowName = typeof record.workflow === 'string' ? record.workflow : '';
          const workflowEntry = workflowName
            ? listWorkflows().find((entry) => entry.data.name === workflowName || entry.name === workflowName)
            : undefined;
          const failedItems = workflowEntry ? listFinalFailedItems(workflowEntry.name, run_id) : [];
          const stepLines = stepOutputs.map(([id, out]) => {
            const text = typeof out === 'string' ? out : JSON.stringify(out);
            const clipped = text && text.length > 300 ? `${text.slice(0, 300)}…` : (text || '(empty)');
            return `  - ${id}${blockedIds.has(id) ? ' [BLOCKED]' : ''}: ${clipped}`;
          });
          const blockedLines = blockedSteps.map((b) => `  - ${String(b.stepId ?? '?')}: ${String(b.reason ?? '(no reason recorded)')}`);
          const failedItemLines = failedItems.map((f) => `  - ${f.stepId} · ${f.itemKey}: ${f.error.slice(0, 240)}`);
          const output = typeof record.output === 'string' ? record.output : '';
          // Creation tests retain actionable step failures in reportBack, not
          // stepOutputs. Expose that existing terminal evidence so callers can
          // repair the named contract instead of repeatedly polling a summary.
          const reportDetail = record.reportBack && typeof record.reportBack === 'object'
            && !Array.isArray(record.reportBack)
            && typeof (record.reportBack as Record<string, unknown>).detail === 'string'
              ? (record.reportBack as Record<string, unknown>).detail as string : '';
          const mutationBlock = record.mutationBlock && typeof record.mutationBlock === 'object' && !Array.isArray(record.mutationBlock)
            ? record.mutationBlock as Record<string, unknown>
            : undefined;
          const mutationNeedsAttention = record.status === 'blocked_mutation';
          const capabilityNeedsAttention = record.status === 'blocked_capability';
          const capabilityBlock = record.capabilityBlock && typeof record.capabilityBlock === 'object' && !Array.isArray(record.capabilityBlock)
            ? record.capabilityBlock as Record<string, unknown>
            : undefined;
          const accountChoiceSet = capabilityBlock?.accountChoiceSet
            && typeof capabilityBlock.accountChoiceSet === 'object'
            && !Array.isArray(capabilityBlock.accountChoiceSet)
            ? capabilityBlock.accountChoiceSet as Record<string, unknown>
            : undefined;
          const accountCandidates = Array.isArray(accountChoiceSet?.candidates)
            ? (accountChoiceSet.candidates as Array<Record<string, unknown>>)
                .filter((candidate) => candidate && typeof candidate === 'object')
                .slice(0, 16)
            : [];
          const accountChoiceLines = accountCandidates.map((candidate, index) => (
            `  ${index + 1}. account ${String(candidate.accountId ?? '?')} · capability ${String(candidate.capabilityId ?? '?')}`
          ));
          const capabilityLine = capabilityNeedsAttention
            ? capabilityBlock?.reason === 'ambiguous-account' && accountChoiceLines.length > 0
              ? [
                  `Needs You: choose the exact account for step ${String(capabilityBlock.stepId ?? '?')} (${String(capabilityBlock.tool ?? '?')}). No provider dispatch occurred and completed work is preserved.`,
                  ...accountChoiceLines,
                  `After the user chooses, call workflow_capability_resolve with action="choose_account", run_id="${run_id}", step_id="${String(capabilityBlock.stepId ?? '')}", tool="${String(capabilityBlock.tool ?? '')}", retry_count=${String(capabilityBlock.retryCount ?? '')}, choice_set_digest="${String(accountChoiceSet?.digest ?? '')}", and that choice's exact capability_id + account_id. Never choose by catalog order.`,
                ].join('\n')
              : [
                  `Needs You: step ${String(capabilityBlock?.stepId ?? '?')}, tool ${String(capabilityBlock?.tool ?? '?')}, reason ${String(capabilityBlock?.reason ?? '?')}.`,
                  `No provider dispatch occurred; completed work is preserved. ${capabilityBlock?.reason === 'exact_schema_refresh_unavailable' || capabilityBlock?.reason === 'exact_schema_boundary_mismatch' ? 'Ask the user whether to retry exact metadata now' : `Connect ${String(capabilityBlock?.toolkit ?? 'the account')} in Settings → Connections`}, then call workflow_capability_resolve with action="retry", run_id="${run_id}", step_id="${String(capabilityBlock?.stepId ?? '')}", tool="${String(capabilityBlock?.tool ?? '')}", and retry_count=${String(capabilityBlock?.retryCount ?? '')}. Automatic safe retry remains scheduled for ${String(capabilityBlock?.retryAt ?? 'later')}.`,
                ].join(' ')
            : '';
          // The one status whose resolution requires the model to STOP calling
          // this tool, and the only one with no branch here — so it rendered as
          // a bare enum and the model read it as "not ready yet, look again".
          const heldLine = record.status === TURN_SCOPED_HOLD_STATUS
            ? describeTurnScopedHold()
            : '';
          const mutationLine = mutationNeedsAttention
            ? [
                `Mutation review: step ${String(mutationBlock?.stepId ?? '?')}, tool ${String(mutationBlock?.tool ?? '?')}, fingerprint ${String(mutationBlock?.fingerprint ?? '').slice(0, 12) || '?'}.`,
                'The provider outcome may already have committed. No redispatch occurred; reconcile the exact receipt, then resume this same run only from its committed ledger replay (or cancel while leaving the external outcome explicitly unresolved).',
              ].join(' ')
            : '';
          const terminalOutcome = deriveWorkflowTerminalOutcome({
            status: record.status,
            finishedAt: record.finishedAt,
            needsAttention: record.needsAttention,
            terminalOutcome: record.terminalOutcome,
            reportBack: record.reportBack && typeof record.reportBack === 'object' && !Array.isArray(record.reportBack)
              ? { outcome: (record.reportBack as Record<string, unknown>).outcome }
              : undefined,
          });
          const lines = [
            `Run ${run_id}`,
            `Workflow: ${record.workflow ?? '(unknown)'}`,
            heldLine,
            `Status: ${record.status ?? '(unknown)'}${record.needsAttention || capabilityNeedsAttention || mutationNeedsAttention ? ' · NEEDS ATTENTION' : ''}`,
            terminalOutcome ? `Outcome: ${workflowTerminalOutcomeLabel(terminalOutcome)}` : '',
            record.createdAt ? `Created: ${record.createdAt}` : '',
            record.finishedAt ? `Finished: ${record.finishedAt}` : '',
            record.inputs && Object.keys(record.inputs).length > 0 ? `Inputs: ${JSON.stringify(record.inputs)}` : '',
            record.goalOutcome ? `Pinned goal: ${record.goalOutcome}${record.goalReason ? ` — ${record.goalReason}` : ''}` : '',
            record.error ? `Error: ${record.error}` : '',
            capabilityLine,
            mutationLine,
            blockedLines.length > 0 ? `Blocked steps:\n${blockedLines.join('\n')}` : '',
            failedItemLines.length > 0
              ? `Failed fan-out items:\n${failedItemLines.join('\n')}\nRetry: call workflow_rerun_failed_items with run_id="${run_id}"${new Set(failedItems.map((f) => f.stepId)).size > 1 ? ' and step_id set to one failed step' : ''}.`
              : '',
            stepLines.length > 0 ? `Step results:\n${stepLines.join('\n')}` : '',
            reportDetail && reportDetail !== output ? `Run report:\n${reportDetail}` : '',
            output ? `Final output (truncated):\n${output.length > 1500 ? `${output.slice(0, 1500)}…` : output}` : '',
          ].filter(Boolean);
          return textResult(lines.join('\n'));
        } catch (err) {
          return textResult(`Failed to read run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // No id → list active + recent runs so Clem can answer "what's running?".
      return textResult(renderWorkflowRunsOverview());
    },
  );

  server.tool(
    'workflow_rerun_failed_items',
    'Re-run only the failed forEach items from a prior workflow run. Use this after workflow_run_status shows failed fan-out items and the user asks to retry/fix/re-run just the failures. It reuses completed upstream work and skips items that already succeeded.',
    {
      run_id: z.string().min(1).describe('The source workflow run id that contains item_failed events.'),
      step_id: z.string().optional().describe('Required only when the source run has failed items in more than one forEach step.'),
    },
    async ({ run_id, step_id }) => {
      const queued = requeueWorkflowFailedItemsFromRun(run_id, {
        stepId: step_id,
        source: 'chat',
        originSessionId: getToolOutputContext()?.sessionId,
        recoveryIntent: {
          kind: 'failed_items',
          sourceRunId: run_id,
          sourceStepId: step_id,
          requestedFrom: 'chat',
          reason: 'workflow_rerun_failed_items tool request',
        },
      });
      if (queued.status === 'queued') {
        return textResult(
          `${queued.message}\n\nTell the user the failed items are being retried in the background and Clementine will report back when the retry run finishes. Do not poll or redo the work yourself.`,
        );
      }
      if (queued.status === 'ambiguous') {
        return textResult(`${queued.message}\n\nFailed items:\n${(queued.failedItems ?? []).map((f) => `- ${f.stepId} · ${f.itemKey}: ${f.error}`).join('\n')}`);
      }
      return textResult(queued.message);
    },
  );

  server.tool(
    'cron_progress_read',
    'Read saved progress state for a cron job.',
    {
      job_name: z.string().min(1),
    },
    async ({ job_name }) => {
      ensureDir(CRON_PROGRESS_DIR);
      const filePath = path.join(CRON_PROGRESS_DIR, `${safeName(job_name)}.json`);
      if (!existsSync(filePath)) return textResult(`No previous progress found for job "${job_name}".`);
      return textResult(readFileSync(filePath, 'utf-8'));
    },
  );

}
