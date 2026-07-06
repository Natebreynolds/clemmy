import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
import { queueWorkflowRun, queueWorkflowCreationTest, requeueWorkflowFailedItemsFromRun } from './workflow-run-queue.js';
import { surfaceWorkflowPendingInputs } from '../agents/plan-proposals.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { listEvents, getSession } from '../runtime/harness/eventlog.js';
import {
  unrequestedWorkflowRunMessage,
  workflowExplicitlyRequested,
} from './workflow-run-guard.js';
import {
  resolveWorkflowName,
  textRefersToWorkflow,
  workflowNamesEqual,
  type ResolverEntry,
} from './workflow-resolve.js';
import { addNotification } from '../runtime/notifications.js';
import { matchToolChoicesForStep, slugifyIntent, type StepToolChoiceMatch, type ToolChoiceRecord } from '../memory/tool-choice-store.js';
import { analyzeWorkflowIntent, type WorkflowBuilderIntent } from '../execution/workflow-builder-analysis.js';
import { synthesizeWorkflowDefinition, renderAnalysisForApproval } from '../execution/workflow-builder-synthesis.js';
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
  if (prep.errors.length > 0) {
    return {
      ok: false, errors: prep.errors, savedDef: prep.def, executionPlan, repairs: prep.repairs,
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
  // Same chat-aware binding as workflow_create: commit a toolkit the chat
  // discussed (e.g. Apify) into the step that names it before persisting.
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
  /** Confirmation lines for steps that were AUTO-bound (deterministic). */
  boundNotes: string[];
  /** Advisory lines for steps that SHOULD bind but weren't auto-bound. */
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

/** Auto-bind may NARROW the tool surface but must never WIDEN the auto-approval
 *  scope: if the author explicitly scoped the step (non-wildcard) and the proven
 *  family isn't already reachable, locking it in would silently auto-approve a
 *  tool they deliberately excluded. In that case we ADVISE instead of mutating. */
function canLockWithoutEscalation(existing: string[] | undefined, family: string[]): boolean {
  if (!existing || existing.length === 0 || existing.some((t) => t === '*')) return true; // wildcard → narrowing
  return family.every((f) =>
    existing.some((e) => e === f || (e.endsWith('*') && f.startsWith(e.slice(0, -1)))));
}

/**
 * Hybrid author-time binding (the centerpiece of tight authoring). For each
 * step, find the user's PROVEN tool-choice for what the step does:
 *   - HIGH-confidence cli/mcp match → AUTO-BIND: bake the exact command into the
 *     step prompt AND lock allowedTools to that family (dropping the composio
 *     drift gateway) so the run uses the path that works and can't re-decide.
 *   - MEDIUM match, or any composio match (identifier/connection rot-prone) →
 *     ADVISE only: name the exact command so the author can bind it; never mutate.
 *   - Already-bound or usesSkill steps are left untouched.
 * Mutates `steps` in place; returns notes for the tool result. Best-effort — a
 * matcher error never blocks the write (a clean store yields empty results).
 */
export function bindStepsToToolChoices(
  steps: Array<{ id?: string; prompt: string; allowedTools?: string[]; usesSkill?: string }>,
  opts: { choices?: ToolChoiceRecord[] } = {},
): StepBindResult {
  const boundNotes: string[] = [];
  const advisories: string[] = [];
  for (const step of steps) {
    if (step.usesSkill) continue; // a skill owns its own tool surface
    if (step.prompt.includes(BIND_DIRECTIVE_MARKER)) continue; // already engine-bound
    let matches: StepToolChoiceMatch[];
    try { matches = matchToolChoicesForStep(step.prompt, { choices: opts.choices }); } catch { continue; }
    const top = matches.find((m) => !m.alreadyBound);
    if (!top) continue;
    // AUTO-BIND only when it's a proven cli/mcp choice AND locking it in won't
    // silently widen the auto-approval scope the author chose; otherwise advise.
    const safeToLock = canLockWithoutEscalation(step.allowedTools, top.family);
    if (top.autoBindable && top.tier === 'high' && safeToLock) {
      const how = top.kind === 'cli' ? ' via run_shell_command' : '';
      const noun = top.kind === 'cli' ? 'command' : 'tool';
      const cmd = neutralizeTemplatePlaceholders(top.command);
      step.prompt =
        `${step.prompt}${BIND_DIRECTIVE_MARKER} use this exact, proven ${noun} (do not substitute another tool): \`${cmd}\`${how}.`;
      step.allowedTools = lockAllowedToolsTo(step.allowedTools, top.family);
      boundNotes.push(
        `Bound step \`${step.id ?? '?'}\` to your proven ${top.kind} \`${cmd}\` and locked its tools so the run can't drift onto a stale path.`,
      );
    } else {
      const cmd = neutralizeTemplatePlaceholders(top.command);
      const what = top.kind === 'composio'
        ? `could use your remembered \`${top.identifier}\``
        : `should use your proven \`${cmd}\``;
      advisories.push(
        `Step \`${step.id ?? '?'}\` ${what} — embed that exact ${top.kind === 'cli' ? 'command (via run_shell_command)' : 'tool'} in the step prompt and set its allowedTools to that family, so the run uses the proven path instead of re-deciding.`,
      );
    }
  }
  return { boundNotes, advisories };
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
// A step that actually USES an external tool names one of these.
const TOOLKIT_TOOL_INTENT = /\b(scraper|scrapers|actor|actors|connector|integration|api|crawl|crawler|toolkit)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    const named = discussed.find((tk) => {
      const nm = escapeRe(tk.name);
      if (!new RegExp(`\\b${nm}\\b`, 'i').test(prompt)) return false;
      // Skip when the name reads as a TARGET ("<name> page/posts/…").
      if (new RegExp(`\\b${nm}\\b\\s+(?:\\w+\\s+){0,1}${TOOLKIT_TARGET_NOUN.source}`, 'i').test(prompt)) return false;
      // Require real tool intent: a tool-noun present, or "use/via/with/prefer <name>".
      return TOOLKIT_TOOL_INTENT.test(prompt)
        || new RegExp(`\\b(?:use|using|via|with|prefer)\\b[\\s\\w]{0,20}\\b${nm}\\b`, 'i').test(prompt);
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

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'parked']);

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
 * every in-flight (queued/running/parked) or needs-attention run, plus the few
 * most-recent finished ones. Reads the run-record files directly — token-cheap.
 */
export function renderWorkflowRunsOverview(limit = 15): string {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return 'No workflow runs yet — nothing is running.';
  interface RunRow { id: string; workflow: string; status: string; createdAt?: string; needsAttention?: boolean; }
  const rows: RunRow[] = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      if (typeof r.id !== 'string') continue;
      rows.push({
        id: r.id,
        workflow: typeof r.workflow === 'string' ? r.workflow : '(unknown)',
        status: typeof r.status === 'string' ? r.status : 'unknown',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
        needsAttention: r.needsAttention === true,
      });
    } catch { /* skip malformed run file */ }
  }
  if (rows.length === 0) return 'No workflow runs yet — nothing is running.';
  const byCreated = (a: RunRow, b: RunRow) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  const active = rows.filter((r) => ACTIVE_RUN_STATUSES.has(r.status) || r.needsAttention).sort(byCreated);
  const recent = rows.filter((r) => !ACTIVE_RUN_STATUSES.has(r.status) && !r.needsAttention).sort(byCreated).slice(0, 5);
  const fmt = (r: RunRow) =>
    `- ${r.workflow} · ${r.status}${r.needsAttention ? ' · NEEDS ATTENTION' : ''} · run ${r.id}${r.createdAt ? ` · ${formatRunAge(r.createdAt)}` : ''}`;
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

/**
 * Step OUTPUT contract (WorkflowStepOutputContract). Shared by workflow_create
 * + workflow_update so authors can DECLARE what a step produces. Optional, by
 * design: a step with no `output` is unverified — byte-identical to before
 * (the gradual-typing / Dagster-asset-check posture). When declared, the engine
 * verifies the step's output against it before recording completion
 * (verifyStepOutput, runtime-enforced). Named properties (not an open map), so
 * it fills reliably under strict-mode function-calling.
 */
const WorkflowStepOutputContractSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional()
    .describe('The shape the step must produce.'),
  required_keys: z.array(z.string()).optional()
    .describe('For an object output: top-level keys that must be present and non-null.'),
  non_empty: z.array(z.string()).optional()
    .describe('Dot-paths whose value must be NON-EMPTY (a non-blank string, an array with ≥1 item, or an object with ≥1 key); "" / "." means the whole output. Declare on a data-producing step so a zero-row / blocked-but-shaped result ({prospects: []}) HALTS and reports back instead of feeding empty data downstream.'),
  min_items: z.record(z.string(), z.number().int().nonnegative()).optional()
    .describe('Map of dot-path → minimum array length (e.g. {"prospects": 1}). Stricter form of non_empty for "this source must yield at least N rows".'),
  verify: z.object({
    path_exists: z.array(z.string()).optional()
      .describe('Dot-paths in the output whose value must be an existing file path.'),
    url_present: z.array(z.string()).optional()
      .describe('Dot-paths in the output whose value must be a non-empty http(s) URL.'),
  }).optional()
    .describe('Concrete-handle checks — confirm the named output values are REAL (a file that exists, a non-empty URL), so "produced a brief" cannot pass when the file/URL does not actually exist.'),
  description: z.string().optional().describe('One-line note on what this step produces.'),
});

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

