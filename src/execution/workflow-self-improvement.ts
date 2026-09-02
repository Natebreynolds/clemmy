/**
 * Workflow self-improvement: a saved workflow that readiness can no longer
 * run is re-authored by Clem herself before it runs — never parked on the
 * user with a "migration required" notice.
 *
 * Live 2026-09-01: four of the owner's 34 workflows still carried a raw
 * `deterministic.runner` script step, retired on 08-30 because a subprocess
 * holding the user's credentials has no exact effect authority. Readiness
 * refused them at every source (schedule, dashboard, chat) and every other
 * Clementine install with a legacy runner would hit the same wall with no
 * way through except a human rewriting YAML. The owner's rule: Clem is never
 * stopped by a gate she cannot open, and a human in the loop verifies or
 * steers but is never the mechanism.
 *
 * Shape (no new lane): the queue records a durable improvement request
 * instead of `blocked_readiness`; the daemon consumes it exactly the way it
 * runs a cron occurrence — one system session, one plan scope opened with
 * `allowedTools ['*']` (the user's own run request is the consent, the same
 * rule that makes save + enable the consent for an authored step), one host
 * turn in which Clem reads the legacy script and re-authors the step(s) with
 * her ordinary authoring tools (`workflow_get`, `read_file`, `tool_search`,
 * `workflow_update`). Code, not the model, then proves the result kept the
 * user's intent (goal, trigger, resources, approval flags, destinations),
 * validates and re-checks readiness, keeps a byte backup for revert, notifies
 * the user in plain language, and re-queues the run that asked for it.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { WORKFLOW_IMPROVEMENT_SESSION_PREFIX } from './workflow-improvement-session.js';

import { BASE_DIR } from '../config.js';
import {
  readWorkflow,
  type WorkflowDefinition,
  type WorkflowEntry,
} from '../memory/workflow-store.js';
import { draftRunnerMigration } from './workflow-runner-migration.js';
import {
  WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE,
  workflowRawSubprocessDeclarations,
} from './workflow-raw-subprocess-policy.js';
import { checkWorkflowRunReadiness, type WorkflowRunReadinessCheck } from './workflow-run-readiness.js';
import { validateWorkflowDefinition } from './workflow-validator.js';
import { writeWorkflowAndSyncTriggers } from './workflow-write.js';

const logger = pino({ name: 'clementine-next.workflow-self-improvement' });

export const WORKFLOW_IMPROVEMENT_STATE_FILE = path.join(BASE_DIR, 'state', 'workflow-improvements.json');
/** How many rewrite attempts Clem makes on one unchanged definition (and its
 * unchanged scripts) before she stops trying on her own and hands the user
 * her last draft with the reason. A counter, never a wall clock: the earlier
 * six-hour cooldown silently turned "run my slack team update" into a
 * readiness lecture for the rest of the day (live 2026-09-01). Editing the
 * workflow or a script it names resets the budget. */
export const WORKFLOW_IMPROVEMENT_ATTEMPT_BUDGET = 3;
/** Prior attempts carried on the request and quoted to the next turn. */
export const WORKFLOW_IMPROVEMENT_ATTEMPT_HISTORY = 5;
/** Bound on one improvement turn. Generous — an authoring turn reads a
 * script and writes one definition — and configurable, never a step gate. */
export const WORKFLOW_IMPROVEMENT_WALL_CLOCK_MS = Number.parseInt(
  process.env.CLEMENTINE_WORKFLOW_IMPROVEMENT_WALL_MS ?? `${15 * 60_000}`,
  10,
);

export type WorkflowImprovementStatus = 'pending' | 'running' | 'done' | 'failed';