const STEP_INPUT_CONTRACT_DESC =
  'OPTIONAL step input/argument contract — what this step NEEDS before it runs. '
  + 'Keys are the step argument names; each value can bind from input.<key>, steps.<id>.output[.path], item[.path], project.path, project.name, or date. '
  + 'Declare this on mechanical single-tool steps with output contracts so the authoring compiler can convert them into direct `call` nodes safely. '
  + 'Example: {"target":{"from":"input.domain","type":"string"}}.';

const STEP_OUTPUT_CONTRACT_DESC =
  'OPTIONAL output contract — what this step PRODUCES. When declared, the engine verifies the step output against it BEFORE recording completion; a violation fails the step loudly (reports back) instead of feeding bad data to the next step. Declare it on any step whose output a later step depends on, and ALWAYS on the step that produces the final deliverable (e.g. a created sheet/file/URL), so the result is verified, not just claimed. Omit it for free-form/conversational steps.';

const WorkflowLoopUntilSchema = z.object({
  maxAttempts: z.number().min(1).max(10).optional(),
  probe: z.object({ runner: z.string().min(1) }).optional()
    .describe('Deterministic exit probe: a scripts/ helper (like deterministic.runner) run AFTER each attempt.'),
  until: WorkflowStepOutputContractSchema.optional()
    .describe('Contract the probe output must satisfy for the loop to EXIT — e.g. {"required_keys":["done"],"non_empty":["done"]} for poll-until-complete, or a min_items check for page-until-drained.'),
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
  'Step-level loop. Exit condition = the step\'s own output contract (retry-until-contract-passes, ≤5 attempts), OR probe+until (loop until EXTERNAL STATE satisfies the until contract — poll-until-done / paginate-until-drained, ≤10 attempts). Plain LLM read steps; write needs loopSafe; send never loops.';

interface CronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
  max_hours?: number;
}

// Workflow schema lives in the shared workflow-store module so the MCP
// tools, the daemon's workflow runner, and the dashboard REST routes
// all parse identical shapes. Importing the types instead of redefining
// them keeps the three surfaces in lock-step on field defaults.


// Cron → human recurrence. Canonical implementation lives in
// workflow-describe.ts (describeCron); this local alias keeps the cron_list
// call site readable while removing the duplicate humanizer.
const describeCronSchedule = describeCron;

function loadCronJobs(): CronJobRecord[] {
  if (!existsSync(CRON_FILE)) return [];
  try {
    const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
    return Array.isArray(parsed.data.jobs) ? (parsed.data.jobs as CronJobRecord[]) : [];
  } catch {
    return [];
  }
}

function saveCronJobs(jobs: CronJobRecord[]): void {
  ensureDir(path.dirname(CRON_FILE));
  const current = existsSync(CRON_FILE) ? matter(readFileSync(CRON_FILE, 'utf-8')) : matter('');
  current.data = { ...(current.data ?? {}), jobs };
  writeFileSync(CRON_FILE, matter.stringify(current.content || '# Cron Jobs\n', current.data), 'utf-8');
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readRunHistory(jobName: string, limit = 10): Array<{ status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; error?: string }> {
  const filePath = path.join(CRON_RUNS_DIR, `${safeName(jobName)}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as { status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; error?: string };
      } catch {
        return {};
      }
    })
    .reverse();
}

// Thin alias so existing callsites that wanted `entry.file` keep working.
// The shared store returns WorkflowEntry with `filePath` + `layout`; we
// expose the basename here for log readability.
function listWorkflowFiles(): WorkflowEntry[] {
  return listWorkflows();
}

export function registerOrchestrationTools(server: McpServer): void {
  server.tool(
    'cron_run_history',
    'Query recent execution history for a cron job.',
    {
      job_name: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ job_name, limit }) => {
      const runs = readRunHistory(job_name, limit ?? 10);
      if (runs.length === 0) return textResult(`No execution history found for job '${job_name}'.`);
      return textResult(
        [
          `## Run History: ${job_name}`,
          ...runs.map((run) => {
            const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '?';
            return `- [${run.status ?? 'unknown'}] ${run.startedAt ?? 'unknown start'} (${duration})${run.error ? ` | ${run.error}` : ''}`;
          }),
        ].join('\n'),
      );
    },
  );

  server.tool(
    'cron_list',
    'List all scheduled cron jobs with schedules, next run times, and recent status.',
    {},
    async () => {
      const jobs = loadCronJobs();
      if (jobs.length === 0) return textResult('No cron jobs configured.');
      return textResult(
        jobs
          .map((job) => {
            const nextRun = job.enabled === false ? null : getNextRun(job.schedule);
            const lastRun = readRunHistory(job.name, 1)[0];
            return [
              `**${job.name}** [${job.enabled === false ? 'disabled' : 'enabled'}]${job.mode === 'unleashed' ? ' [unleashed]' : ''}`,
              `  Schedule: ${describeCronSchedule(job.schedule)} (\`${job.schedule}\`)`,
              nextRun ? `  Next run: ${nextRun}` : '',
              lastRun ? `  Last run: ${lastRun.status ?? 'unknown'}${lastRun.finishedAt ? ` at ${lastRun.finishedAt}` : ''}` : '',
              job.work_dir ? `  Work dir: ${job.work_dir}` : '',
              `  Prompt: ${job.prompt.slice(0, 120)}${job.prompt.length > 120 ? '...' : ''}`,
            ].filter(Boolean).join('\n');
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'add_cron_job',
    'Add a scheduled cron job to CRON.md.',
    {
      name: z.string().min(1),
      schedule: z.string().min(1),
      prompt: z.string().min(1),
      tier: z.number().optional(),
      enabled: z.boolean().optional(),
      work_dir: z.string().optional(),
      mode: z.enum(['standard', 'unleashed']).optional(),
      max_hours: z.number().optional(),
    },
    async ({ name, schedule, prompt, tier, enabled, work_dir, mode, max_hours }) => {
      if (!validateCronExpression(schedule)) {
        return textResult(`Invalid cron expression: "${schedule}"`);
      }

      const jobs = loadCronJobs();
      if (jobs.some((job) => job.name.toLowerCase() === name.toLowerCase())) {
        return textResult(`A job named "${name}" already exists.`);
      }

      jobs.push({
        name,
        schedule,
        prompt,
        tier: tier ?? 1,
        enabled: enabled ?? true,
        work_dir,
        mode: mode ?? 'standard',
        max_hours,
      });
      saveCronJobs(jobs);

      return textResult(`Added cron job "${name}".`);
    },
  );

  server.tool(
    'trigger_cron_job',
    'Trigger an existing cron job to run immediately by writing a trigger file.',
    {
      job_name: z.string().min(1),
    },
    async ({ job_name }) => {
      const job = loadCronJobs().find((entry) => entry.name === job_name);
      if (!job) return textResult(`Job "${job_name}" not found.`);
      ensureDir(CRON_TRIGGERS_DIR);
      const filePath = path.join(CRON_TRIGGERS_DIR, `${Date.now()}-${safeName(job_name)}.trigger.json`);
      writeFileSync(filePath, JSON.stringify({ jobName: job_name, triggeredAt: new Date().toISOString() }, null, 2), 'utf-8');
      return textResult(`Triggered "${job_name}".`);
    },
  );

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
    "Create a workflow. Clementine intelligently handles it however you describe it: give a simple goal (\"audit sites daily and email the report\") and I'll break it into steps, suggest tools, and ask for approval. Or give full step-by-step details for more control. Either way, I analyze for gaps, validate dependencies, and ensure it's production-ready. "
      + "SIMPLE MODE: Just describe what you want automated (e.g., \"Research a domain's SEO metrics and summarize them as JSON\"). I'll intelligently break it into steps, suggest tools, detect parallelization, and show you the plan before creating. "
      + "ADVANCED MODE: Provide step-by-step definitions with full prompts, dependencies, and tool choices for complete control. I still validate and suggest improvements. "
      + "AUTHORING MODEL: Workflows are AUTONOMOUS BY DEFAULT — they run end-to-end on your one-time consent (enabling), WITHOUT pausing for per-step approval, unless you set `requiresApproval: true` on irreversible actions (sends, publishes). "
      + "Each step does ONE job; outputs flow to dependent steps automatically via `dependsOn`. Steps with the same dependsOn run in parallel. Use forEach for per-item fan-out. "
      + "DECLARE STEP INPUTS on mechanical tool steps: `inputs` maps argument names to sources like input.domain or steps.fetch.output.rows. If the exact tool + args are known, prefer `call`; otherwise a single direct allowedTools slug + inputs + output lets the compiler codify it safely. "
      + "DECLARE OUTPUT CONTRACTS on any step whose output a later step depends on (type, required_keys, verify.path_exists). The engine verifies before continuing, preventing hollow results from feeding downstream. "
      + "DECLARE sideEffect on every step ('read' | 'write' | 'send') — it drives the safety law: send steps never auto-retry, crash-resume halts on interrupted writes/sends. "
      + "PINNED GOAL: declare `goal` to make the workflow run-to-completion — every completed run is validated EXTERNALLY against the goal's success criteria; an unmet goal automatically re-runs the workflow with the validation feedback (bounded by max_attempts, never after an irreversible step executed), and an exhausted goal parks loudly for the user. "
      + "Call workflow_list first to see existing workflow shapes.",
    {
      name: z.string().min(1),
      description: z.string().min(1),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().optional().describe('The step task. Outputs from dependsOn steps arrive automatically in STEP CONTEXT.upstream; reference {{steps.<id>.output}} only when a precise inline value is useful. Reference a workflow input with {{input.<key>}}, the local project with {{project.path}} / {{project.name}}, and iterate with {{item}} under forEach. Optional when `call` or `deterministic` is the executor.'),
        project: z.string().optional().describe('Local workspace/project name or path this step requires. Omit to inherit the workflow-level project. Readiness preflight blocks the run if the project is not available locally.'),
        dependsOn: z.array(z.string()).optional().describe('Step IDs this step waits for. Their outputs are automatically available to this step in STEP CONTEXT.upstream.'),
        model: z.string().optional(),
        intent: z.string().optional().describe('Optional free-form model-routing category for this step, e.g. "design". If a worker model is bound for that category, this step routes there unless model is explicitly set.'),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        forEachNewOnly: z.boolean().optional().describe('Cross-run watermark: fan out over only items NOT completed by any prior run of this workflow (stable key = item.id/key/slug). Use for recurring "process new arrivals" feeds — new leads, new emails, new rows. Failed items retry next run; requires forEach.'),
        call: z.object({
          tool: z.string().min(1).describe('Tool slug to invoke directly (v1: a composio slug).'),
          args: z.record(z.string(), z.unknown()).optional().describe('Arguments. String values template: {{input.x}}, {{steps.<id>.output[.path]}}, {{item[.path]}}, {{project.path}}, {{date}} — a value that is EXACTLY one token resolves to the raw upstream value (object/array preserved).'),
        }).optional().describe('STRUCTURED TOOL CALL — the runner executes this tool DIRECTLY with no LLM turn (deterministic, free, un-phantomable). Use when the tool + arg shape are known. A reasoned tool USE (deciding which tool / shaping ambiguous input) stays a normal prompt step. No prompt needed. Mutually exclusive with deterministic. May combine with forEach for READ-class calls; send/write call fan-out is blocked until per-call idempotency tracking lands.'),
        deterministic: z.object({
          runner: z.string().min(1).describe('Relative script path inside the workflow\'s scripts/ dir, e.g. "fetch-keywords.js". Extensions: .js/.mjs/.cjs/.ts/.py/.sh or a shebang executable.'),
          source: z.string().optional().describe('The script\'s SOURCE CODE. When provided, I write it to scripts/<runner> at save time so the step runs immediately — this is how you WRITE CODE for a mechanical step. The script must print ONE JSON document to stdout. Reference inputs/upstream via argv or env you set in the step. Omit only to reuse a script already in scripts/.'),
        }).optional().describe('DETERMINISTIC SCRIPT step — the agent writes CODE that runs in a sandbox with NO LLM turn (token-free, fast, repeatable every run). Use for mechanical work with a known procedure: shell/CLI, HTTP/API, or data transforms that do not need reasoning. Mutually exclusive with call and prompt.'),
        allowedTools: z.array(z.string()).optional(),
        usesSkill: z.string().optional().describe('Installed skill directory name (under skills/). For repeatable transforms, prefer one usesSkill step over many hand-wired prompt steps.'),
        requiresApproval: z.boolean().optional(),
        approvalPreview: z.string().optional(),
        inputs: z.record(z.string(), WorkflowStepInputBindingSchema).optional().describe(STEP_INPUT_CONTRACT_DESC),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
        sideEffect: z.enum(['read', 'write', 'send']).optional().describe("External side-effect class. 'read' = gathers data only; 'write' = mutates local/remote state reversibly; 'send' = irreversible outbound (email/publish/post). Drives the safety law: send never auto-retries, crash-resume halts on interrupted writes/sends. Declare it — undeclared steps fall back to prose heuristics."),
        loopUntil: WorkflowLoopUntilSchema.optional().describe(LOOP_UNTIL_DESC),
        loopSafe: z.boolean().optional().describe('Author assertion that re-running this WRITE step is idempotent (e.g. an upsert keyed on a stable id). Required for loopUntil on write steps; also allows goal re-pursuit past this step.'),
      })).optional().describe('(Optional) If omitted, I intelligently break down your description into steps. If provided, I still validate and suggest improvements.'),
      project: z.string().optional().describe('Default local workspace/project name or path for this workflow. Use when steps operate in a specific repo or local project; step-level project overrides it.'),
      trigger_schedule: z.string().optional(),
      trigger_webhook_path: z.string().optional().describe('URL-safe slug: the workflow fires when an external service POSTs to /api/hooks/workflows/<path> (token-gated). Use for "when X happens in another system" asks that can call a webhook.'),
      trigger_events: z.array(WorkflowTriggerEventSchema).optional().describe('EVENT-DRIVEN recurrence: the workflow fires when a matching internal system event is emitted (composio trigger, watcher, another workflow). Prefer this over cron polling for "when a new X arrives" asks.'),
      inputs: z.string().optional().describe('JSON object mapping input NAMES to {type?, default?, description?}, e.g. {"url":{"type":"string","description":"Site to audit"}}. A JSON string fills reliably under strict-mode function-calling where an open map does not. Event/webhook payload fields auto-bind to declared inputs of the same name; an input named "payload" receives the whole event JSON.'),
      resources: z.string().optional().describe('JSON object mapping durable resource IDs to bindings, e.g. {"lead_sheet":{"kind":"sheet","toolkit":"googlesheets","resourceId":"<spreadsheet id>","name":"Leads"}}. Use for fixed accounts, sheets, folders, campaigns, channels, repos, CLIs, and API endpoints that the workflow should remember between runs; do NOT put these in run inputs.'),
      test_inputs: z.string().optional().describe('JSON object with concrete non-secret inputs for the authoring smoke test, e.g. {"url":"https://example.com"}. Use when an external read step needs inputs that are not defaulted in `inputs`; otherwise the workflow stays disabled until it can be verified.'),
      synthesis_prompt: z.string().optional(),
      portable_models: z.boolean().optional().describe('Set true when the workflow should run on any available model/provider. This removes exact per-step model pins and keeps intent/default routing instead. Omit/false to preserve intentional model pins.'),
      allowSends: z.boolean().optional().describe('Allow autonomous sends/publishes without approval gates. Defaults to true (autonomous). Set false for strict mode: any send-looking step must then carry requiresApproval: true or the save is refused.'),
      goal: z.object({
        objective: z.string().min(4).describe('What a completed run must achieve — judged externally at run completion.'),
        success_criteria: z.array(z.string()).optional().describe('Concrete pass/fail criteria (file paths are checked deterministically; the rest go to one strict judge call). Empty → the objective itself is judged.'),
        max_attempts: z.number().min(1).max(3).optional().describe('Total run attempts (original + automatic re-pursuits). Default 2, ceiling 3 — re-pursuit re-runs the whole workflow.'),
      }).optional().describe('PINNED RUN GOAL (run-to-completion): the run is validated externally against these criteria at completion; unmet → automatic re-run with the validation feedback folded into every step prompt (never after an irreversible step executed); exhausted → parks loudly with per-criterion evidence.'),
    },
    async ({ name, description, steps, project, trigger_schedule, trigger_webhook_path, trigger_events, inputs, resources, test_inputs, synthesis_prompt, portable_models, allowSends, goal }) => {
      // INTELLIGENT WORKFLOW CREATION:
      // If steps not provided, analyze the description and generate steps intelligently
      let finalSteps = steps;
      let analysisReport = '';

      if (!steps || steps.length === 0) {
        // Simple mode: description only, analyze and generate steps
        const analysis = analyzeWorkflowIntent({
          description,
          frequency: trigger_schedule,
        });

        // Show analysis to user
        analysisReport = `\n\n📋 **Workflow Analysis**\n${renderAnalysisForApproval(analysis)}\n`;

        // Generate steps from analysis
        const workflowDef = synthesizeWorkflowDefinition(analysis);
        finalSteps = workflowDef.steps;

        // Use suggested inputs if not provided
        if (!inputs && workflowDef.inputs) {
          inputs = JSON.stringify(workflowDef.inputs);
        }
      }

      // Validate that we have steps
      if (!finalSteps || finalSteps.length === 0) {
        return textResult('Workflow must have at least one step. Either provide steps directly or describe what you want to automate.');
      }

      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      let resourceBindings: Record<string, WorkflowResourceBinding>;
      try {
        resourceBindings = parseWorkflowResourcesJson(resources);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      let providedSmokeInputs: Record<string, string>;
      try {
        providedSmokeInputs = parseWorkflowRunInputsJson(test_inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const stepGraphError = validateWorkflowStepGraph(finalSteps);
      if (stepGraphError) return textResult(stepGraphError);
      const triggerResult = buildWorkflowTrigger({
        schedule: trigger_schedule,
        webhookPath: trigger_webhook_path,
        events: trigger_events,
      });
      if (!triggerResult.ok) return textResult(triggerResult.error);

      if (!/[a-zA-Z0-9]/.test(name)) {
        return textResult('Please give the workflow a name with at least one letter or number.');
      }
      const dirName = workflowSlugFromName(name);
      if (readWorkflow(dirName)) return textResult(`Workflow "${name}" already exists.`);

      const def: WorkflowDefinition = {
        name,
        description,
        ...(typeof project === 'string' && project.trim() ? { project: project.trim() } : {}),
        enabled: true,
        trigger: triggerResult.trigger,
        steps: normalizeWorkflowSteps(finalSteps),
        ...(allowSends !== undefined ? { allowSends } : {}),
        ...(goal ? { goal: { objective: goal.objective, successCriteria: goal.success_criteria, maxAttempts: goal.max_attempts } } : {}),
        resources: Object.keys(resourceBindings).length > 0 ? resourceBindings : undefined,
        inputs: Object.keys(inputsSchema).length > 0 ? inputsSchema : undefined,
        synthesis: synthesis_prompt ? { prompt: synthesis_prompt } : undefined,
      };
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
      // is what stops a doomed workflow (scorpion: scrape step bound no tool,
      // improvised raw HTTP, returned empty, reported success) from being saved
      // live + untested. Pure-LLM / all-mutating workflows skip the gate
      // (nothing real to validate). External-read workflows with missing smoke
      // inputs stay disabled until `test_inputs` or input defaults can bind
      // a real creation test.
      const preWriteNeedsCreationTest = workflowNeedsCreationTest(def);
      if (preWriteNeedsCreationTest) def.enabled = false;
      // Author through the canonical core (bind → auto-repair + validate →
      // persist → gap-test). Auto-repair saves a runnable workflow in one shot
      // instead of bouncing the author into a token-burning re-author loop;
      // refuse only if the repaired workflow still can't flow. Shared with
      // workflow_from_session so promotion can't drift from this path.
      const created = commitAuthoredWorkflow(def, dirName, {
        modelPortability: portable_models ? 'portable' : 'preserve',
      });
      if (!created.ok) {
        return textResult(
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
        + `${renderWorkflowGapQuestions(created.gaps)}`;
      if (created.gaps.length > 0) {
        if (created.savedDef.enabled) {
          created.savedDef.enabled = false;
          writeWorkflowAndSyncTriggers(dirName, created.savedDef);
        }
        return textResult(
          `${analysisReport}`
          + `Created workflow "${name}" (saved DISABLED pending readiness answers). Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
          + `${appendDataSources(created.savedDef)}`
          + `${appendVisualContract(created.executionPlan)}`
          + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}\n\n`
          + `${renderReadinessHold(name)}${advisoryTail}`,
        );
      }
      if (needsCreationTest) {
        const testInputs = workflowSmokeInputs(created.savedDef, providedSmokeInputs);
        const missingSmokeInputs = missingWorkflowRunInputs(created.savedDef, testInputs);
        if (missingSmokeInputs.length > 0) {
          return textResult(
            `${analysisReport}`
            + `Created workflow "${name}" (saved DISABLED pending verification). Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
            + `${appendDataSources(created.savedDef)}`
            + `${appendVisualContract(created.executionPlan)}`
            + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}\n\n`
            + `${renderMissingSmokeInputs(name, missingSmokeInputs)}${advisoryTail}`,
          );
        }
        const queued = queueWorkflowCreationTest(name, testInputs, { originSessionId: getToolOutputContext()?.sessionId });
        return textResult(
          `${analysisReport}`
          + `Created workflow "${name}" (saved DISABLED while I test it). Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
          + `${appendDataSources(created.savedDef)}`
          + `${appendVisualContract(created.executionPlan)}`
          + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}\n\n`
          + `${queued.message}${advisoryTail}`,
        );
      }
      return textResult(
        `${analysisReport}`
        + `Created workflow "${name}". Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
        + `${appendDataSources(created.savedDef)}`
        + `${appendVisualContract(created.executionPlan)}`
        + `\n\nSaved to workflows/${dirName}/SKILL.md.${createBindReport}`
        + `${advisoryTail}`,
      );
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
        return textResult(
          `No workflow is named exactly "${name}". The closest match is "${resolution.name}". `
            + `Confirm with the user before running it — e.g. "Just to confirm, did you want me to kick off your ${resolution.name} workflow? I'll report back once it's done." — `
            + `then call workflow_run with name "${resolution.name}".`,
        );
      }
      // Exact match → run it.
      const workflow = all.find((e) => workflowNamesEqual(e.data.name, resolution.name));
      if (!workflow) return textResult(`Workflow "${name}" not found.`);
      const canonicalName = workflow.data.name;
      if (!workflow.data.enabled) return textResult(`Workflow "${canonicalName}" is disabled.`);

      // Soft boundary guard (2026-05-31 incident): do NOT silently auto-run a
      // workflow the user did not explicitly name in their recent request.
      // Scheduled/cron runs do not pass through this tool (they are driven by
      // the daemon runner), so this is naturally chat/agent-scoped. When there
      // is no session context (internal/test/non-chat caller) we SKIP the guard
      // and allow the run — that no-context skip is also what keeps the
      // existing orchestration-tools tests green.
      const guardCtx = getToolOutputContext();
      if (guardCtx?.sessionId) {
        let recentUserText = '';
        try {
          const inputEvents = listEvents(guardCtx.sessionId, {
            types: ['user_input_received'],
            desc: true,
            limit: 5,
          });
          recentUserText = inputEvents
            .map((event) => {
              const data = event.data as { text?: unknown };
              // The canonical user-message text lives in data.text (see
              // session.ts / plan-first.ts append sites; discord-harness.ts
              // reads data.text). Fall back to stringifying the whole data
              // object so a future field rename can't silently no-op the guard.
              return typeof data?.text === 'string' ? data.text : JSON.stringify(event.data ?? {});
            })
            .join('\n');
        } catch {
          // Event-log read failure must not block a legitimate run.
          recentUserText = '';
        }

        // Use the workflow store name + directory basename as slug variants.
        // Take only the basename of dir (never the full absolute path) so an
        // unrelated path segment can't produce a spurious "explicitly
        // requested" match.
        const slugCandidates = [workflow.name, path.basename(workflow.dir)].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        );
        // The user "explicitly requested" this workflow if their recent text
        // names it directly OR resolves to it by matching name (so a confirmed
        // fuzzy run — "kick off my prospecting flow" → Morning Prospect Prep —
        // isn't re-blocked as unrequested). A request that clearly points at a
        // DIFFERENT workflow (or none) still fails the guard.
        const thisEntry: ResolverEntry = { name: canonicalName, slug: path.basename(workflow.dir) };
        if (
          recentUserText.trim() !== '' &&
          !workflowExplicitlyRequested(canonicalName, slugCandidates, recentUserText) &&
          !textRefersToWorkflow(recentUserText, thisEntry, resolverEntries)
        ) {
          return textResult(unrequestedWorkflowRunMessage(canonicalName));
        }
      }

      let parsedInputs: Record<string, string>;
      try {
        parsedInputs = parseWorkflowRunInputsJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const normalizedInputs = normalizeWorkflowRunInputs(parsedInputs);
      const runCertification = certifyWorkflow(workflow.data, {
        workflowSlug: workflow.name,
        runInputs: normalizedInputs,
      });
      if (runCertification.resourceGaps.length > 0) {
        return textResult(
          `${renderWorkflowCertification(runCertification)}\n\n${renderWorkflowCertificationCommandHint(runCertification)}`,
          { maxChars: 40_000 },
        );
      }
      const missing = missingWorkflowRunInputs(workflow.data, normalizedInputs);
      if (missing.length > 0) {
        // Ask-then-resume: in a chat context, surface a pending-inputs proposal
        // keyed to the session so the user's NEXT reply supplies the values and
        // we resume the run (see plan-continuity). This replaces the old
        // model-directed retry message that the strict-mode schema could not
        // satisfy — the call that drove the 84× / 3-min hang. No session context
        // (tests / internal callers) → keep the deterministic rejection.
        if (guardCtx?.sessionId) {
          surfaceWorkflowPendingInputs({
            workflowName: canonicalName,
            requiredInputs: missing,
            providedInputs: normalizedInputs,
            sessionId: guardCtx.sessionId,
            originatingRequest: `Run the "${canonicalName}" workflow`,
          });
          const inputList = missing.map((key) => `\`${key}\``).join(', ');
          return textResult(
            `I need ${inputList} to run the "${canonicalName}" workflow. Reply with ${missing.length === 1 ? 'it' : 'them'} and I'll run it.`,
          );
        }
        return textResult(
          [
            `Workflow "${canonicalName}" was not queued because required input${missing.length === 1 ? '' : 's'} ${missing.map((key) => `"${key}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
            `Call workflow_run again with inputs including ${missing.map((key) => `"${key}": "<value>"`).join(', ')}.`,
          ].join('\n'),
        );
      }

      // Gap E: carry the triggering chat session so the run re-enters it on a
      // terminal state (in-context report-back, in ADDITION to the global
      // notification). guardCtx is the agent's tool-output context resolved
      // above; absent for non-chat callers → notification-only.
      return textResult(
        queueWorkflowRun(canonicalName, normalizedInputs, { originSessionId: guardCtx?.sessionId }).message,
      );
    },
  );

  server.tool(
    'workflow_get',
    'Fetch the full definition of a single workflow by name. Includes description, trigger, every step with its FULL prompt (line-numbered) + its derived DATA SOURCES (which tools/connectors/scripts it actually uses — e.g. Salesforce vs Composio), dependencies, declared inputs, and synthesis prompt. '
      + 'Read this BEFORE editing: copy a VERBATIM snippet of a step prompt into workflow_edit_step. Pass step="<id>" to read just one step in full when a workflow is large.',
    {
      name: z.string().min(1),
      step: z.string().optional().describe('Optional step id — return just this step\'s full text + data sources (use when a workflow is too large to read whole).'),
    },
    async ({ name, step }) => {
      const allGet = listWorkflowFiles();
      let entry = allGet.find((w) => w.data.name === name);
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
        const det = stp.deterministic ? ` deterministic=${stp.deterministic.runner}` : '';
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
        return [`  ${stp.id}${deps}${project}${model}${forEach}${det}`, sourcesLine, runnerLine, '    prompt:', numbered].filter(Boolean).join('\n');
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
      const trigger = w.trigger.schedule ? `schedule: ${w.trigger.schedule}` : (w.trigger.manual ? 'manual only' : 'manual');
      const allowed = w.allowedTools && w.allowedTools.length > 0
        ? w.allowedTools.map((t) => (typeof t === 'string' ? t : `${t.name}${t.approval === 'required' ? ' (approval)' : ''}`)).join(', ')
        : '(any)';
      // Lead with the plain-English summary — what a human actually wants to
      // read ("what does this do, when, what it needs/produces, where it
      // pauses") — then keep the technical block below for precise editing.
      return textResult([
        describeWorkflowPlainEnglish(w),
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
          return textResult(error instanceof Error ? error.message : String(error));
        }
      }
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);
      // A workflow whose data can't flow can't be ENABLED (disabling is
      // always allowed). Auto-repair the fixable binding gaps first, so
      // enabling an older workflow with a dangling reference fixes it in
      // place instead of refusing.
      if (enabled) {
        const prep = prepareWorkflowEnableForWrite(entry.data);
        if (prep.status === 'invalid') {
          return textResult(
            `Workflow "${name}" was NOT enabled — fix these first:\n- ${prep.errors.join('\n- ')}`,
          );
        }
        if (prep.status === 'readiness_gaps') {
          writeWorkflowAndSyncTriggers(entry.name, prep.def);
          return textResult(
            `Workflow "${name}" was NOT enabled. ${renderReadinessHold(name)}`
              + `${renderWorkflowGapQuestions(prep.gaps)}`
              + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
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
            return textResult(
              `Workflow "${name}" was NOT enabled. ${renderMissingSmokeInputs(name, enableVerification.missing)}`,
            );
          }
          const queued = queueWorkflowCreationTest(entry.name, enableVerification.inputs, { originSessionId: getToolOutputContext()?.sessionId });
          return textResult(
            `Verifying "${name}" before it goes live — ${queued.message}`
              + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
          );
        }
        writeWorkflowAndSyncTriggers(entry.name, prep.def);
        // Re-enabling is a deliberate fresh start — clear any chronic-failure
        // streak so auto-heal/escalation resets (#6).
        clearWorkflowFailures(entry.name);
        return textResult(
          `Workflow "${name}" is now approved (enabled).`
            + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
        );
      }
      writeWorkflowAndSyncTriggers(entry.name, { ...entry.data, enabled });
      return textResult(`Workflow "${name}" is now disabled.`);
    },
  );

  server.tool(
    'workflow_update',
    'Modify an existing workflow: update description, trigger schedule, steps, inputs, or synthesis. Pass only the fields you want to change — others are preserved. Step IDs and dependencies are re-validated. '
      + 'Design THIN agentic steps: a few capable steps (each doing a whole meaningful chunk), not many micro-steps. `dependsOn` both orders steps and carries upstream outputs into the downstream STEP CONTEXT. '
      + 'For mechanical tool steps, declare `inputs` argument bindings plus `output`, or use `call` directly when the exact tool and args are known.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().optional().describe('The step task. Outputs from dependsOn steps arrive automatically in STEP CONTEXT.upstream; reference {{steps.<id>.output}} only when a precise inline value is useful. Reference a workflow input with {{input.<key>}}, the local project with {{project.path}} / {{project.name}}, and iterate with {{item}} under forEach. Optional when `call` or `deterministic` is the executor.'),
        project: z.string().optional().describe('Local workspace/project name or path this step requires. Omit to inherit the workflow-level project.'),
        dependsOn: z.array(z.string()).optional().describe('Step IDs this step waits for. Their outputs are automatically available to this step in STEP CONTEXT.upstream.'),
        model: z.string().optional(),
        intent: z.string().optional().describe('Optional free-form model-routing category for this step, e.g. "design". If a worker model is bound for that category, this step routes there unless model is explicitly set.'),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        forEachNewOnly: z.boolean().optional().describe('Cross-run watermark: fan out over only items NOT completed by any prior run of this workflow (stable key = item.id/key/slug). Use for recurring "process new arrivals" feeds — new leads, new emails, new rows. Failed items retry next run; requires forEach.'),
        call: z.object({
          tool: z.string().min(1).describe('Tool slug to invoke directly (v1: a composio slug).'),
          args: z.record(z.string(), z.unknown()).optional().describe('Arguments. String values template: {{input.x}}, {{steps.<id>.output[.path]}}, {{item[.path]}}, {{project.path}}, {{date}} — a value that is EXACTLY one token resolves to the raw upstream value (object/array preserved).'),
        }).optional().describe('STRUCTURED TOOL CALL — the runner executes this tool DIRECTLY with no LLM turn (deterministic, free, un-phantomable). Use when the tool + arg shape are known. A reasoned tool USE (deciding which tool / shaping ambiguous input) stays a normal prompt step. No prompt needed. Mutually exclusive with deterministic. May combine with forEach for READ-class calls; send/write call fan-out is blocked until per-call idempotency tracking lands.'),
        deterministic: z.object({
          runner: z.string().min(1).describe('Relative script path inside the workflow\'s scripts/ dir, e.g. "fetch-keywords.js". Extensions: .js/.mjs/.cjs/.ts/.py/.sh or a shebang executable.'),
          source: z.string().optional().describe('The script\'s SOURCE CODE. When provided, I write it to scripts/<runner> at save time so the step runs immediately — this is how you WRITE CODE for a mechanical step. The script must print ONE JSON document to stdout. Reference inputs/upstream via argv or env you set in the step. Omit only to reuse a script already in scripts/.'),
        }).optional().describe('DETERMINISTIC SCRIPT step — the agent writes CODE that runs in a sandbox with NO LLM turn (token-free, fast, repeatable every run). Use for mechanical work with a known procedure: shell/CLI, HTTP/API, or data transforms that do not need reasoning. Mutually exclusive with call and prompt.'),
        allowedTools: z.array(z.string()).optional(),
        requiresApproval: z.boolean().optional().describe('Set true to pause this step for user approval before execution (for irreversible sends / publishes).'),
        approvalPreview: z.string().optional().describe('One-line preview shown on the approval card when requiresApproval is set.'),
        usesSkill: z.string().optional().describe('Installed skill directory name (under skills/). For repeatable transforms, prefer one usesSkill step over many hand-wired prompt steps.'),
        inputs: z.record(z.string(), WorkflowStepInputBindingSchema).optional().describe(STEP_INPUT_CONTRACT_DESC),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
        sideEffect: z.enum(['read', 'write', 'send']).optional().describe("External side-effect class ('read' | 'write' | 'send'). Drives the safety law: send never auto-retries, crash-resume halts on interrupted writes/sends."),
        loopUntil: WorkflowLoopUntilSchema.optional().describe(LOOP_UNTIL_DESC),
        loopSafe: z.boolean().optional().describe('Author assertion that re-running this WRITE step is idempotent. Required for loopUntil on write steps; also allows goal re-pursuit past this step.'),
      })).optional(),
      project: z.string().optional().describe('Set or clear the workflow-level default local workspace/project. Empty string clears it.'),
      clear_project: z.boolean().optional().describe('Pass true to remove the workflow-level default local project.'),
      trigger_schedule: z.string().optional(),
      clear_trigger_schedule: z.boolean().optional().describe('Pass true to remove an existing schedule (e.g. switch back to manual-only).'),
      trigger_webhook_path: z.string().optional().describe('URL-safe slug: the workflow fires when an external service POSTs to /api/hooks/workflows/<path> (token-gated). Pass an empty string or clear_trigger_webhook_path=true to remove it.'),
      clear_trigger_webhook_path: z.boolean().optional().describe('Pass true to remove an existing webhook trigger path.'),
      trigger_events: z.array(WorkflowTriggerEventSchema).optional().describe('Replace the workflow event subscriptions. Pass [] or clear_trigger_events=true to remove existing event triggers.'),
      clear_trigger_events: z.boolean().optional().describe('Pass true to remove existing internal event trigger subscriptions.'),
      inputs: z.string().optional().describe('JSON object mapping input NAMES to {type?, default?, description?}, e.g. {"url":{"type":"string","description":"Site to audit"}}. Pass only to change the input schema; omit to preserve it.'),
      resources: z.string().optional().describe('JSON object mapping durable resource IDs to bindings, e.g. {"ads_account":{"kind":"account","toolkit":"googleads","account":"123-456-7890"}}. Pass only to replace resource bindings; omit to preserve them.'),
      clear_resources: z.boolean().optional().describe('Pass true to remove all workflow resource bindings.'),
      test_inputs: z.string().optional().describe('JSON object with concrete non-secret inputs for the re-verification smoke test when this update changes an enabled workflow, e.g. {"url":"https://example.com"}.'),
      synthesis_prompt: z.string().optional(),
      portable_models: z.boolean().optional().describe('Set true when this update should make the workflow portable across model providers by removing exact per-step model pins. Omit/false to preserve intentional model pins.'),
      allowSends: z.boolean().optional().describe('Allow autonomous sends/publishes without approval gates. Defaults to true (autonomous). Set false for strict mode: any send-looking step must then carry requiresApproval: true or the save is refused.'),
      goal: z.object({
        objective: z.string().min(4).describe('What a completed run must achieve — judged externally at run completion.'),
        success_criteria: z.array(z.string()).optional().describe('Concrete pass/fail criteria. Empty → the objective itself is judged.'),
        max_attempts: z.number().min(1).max(3).optional().describe('Total run attempts (original + automatic re-pursuits). Default 2, ceiling 3.'),
      }).optional().describe('PINNED RUN GOAL (run-to-completion) — see workflow_create. Pass to set/replace; use clear_goal to remove.'),
      clear_goal: z.boolean().optional().describe('Pass true to remove an existing pinned goal.'),
    },
    async ({ name, description, steps, project, clear_project, trigger_schedule, clear_trigger_schedule, trigger_webhook_path, clear_trigger_webhook_path, trigger_events, clear_trigger_events, inputs, resources, clear_resources, test_inputs, synthesis_prompt, portable_models, allowSends, goal, clear_goal }) => {
      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      let resourceBindings: Record<string, WorkflowResourceBinding>;
      try {
        resourceBindings = parseWorkflowResourcesJson(resources);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      let providedSmokeInputs: Record<string, string>;
      try {
        providedSmokeInputs = parseWorkflowRunInputsJson(test_inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const inputsProvided = Object.keys(inputsSchema).length > 0;
      const resourcesProvided = resources !== undefined;
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);

      if (steps) {
        const stepGraphError = validateWorkflowStepGraph(steps);
        if (stepGraphError) return textResult(stepGraphError.replace('found.', 'in update.'));
      }

      const next: WorkflowDefinition = { ...entry.data };
      if (description !== undefined) next.description = description;
      if (clear_project) delete next.project;
      else if (project !== undefined) {
        const trimmedProject = project.trim();
        if (trimmedProject) next.project = trimmedProject;
        else delete next.project;
      }
      if (steps) next.steps = normalizeWorkflowSteps(steps);
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
        clearTriggerSchedule: clear_trigger_schedule,
        triggerWebhookPath: trigger_webhook_path,
        clearTriggerWebhookPath: clear_trigger_webhook_path,
        triggerEvents: trigger_events,
        clearTriggerEvents: clear_trigger_events,
      });
      if (!triggerPatch.ok) return textResult(triggerPatch.error);
      if (triggerPatch.changed) next.trigger = triggerPatch.trigger;

      // Auto-repair the fixable binding gaps before persisting so an edit
      // that left a dangling {{steps.X.output}} / forEach / {{input.X}}
      // saves runnable.
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
        return textResult(
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
      if (updatePrep.status !== 'readiness_gaps' && workflowUpdateNeedsVerification(entry.data, savedNext)) {
        const updateVerification = prepareWorkflowVerification(savedNext, providedSmokeInputs);
        if (updateVerification.needsTest) {
          savedNext.enabled = false;
          writeWorkflowAndSyncTriggers(entry.name, savedNext);
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
        trigger_schedule !== undefined || clear_trigger_schedule ? 'schedule' : '',
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
      return textResult(
        `Workflow "${name}" updated. Here's what it does now:\n\n${describeWorkflowPlainEnglish(savedNext)}\n\n`
          + `${appendDataSources(savedNext)}`
          + `${updateContractReport}${updateContractReport ? '\n\n' : ''}`
          + `${updatePrep.status === 'readiness_gaps' ? `${renderReadinessHold(name)}\n\n` : ''}`
          + `${reSmoke ? `${reSmoke.message}\n\n` : ''}`
          + `${updateBindReport}${updateAdvisories}${updateGaps}`.trim(),
      );
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
      const result = applyStepPromptEdit(before.name, step_id, find, replace, { description: `workflow_edit_step ${step_id}` });
      if (!result.ok) {
        // Structured, NON-silent failure (change #4): the user AND the model see
        // the edit did not land and exactly what to do next — never a quiet no-op.
        return textResult(
          `Edit NOT applied to "${before.name}" step "${step_id}".\n${result.message}`
            + (result.errors?.length ? `\n- ${result.errors.join('\n- ')}` : ''),
        );
      }
      // Re-smoke parity with workflow_update: if the workflow is ENABLED and this
      // edit changed what it executes, re-verify by running (saved disabled,
      // auto-enables on pass) instead of trusting the edited config. Schedule/copy
      // edits that don't change execution skip the test.
      const updated = listWorkflowFiles().find((w) => w.data.name === before.name)?.data;
      let reSmokeMsg = '';
      if (updated && before.enabled && workflowExecutionSurfaceChanged(before, updated)) {
        let runTest = workflowNeedsCreationTest(updated);
        if (runTest) {
          const testInputs = workflowSmokeInputs(updated, {});
          const missingSmokeInputs = missingWorkflowRunInputs(updated, testInputs);
          writeWorkflowAndSyncTriggers(before.name, { ...updated, enabled: false });
          reSmokeMsg = missingSmokeInputs.length > 0
            ? `\n\n${renderMissingSmokeInputs(before.name, missingSmokeInputs)}`
            : `\n\n${queueWorkflowCreationTest(before.name, testInputs, { originSessionId: getToolOutputContext()?.sessionId }).message}`;
        }
      }
      addNotification({
        id: `workflow-edit-step-${before.name}-${step_id}-${Date.now()}`,
        kind: 'workflow',
        title: `Workflow step edited: ${before.name}`,
        body: `Edited step "${step_id}".`,
        createdAt: new Date().toISOString(),
        read: false,
        silent: true,
        metadata: { source: 'workflow_edit_step', workflowName: before.name, stepId: step_id },
      });
      return textResult(`${result.message}${reSmokeMsg}`);
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
    'workflow_run_status',
    'Check workflow runs. Pass run_id for one run\'s detail, OR omit it to LIST what is running right now — use the no-id form to answer "what workflows are running / how is my flow going". Lists in-flight (queued/running/parked) + needs-attention runs and the few most-recent finished ones.',
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
          const lines = [
            `Run ${run_id}`,
            `Workflow: ${record.workflow ?? '(unknown)'}`,
            `Status: ${record.status ?? '(unknown)'}${record.needsAttention ? ' · NEEDS ATTENTION' : ''}`,
            record.createdAt ? `Created: ${record.createdAt}` : '',
            record.finishedAt ? `Finished: ${record.finishedAt}` : '',
            record.inputs && Object.keys(record.inputs).length > 0 ? `Inputs: ${JSON.stringify(record.inputs)}` : '',
            record.goalOutcome ? `Pinned goal: ${record.goalOutcome}${record.goalReason ? ` — ${record.goalReason}` : ''}` : '',
            record.error ? `Error: ${record.error}` : '',
            blockedLines.length > 0 ? `Blocked steps:\n${blockedLines.join('\n')}` : '',
            failedItemLines.length > 0
              ? `Failed fan-out items:\n${failedItemLines.join('\n')}\nRetry: call workflow_rerun_failed_items with run_id="${run_id}"${new Set(failedItems.map((f) => f.stepId)).size > 1 ? ' and step_id set to one failed step' : ''}.`
              : '',
            stepLines.length > 0 ? `Step results:\n${stepLines.join('\n')}` : '',
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

  server.tool(
    'cron_progress_write',
    'Persist progress state for a cron job.',
    {
      job_name: z.string().min(1),
      completedItems: z.array(z.string()).optional(),
      pendingItems: z.array(z.string()).optional(),
      notes: z.string().optional(),
      state: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ job_name, completedItems, pendingItems, notes, state }) => {
      ensureDir(CRON_PROGRESS_DIR);
      const filePath = path.join(CRON_PROGRESS_DIR, `${safeName(job_name)}.json`);
      const current = existsSync(filePath)
        ? JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
        : {};
      const next = {
        ...current,
        jobName: job_name,
        lastRunAt: new Date().toISOString(),
        completedItems: completedItems ?? current.completedItems ?? [],
        pendingItems: pendingItems ?? current.pendingItems ?? [],
        notes: notes ?? current.notes ?? '',
        state: state ?? current.state ?? {},
      };
      writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
      return textResult(`Progress saved for "${job_name}".`);
    },
  );

}