export interface WorkflowImprovementRequest {
  slug: string;
  status: WorkflowImprovementStatus;
  requestedAt: string;
  /** Queue source that asked for the run (dashboard, schedule, chat…). */
  source: string;
  /** Machine reasons readiness gave; the prompt quotes them verbatim. */
  blockers: string[];
  /** Legacy runner declarations, so the turn knows which files to read. */
  runners: Array<{ stepId: string; kind: string; runner: string }>;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  backupPath?: string;
  detail?: string;
  /** sha256 over the definition file and every legacy script it names; the
   * attempt budget is scoped to it, so an edit resets the count. */
  definitionDigest?: string;
  /** Bounded history of attempts on this digest, oldest first. The next
   * turn's prompt quotes them so a failure is never repeated blind. */
  attempts?: WorkflowImprovementAttempt[];
}

export interface WorkflowImprovementAttempt {
  startedAt: string;
  finishedAt: string;
  /** Guard violations or the turn error, bounded, with Clem's own note. */
  detail: string;
  /** The rejected rewrite, kept beside the backup for the user to review. */
  candidatePath?: string;
}

type ImprovementStateFile = Record<string, WorkflowImprovementRequest>;

function readState(file = WORKFLOW_IMPROVEMENT_STATE_FILE): ImprovementStateFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ImprovementStateFile
      : {};
  } catch {
    return {};
  }
}

function writeState(state: ImprovementStateFile, file = WORKFLOW_IMPROVEMENT_STATE_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** The readiness blockers that self-improvement can act on: a legacy raw
 * runner step. Capability/account blockers are a different class and stay
 * with readiness. */
export function improvableReadinessBlockers(readiness: Pick<WorkflowRunReadinessCheck, 'blockers'>): string[] {
  return (readiness.blockers ?? [])
    .map((blocker) => (typeof blocker.reason === 'string' ? blocker.reason : ''))
    .filter((reason) => reason.includes(WORKFLOW_RAW_SUBPROCESS_REFUSAL_CODE));
}

export function legacyRunnerDeclarations(definition: WorkflowDefinition): WorkflowImprovementRequest['runners'] {
  return (definition.steps ?? []).flatMap((step) =>
    workflowRawSubprocessDeclarations(step as never).map((declaration) => ({
      stepId: declaration.stepId,
      kind: declaration.kind,
      runner: declaration.runner,
    })));
}

/**
 * Record an improvement request for a workflow readiness just refused. Returns
 * null when readiness refused for a reason self-improvement does not own;
 * `already_pending` when a request is pending/running (the caller's run will
 * be re-queued by that one); `exhausted` when the attempt budget for this
 * exact definition is spent — the caller then tells the user in plain words,
 * with the last draft, instead of the readiness text.
 */
export function requestWorkflowImprovement(input: {
  slug: string;
  definition: WorkflowDefinition;
  /** Optional: readiness at request time, kept on the record as evidence.
   * Since 2026-09-01 an owner-authored runner RUNS; migration is asked for
   * explicitly (chat, dashboard), never forced by a readiness refusal. */
  readiness?: Pick<WorkflowRunReadinessCheck, 'blockers'>;
  source?: string;
  now?: () => number;
  stateFile?: string;
}): { status: 'requested' | 'already_pending' | 'exhausted'; request: WorkflowImprovementRequest } | null {
  const runners = legacyRunnerDeclarations(input.definition);
  if (runners.length === 0) return null;
  const blockers = input.readiness ? improvableReadinessBlockers(input.readiness) : [];
  const now = input.now ?? Date.now;
  const state = readState(input.stateFile);
  const existing = state[input.slug];
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return { status: 'already_pending', request: existing };
  }
  const definitionDigest = workflowImprovementDefinitionDigest(input.slug, runners);
  const sameDefinition = existing?.definitionDigest === definitionDigest;
  const priorAttempts = sameDefinition ? (existing?.attempts ?? []) : [];
  if (
    existing
    && existing.status === 'failed'
    && sameDefinition
    && priorAttempts.length >= WORKFLOW_IMPROVEMENT_ATTEMPT_BUDGET
  ) {
    return { status: 'exhausted', request: existing };
  }
  const request: WorkflowImprovementRequest = {
    slug: input.slug,
    status: 'pending',
    requestedAt: new Date(now()).toISOString(),
    source: (input.source ?? 'unknown').trim() || 'unknown',
    blockers,
    runners,
    definitionDigest,
    attempts: priorAttempts,
  };
  state[input.slug] = request;
  writeState(state, input.stateFile);
  logger.info({ slug: input.slug, source: request.source, runners: runners.map((r) => r.runner) }, 'workflow self-improvement requested');
  return { status: 'requested', request };
}

/** sha256 over the definition file plus every legacy script it names. The
 * attempt budget is keyed to it: the same bytes get the same three tries; any
 * edit by the user (or by an applied rewrite) starts a fresh count. */
export function workflowImprovementDefinitionDigest(
  slug: string,
  runners: WorkflowImprovementRequest['runners'],
): string {
  const hash = createHash('sha256');
  const entry = readWorkflow(slug);
  let definitionBytes = '';
  try {
    definitionBytes = entry ? readFileSync(entry.filePath, 'utf8') : '';
  } catch {
    definitionBytes = '';
  }
  hash.update(definitionBytes);
  for (const runner of [...runners].sort((a, b) => a.runner.localeCompare(b.runner))) {
    hash.update(`\n--- ${runner.stepId}:${runner.kind}:${runner.runner}\n`);
    const source = entry ? runnerSourceSnippet(entry, runner.runner) : null;
    hash.update(source?.bytes ?? '');
  }
  return hash.digest('hex');
}

function recordFailedAttempt(
  slug: string,
  attempt: WorkflowImprovementAttempt,
  stateFile?: string,
): WorkflowImprovementRequest | null {
  const state = readState(stateFile);
  const current = state[slug];
  if (!current) return null;
  const attempts = [...(current.attempts ?? []), attempt].slice(-WORKFLOW_IMPROVEMENT_ATTEMPT_HISTORY);
  const next: WorkflowImprovementRequest = {
    ...current,
    status: 'failed',
    finishedAt: attempt.finishedAt,
    detail: attempt.detail,
    attempts,
  };
  state[slug] = next;
  writeState(state, stateFile);
  return next;
}

export function listPendingWorkflowImprovements(stateFile?: string, now: () => number = Date.now): WorkflowImprovementRequest[] {
  return Object.values(readState(stateFile))
    .filter((request) => (
      request.status === 'pending'
      // A request left `running` by a daemon that stopped mid-turn (restart,
      // crash) is not a dead end: once its wall clock has certainly elapsed
      // it is picked up again. The definition is untouched until the turn's
      // final workflow_update, and the guard/revert run again regardless.
      || (request.status === 'running'
        && typeof request.startedAt === 'string'
        && now() - Date.parse(request.startedAt) > WORKFLOW_IMPROVEMENT_WALL_CLOCK_MS + 60_000)
    ))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function readWorkflowImprovement(slug: string, stateFile?: string): WorkflowImprovementRequest | null {
  return readState(stateFile)[slug] ?? null;
}

function updateRequest(
  slug: string,
  patch: Partial<WorkflowImprovementRequest>,
  stateFile?: string,
): WorkflowImprovementRequest | null {
  const state = readState(stateFile);
  const current = state[slug];
  if (!current) return null;
  const next = { ...current, ...patch };
  state[slug] = next;
  writeState(state, stateFile);
  return next;
}

/** Human-facing one-liner the queue returns instead of a readiness refusal. */
export function workflowImprovementHoldMessage(slug: string, runners: WorkflowImprovementRequest['runners']): string {
  const steps = [...new Set(runners.map((runner) => runner.stepId))].join(', ');
  return `Workflow "${slug}" uses a legacy script step (${steps}). `
    + 'Clem is drafting exact steps to replace it; the script keeps running as-is until the draft passes its checks, and you will be notified either way.';
}

/** What the queue says once the attempt budget for this exact definition is
 * spent: the plain reason, the last draft, and the next edge — never the
 * readiness engineering text. */
export function workflowImprovementExhaustedMessage(slug: string, request: WorkflowImprovementRequest): string {
  const steps = [...new Set(request.runners.map((runner) => runner.stepId))].join(', ');
  const attempts = request.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const reason = (last?.detail ?? request.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const tries = attempts.length || WORKFLOW_IMPROVEMENT_ATTEMPT_BUDGET;
  return `Workflow "${slug}" still has a legacy script step (${steps}) that Clementine no longer runs directly. `
    + `Clem tried rewriting it ${tries} time${tries === 1 ? '' : 's'} on this exact definition and each rewrite was rejected by her own checks`
    + (reason ? ` — last time: ${reason}` : '')
    + '. '
    + (last?.candidatePath ? `Her last draft is saved at ${last.candidatePath}. ` : '')
    + 'Next: tell me what to keep or drop and I will rewrite that step with you here, or edit the step yourself; '
    + 'the run starts as soon as the definition passes its checks.';
}

// ── the prompt ───────────────────────────────────────────────────────────────

function runnerSourceSnippet(entry: WorkflowEntry, runner: string): { path: string; bytes: string } | null {
  const resolved = path.resolve(entry.dir, runner);
  if (!resolved.startsWith(path.resolve(entry.dir) + path.sep)) return null;
  if (!existsSync(resolved)) return null;
  try {
    return { path: resolved, bytes: readFileSync(resolved, 'utf8') };
  } catch {
    return null;
  }
}

/** Legacy scripts are inlined into the prompt (bounded) so the turn spends
 * zero lookups paging a result handle: live 2026-09-01 a 42 KB script read
 * through read_file + recall_tool_result was three "no-progress" lookups to
 * the governor and the turn was terminalized before authoring began. */
export const WORKFLOW_IMPROVEMENT_INLINE_SOURCE_MAX_BYTES = 96 * 1024;

export function buildWorkflowImprovementPrompt(input: {
  request: WorkflowImprovementRequest;
  entry: WorkflowEntry;
}): string {
  const { request, entry } = input;
  const sources: string[] = [];
  const inlined: string[] = [];
  let inlineBudget = WORKFLOW_IMPROVEMENT_INLINE_SOURCE_MAX_BYTES;
  for (const runner of request.runners) {
    const source = runnerSourceSnippet(entry, runner.runner);
    if (!source) {
      sources.push(`- step "${runner.stepId}" (${runner.kind}): ${runner.runner} (file not found under the workflow directory — re-author from the step's output contract and the workflow goal)`);
      continue;
    }
    const bytes = Buffer.byteLength(source.bytes, 'utf8');
    if (bytes <= inlineBudget) {
      inlineBudget -= bytes;
      sources.push(`- step "${runner.stepId}" (${runner.kind}): ${source.path} (${bytes} bytes; full source included below — do not re-read it)`);
      inlined.push(`===== BEGIN legacy script for step "${runner.stepId}": ${runner.runner} =====`, source.bytes, `===== END legacy script for step "${runner.stepId}" =====`);
    } else {
      sources.push(`- step "${runner.stepId}" (${runner.kind}): ${source.path} (${bytes} bytes; too large to inline — read it with read_file in as few calls as possible)`);
    }
  }
  // THE MIGRATION PRIMITIVE (2026-09-01): the host drafts the exact steps
  // deterministically from the runner's source — every SOQL read as a call
  // step, a package transform, a render step carrying the script's own output
  // format, the send repointed — and names the gaps. The model starts from
  // the draft and fills gaps; it no longer translates 1,100 lines by hand
  // (18 failed attempts in one day on team-activity-slack-updates).
  const drafts: string[] = [];
  for (const runner of request.runners) {
    if (runner.kind !== 'deterministic.runner') continue;
    const source = runnerSourceSnippet(entry, runner.runner);
    if (!source) continue;
    const draft = draftRunnerMigration({
      definition: entry.data,
      runnerStepId: runner.stepId,
      runnerSource: source.bytes,
    });
    if (!draft.ok) continue;
    const rendered = JSON.stringify({ inputs: draft.definition.inputs ?? {}, steps: draft.definition.steps }, null, 1);
    const bytes = Buffer.byteLength(rendered, 'utf8');
    if (bytes > inlineBudget) continue;
    inlineBudget -= bytes;
    drafts.push(
      `===== BEGIN host draft for step "${runner.stepId}" (extracted from the script; start from this) =====`,
      rendered,
      ...(draft.gaps.length > 0 ? ['Gaps the draft could not express (decide each, then say what you did in the final note):', ...draft.gaps.map((gap) => `- ${gap}`)] : []),
      ...(draft.reads.some((read) => read.unresolved.length > 0)
        ? ['Declared inputs to fill with the literal the query needs: ' + draft.reads.flatMap((read) => read.unresolved).map((name) => `\`${name}\``).join(', ')]
        : []),
      `===== END host draft for step "${runner.stepId}" =====`,
    );
  }
  // The current definition rides in the prompt as well: with definition and
  // script both present the turn's first call can be authoring, not lookup.
  let definitionBytes = '';
  try {
    definitionBytes = readFileSync(entry.filePath, 'utf8');
  } catch {
    definitionBytes = '';
  }
  const definitionInlined = definitionBytes.length > 0 && Buffer.byteLength(definitionBytes, 'utf8') <= inlineBudget;
  if (definitionInlined) {
    inlined.unshift(`===== BEGIN current definition: ${entry.filePath} =====`, definitionBytes, '===== END current definition =====');
  }
  return [
    `Workflow self-improvement: "${request.slug}" (definition file: ${entry.filePath}).`,
    '',
    'This saved workflow was asked to run but its readiness check refused it:',
    ...request.blockers.map((blocker) => `- ${blocker}`),
    ...(request.attempts?.length
      ? [
          '',
          `Previous attempts on this exact definition (${request.attempts.length} of ${WORKFLOW_IMPROVEMENT_ATTEMPT_BUDGET}) were rejected by the code guard; do not repeat them:`,
          ...request.attempts.slice(-3).map((attempt, index) =>
            `${index + 1}. ${attempt.detail.replace(/\s+/g, ' ').trim().slice(0, 600)}`),
        ]
      : []),
    '',
    'Legacy script steps to re-author:',
    ...sources,
    '',
    'Binding rules:',
    '1. Preserve WHAT the workflow does and where it sends: its name, goal and success criteria, trigger/schedule/timezone, resources, enabled flag, every step\'s requiresApproval flag, and every destination (channel ids, recipients, spreadsheet ids). You may only change HOW a step does its work.',
    ...(drafts.length > 0
      ? ['0. A host draft of the exact steps is included at the end of this message. Start from it: keep its call steps and package transform as they are, resolve each listed gap and declared input, review the render prompt, then save. Do not re-derive what the draft already extracted.']
      : []),
    definitionInlined
      ? '2. The current definition and the legacy script source are both included at the end of this message. Do not spend calls on workflow_get or read_file for them; start with the rewrite.'
      : '2. First read the current definition with workflow_get (section "full", one call). The legacy script source you need is included at the end of this message; do not spend calls re-reading it.',
    '3. Re-author each legacy script step as exact `call` steps for the external reads/writes the script performed — one call step per provider operation, with the exact operation name (use tool_search to find the exact reviewed CLI read or provider action; do not invent names) and the literal arguments the script used — plus a `transform` step or a short prose step for the pure computation/rendering the script did. If tool_search answers a role with the same nearest operation twice, the catalog has no closer match: stop searching for it, re-author without that operation (or with the nearest one when it serves the same purpose), and say so in the final note. Keep the same output contract (required_keys / non_empty) that downstream steps consume; if the old step produced several fields, the last new step must produce all of them.',
    '4. Save the improved definition with ONE workflow_update call carrying the COMPLETE steps array (it replaces the whole graph). It is a reversible local write: call it directly (via work_call with the exact capabilityRef tool_search returns, when it is not on your tool list). Do not call plan_task, and do not run or plan the workflow\'s own reads/sends in this session — the runner executes those on the next scheduled run. Do not disable the workflow. Do not change its name.',
    '5. End with a 3–6 line plain-language note for the user: which step changed, what it does now, and anything they should glance at.',
    '6. Do not ask the user questions and do not stop at a proposal — nobody is in this session. Where the script did something exact steps cannot express (runtime-built queries, a local state file, a delta against a previous run), choose the option that preserves the MOST of the original behavior, drop only what cannot be expressed, and say exactly what was dropped in the final note; the user can steer from that note afterwards.',
    '',
    'Step shapes the runner executes (no other step kinds; do not search for documentation):',
    '- exact provider read/write:  { id, prompt: "", side_effect: read|write|send, call: { tool: <exact operation name from tool_search>, args: { ...literal arguments } }, output: { type: object, required_keys: [stdout], non_empty: [stdout] } }',
    '- pure computation/rendering: { id, prompt: "<what to compute from the named prior steps, and the exact JSON object to return>", dependsOn: [<step ids>], side_effect: read, output: { type: object, required_keys: [...], non_empty: [...] } }',
    '- reviewed in-process transform (pure data shaping; no model, no tools, no approval): { id, side_effect: read, dependsOn: [<step ids>], transform: <expression> } where an expression is one of { op: "get", from: "steps.<id>.output[.<path>]" | "input.<key>" | "item[.<path>]" }, { op: "jsonParse" | "jsonStringify" | "count", value: <expression> }, { op: "literal", value: <json> }, { op: "object", fields: [{ key, value: <expression> }] }, { op: "array", items: [<expression>] }, { op: "map", value: <expression>, each: <expression over item> }, { op: "select", value: <rows>, where?: { column, op: eq|ne|contains|empty|nonempty, value? }, columns?: [..], limit? }, { op: "aggregate", value: <rows>, groupBy: [..], metrics?: [{ fn: count|sum|avg|min|max, column? }] }. A reviewed CLI read returns its JSON as the step output\'s `stdout` string: parse it with { op: "jsonParse", value: { op: "get", from: "steps.<id>.output.stdout" } } and take the records with a further { op: "get" } on that transform step\'s own output.',
    '- one exact read per item of a prior step\'s array (reads only; a per-item write is not a step shape): { id, forEach: "steps.<id>.output.<path-to-array>", prompt: "", side_effect: read, call: { tool: <exact read>, args: { ...literals and "{{item.<field>}}" templates } } }',
    '- the existing send step stays as it is (same allowedTools, same destination, same output contract).',
    ...(drafts.length > 0 ? ['', ...drafts] : []),
    ...(inlined.length > 0 ? ['', ...inlined] : []),
  ].join('\n');
}

// ── the intent guard (code, not the model) ──────────────────────────────────

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  ));
}

const DESTINATION_LITERAL = /\b(?:[CDG][A-Z0-9]{8,11}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_-]{30,})\b/g;

function destinationLiterals(steps: WorkflowDefinition['steps']): Set<string> {
  const literals = new Set<string>();
  for (const step of steps ?? []) {
    const record = step as unknown as Record<string, unknown>;
    if (record.sideEffect !== 'send' && record.side_effect !== 'send') continue;
    const text = JSON.stringify(record);
    for (const match of text.match(DESTINATION_LITERAL) ?? []) literals.add(match);
  }
  return literals;
}

export interface ImprovementIntentGuardResult {
  ok: boolean;
  violations: string[];
}

/** The improved definition must keep the user's intent byte-for-byte on the
 * fields that ARE the intent, carry no legacy runner, validate, and be ready. */
export function guardImprovedWorkflowDefinition(input: {
  before: WorkflowDefinition;
  after: WorkflowDefinition;
  slug: string;
}): ImprovementIntentGuardResult {
  const { before, after } = input;
  const violations: string[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  if (after.name !== before.name) violations.push('name changed');
  if ((after.enabled !== false) !== (before.enabled !== false)) violations.push('enabled flag changed');
  for (const key of ['goal', 'trigger', 'resources', 'inputs'] as const) {
    if (b[key] !== undefined && stable(a[key]) !== stable(b[key])) violations.push(`${key} changed`);
  }
  const approvalBefore = new Map((before.steps ?? []).map((step) => [step.id, step.requiresApproval === true]));
  for (const step of after.steps ?? []) {
    const prior = approvalBefore.get(step.id);
    if (prior === true && step.requiresApproval !== true) violations.push(`step "${step.id}" lost requiresApproval`);
  }
  const beforeDestinations = destinationLiterals(before.steps);
  const afterText = JSON.stringify(after.steps ?? []);
  for (const literal of beforeDestinations) {
    if (!afterText.includes(literal)) violations.push(`send destination "${literal}" no longer present`);
  }
  const remainingRunners = legacyRunnerDeclarations(after);
  if (remainingRunners.length > 0) {
    violations.push(`legacy runner still declared: ${remainingRunners.map((r) => `${r.stepId}:${r.runner}`).join(', ')}`);
  }
  const validation = validateWorkflowDefinition(after as never);
  if (!validation.ok) violations.push(...validation.errors.map((error) => `invalid: ${error}`));
  if (violations.length === 0) {
    const readiness = checkWorkflowRunReadiness(after, input.slug);
    if (!readiness.ok) violations.push(`still not ready: ${readiness.message}`);
  }
  return { ok: violations.length === 0, violations };
}

// ── backup / revert ──────────────────────────────────────────────────────────

export function backupWorkflowDefinitionFile(entry: WorkflowEntry, now: () => number = Date.now): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(entry.dir, `.improvement-backup-${stamp}.md`);
  copyFileSync(entry.filePath, backupPath);
  return backupPath;
}

/** The rewrite the guard rejected, kept as a sibling file; undefined when the
 * definition is byte-identical to the backup (nothing was written). */
function keepRejectedCandidate(entry: WorkflowEntry, backupPath: string, now: () => number): string | undefined {
  try {
    const current = readFileSync(entry.filePath, 'utf8');
    if (current === readFileSync(backupPath, 'utf8')) return undefined;
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const candidatePath = path.join(entry.dir, `.improvement-candidate-${stamp}.md`);
    writeFileSync(candidatePath, current, 'utf8');
    return candidatePath;
  } catch {
    return undefined;
  }
}

export function revertWorkflowDefinitionFile(entry: WorkflowEntry, backupPath: string): void {
  copyFileSync(backupPath, entry.filePath);
  const restored = readWorkflow(entry.name);
  if (restored) writeWorkflowAndSyncTriggers(entry.name, restored.data);
}

// ── the turn ─────────────────────────────────────────────────────────────────

export interface WorkflowImprovementTurnRequest {
  sessionId: string;
  runId: string;
  channel: string;
  message: string;
  model?: string;
  maxWallClockMs: number;
}

export interface WorkflowImprovementOutcome {
  slug: string;
  status: 'done' | 'failed';
  summary: string;
  backupPath?: string;
  /** The rejected rewrite, when the turn wrote one. */
  candidatePath?: string;
  violations?: string[];
}

/**
 * Run one pending improvement end to end. `executeTurn` is the daemon's
 * system-turn executor (the same bridge cron uses); `openScope`/`closeScope`
 * are the plan-scope doors. Everything else is code: backup, guard, revert,
 * durable status. The caller notifies and re-queues from the outcome.
 */
export async function runWorkflowImprovement(input: {
  request: WorkflowImprovementRequest;
  executeTurn: (request: WorkflowImprovementTurnRequest) => Promise<{ text: string }>;
  openScope: (input: { sessionId: string; planProposalId: string; approvedPlanObjective: string }) => void;
  closeScope: (sessionId: string, reason: string) => void;
  model?: string;
  now?: () => number;
  stateFile?: string;
}): Promise<WorkflowImprovementOutcome> {
  const { request } = input;
  const now = input.now ?? Date.now;
  const entry = readWorkflow(request.slug);
  if (!entry) {
    updateRequest(request.slug, { status: 'failed', finishedAt: new Date(now()).toISOString(), detail: 'workflow missing' }, input.stateFile);
    return { slug: request.slug, status: 'failed', summary: `Workflow "${request.slug}" no longer exists.` };
  }
  const sessionId = `${WORKFLOW_IMPROVEMENT_SESSION_PREFIX}${request.slug}:${now()}`;
  const backupPath = backupWorkflowDefinitionFile(entry, now);
  const startedAt = new Date(now()).toISOString();
  updateRequest(request.slug, {
    status: 'running',
    startedAt,
    sessionId,
    backupPath,
  }, input.stateFile);
  const before = entry.data;
  let text = '';
  try {
    input.openScope({
      sessionId,
      planProposalId: `workflow-improvement:${request.slug}`,
      approvedPlanObjective: `Re-author legacy script step(s) of workflow "${request.slug}" so it can run`,
    });
    const response = await input.executeTurn({
      sessionId,
      runId: `workflow-improvement:v1:${request.slug}:${now()}`,
      channel: 'cron',
      message: buildWorkflowImprovementPrompt({ request, entry }),
      ...(input.model ? { model: input.model } : {}),
      maxWallClockMs: WORKFLOW_IMPROVEMENT_WALL_CLOCK_MS,
    });
    text = response.text ?? '';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    revertWorkflowDefinitionFile(entry, backupPath);
    recordFailedAttempt(request.slug, {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      detail: `the rewrite turn failed: ${detail}`.slice(0, 1_200),
    }, input.stateFile);
    logger.warn({ slug: request.slug, err: detail }, 'workflow self-improvement turn failed; definition reverted');
    return { slug: request.slug, status: 'failed', backupPath, summary: `The rewrite turn failed (${detail}); the original definition is unchanged.` };
  } finally {
    try { input.closeScope(sessionId, 'workflow-improvement-finished'); } catch { /* best effort */ }
  }
  const improved = readWorkflow(request.slug);
  if (!improved) {
    updateRequest(request.slug, { status: 'failed', finishedAt: new Date(now()).toISOString(), detail: 'definition missing after turn' }, input.stateFile);
    return { slug: request.slug, status: 'failed', backupPath, summary: 'The definition disappeared during the rewrite; restore it from the backup.' };
  }
  const guard = guardImprovedWorkflowDefinition({ before, after: improved.data, slug: request.slug });
  if (!guard.ok) {
    // Keep what the turn actually wrote (if anything) beside the backup, so
    // the user can read the draft and the next attempt is told what failed.
    // Live 2026-09-01: sixteen attempts whose "drift" was really "no
    // workflow_update ever happened" — the byte-identical file made that
    // invisible.
    const candidatePath = keepRejectedCandidate(entry, backupPath, now);
    revertWorkflowDefinitionFile(entry, backupPath);
    const detail = candidatePath
      ? guard.violations.join('; ')
      : `no rewrite was saved (the turn ended without a workflow_update); ${guard.violations.join('; ')}`;
    const modelNote = text.trim().slice(0, 1_200);
    recordFailedAttempt(request.slug, {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      detail: (modelNote ? `${detail}\n\nClem's note: ${modelNote}` : detail).slice(0, 2_400),
      ...(candidatePath ? { candidatePath } : {}),
    }, input.stateFile);
    logger.warn({ slug: request.slug, violations: guard.violations, candidatePath }, 'workflow self-improvement rejected by the intent guard; definition reverted');
    return {
      slug: request.slug,
      status: 'failed',
      backupPath,
      ...(candidatePath ? { candidatePath } : {}),
      violations: guard.violations,
      // The model's own closing note (often the exact fork it could not
      // resolve) rides with the failure so the user can steer from it.
      summary: `The rewrite did not keep the workflow's intent or is still not runnable (${detail}); the original definition was restored.`
        + (candidatePath ? ` Her draft is kept at ${candidatePath}.` : '')
        + (modelNote ? `\n\nClem's note: ${modelNote}` : ''),
    };
  }
  updateRequest(request.slug, {
    status: 'done',
    finishedAt: new Date(now()).toISOString(),
    detail: text.slice(0, 2000),
  }, input.stateFile);
  logger.info({ slug: request.slug, backupPath }, 'workflow self-improvement applied');
  return { slug: request.slug, status: 'done', backupPath, summary: text.trim() || 'Rewrote the legacy step into exact steps.' };
}
