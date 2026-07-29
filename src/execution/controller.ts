import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ClementineAssistant } from '../assistant/core.js';
import { MODELS } from '../config.js';
import { refreshSessionBrief } from '../memory/session-briefs.js';
import { SessionStore } from '../memory/session-store.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { refreshWorkingMemory } from '../memory/working-memory.js';
import { addNotification, getNotification } from '../runtime/notifications.js';
import { actionBus } from '../runtime/action-bus.js';
import { classifyCodexAuthError, isCodexAuthDead } from '../runtime/auth-store.js';
import { PlanStore } from '../planning/plan-store.js';
import {
  DELEGATIONS_DIR,
  TASKS_FILE,
  WORKFLOW_RUNS_DIR,
  ensureDir,
  ensureTasksFile,
  loadTeamAgents,
  nextTaskId,
  parseTasks,
} from '../tools/shared.js';
import type { ExecutionRecord, PlanRecord, PlanStep, RunRequest } from '../types.js';
import { ExecutionStore } from './store.js';
import { isUserFacingExecution } from './scope.js';
import { validateGoal, type GoalValidationResult } from './goal-validate.js';
import type { ObjectiveJudgeFn } from '../runtime/harness/objective-judge.js';
import { normalizeWorkflowRunInputs } from './workflow-inputs.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';
import { recentExecutionToolEvidence } from './completion-evidence.js';
import { isValidDelegationId } from '../agents/agent-delegations.js';
import {
  objectiveRequiresFreshExternalWrite,
  objectiveRequiresMutatingEvidence,
  type FreshExternalWriteEvidenceStatus,
} from '../runtime/harness/tool-evidence.js';

const logger = pino({ name: 'clementine-next.execution-controller' });

let executionCompletionJudgeForTests: ObjectiveJudgeFn | null = null;
export function _setExecutionCompletionJudgeForTests(fn: ObjectiveJudgeFn | null): void {
  executionCompletionJudgeForTests = fn;
}

interface WorkflowSummary {
  name: string;
  enabled: boolean;
}

interface ControllerAction {
  type: 'create_task' | 'queue_workflow' | 'delegate' | 'update_execution' | 'notify_user' | 'mark_blocked' | 'mark_completed' | 'noop';
  description?: string;
  priority?: 'high' | 'medium' | 'low';
  dueDate?: string;
  workflow?: string;
  inputs?: Record<string, string>;
  toAgent?: string;
  task?: string;
  expectedOutput?: string;
  nextStep?: string;
  summary?: string;
  blocker?: string;
  title?: string;
  body?: string;
  successCriteria?: string;
  reason?: string;
}

interface ControllerDecision {
  summary: string;
  nextReviewMinutes?: number;
  actions: ControllerAction[];
}

interface SynthesisDecision {
  summary: string;
  nextStep?: string;
  status?: 'active' | 'blocked' | 'completed';
  blocker?: string;
  notifyUser?: boolean;
  notificationTitle?: string;
  notificationBody?: string;
  nextReviewMinutes?: number;
}

interface DelegationRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  resultEvidence?: 'model_prose';
  completedBy?: string;
  onBehalfOf?: string;
  createdAt: string;
  updatedAt: string;
}

type ExecutionActivityRecord = NonNullable<ExecutionRecord['activity']>[number];

function plusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function clean(value: string, maxChars = 300): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function buildExecutionNotificationMetadata(execution: ExecutionRecord): Record<string, unknown> {
  return {
    executionId: execution.id,
    sessionId: execution.sessionId,
    discordUserId: execution.channel?.startsWith('discord:') ? execution.userId : undefined,
  };
}

function executionCompletionObjective(execution: ExecutionRecord, plan?: PlanRecord): string {
  return [
    `Execution title: ${execution.title}`,
    `Objective: ${execution.objective}`,
    execution.successCriteria ? `Declared success criteria: ${execution.successCriteria}` : '',
    plan && plan.steps.length > 0
      ? [
          'Plan:',
          ...plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.text}${step.verify ? ` — verify: ${step.verify}` : ''}`),
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

function executionCompletionEvidence(execution: ExecutionRecord, summary: string): string {
  const taskBindings = (execution.taskBindings ?? [])
    .map((binding) => `- task ${binding.taskId}: ${binding.status}${binding.description ? ` — ${binding.description}` : ''}`)
    .join('\n') || 'none';
  const workflowBindings = (execution.workflowBindings ?? [])
    .map((binding) => `- workflow ${binding.workflow} (${binding.runId}): ${binding.status}`)
    .join('\n') || 'none';
  const delegationBindings = (execution.delegationBindings ?? [])
    .map((binding) => `- delegation ${binding.delegationId} to ${binding.toAgent}: ${binding.status}${binding.result ? ` — ${binding.result}` : ''}`)
    .join('\n') || 'none';
  const recentActivity = [...(execution.activity ?? [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-10)
    .map((item) => `- ${item.type}: ${item.message}`)
    .join('\n') || 'none';
  const toolEvidence = recentExecutionToolEvidence(execution);

  return [
    `Controller completion summary: ${summary}`,
    execution.lastAssistantSummary ? `Previous summary: ${execution.lastAssistantSummary}` : '',
    execution.nextStep ? `Previous next step: ${execution.nextStep}` : '',
    `Task bindings:\n${taskBindings}`,
    `Workflow bindings:\n${workflowBindings}`,
    `Delegation bindings:\n${delegationBindings}`,
    `Recent execution activity:\n${recentActivity}`,
    toolEvidence ? `Verified tool receipts from this execution:\n${toolEvidence}` : '',
  ].filter(Boolean).join('\n');
}

async function validateExecutionCompletion(
  execution: ExecutionRecord,
  plan: PlanRecord | undefined,
  summary: string,
): Promise<GoalValidationResult> {
  return validateGoal({
    objective: executionCompletionObjective(execution, plan),
    successCriteria: execution.successCriteria ? [execution.successCriteria] : [],
    evidenceText: executionCompletionEvidence(execution, summary),
  }, {
    ...(executionCompletionJudgeForTests ? { judge: executionCompletionJudgeForTests } : {}),
  });
}

function delegationCriterionIsCognitive(
  task: string,
  expectedOutput: string,
  result: string | undefined,
  step?: PlanStep,
): boolean {
  if (!result?.trim()) return false;
  const criterion = [
    task,
    expectedOutput,
    step?.text ?? '',
    step?.verify ?? '',
  ].filter(Boolean).join('\n');
  return !objectiveRequiresMutatingEvidence(criterion)
    && !objectiveRequiresFreshExternalWrite(criterion);
}

type ExternalActionRequirement =
  | 'email:send'
  | 'email:reply'
  | 'email:forward'
  | 'message:send'
  | 'call:outbound'
  | 'calendar:write'
  | 'social:publish'
  | 'sheet:write'
  | 'crm:write'
  | 'notion:write'
  | 'code-host:write'
  | 'deploy'
  | 'dispatch:send';

function requiredExternalActionRequirements(text: string): ExternalActionRequirement[] {
  const normalized = text.toLowerCase();
  const requirements = new Set<ExternalActionRequirement>();
  if (/\b(?:email|e-mail|gmail|outlook|mail)\b/.test(normalized)) {
    if (/\bforward\b/.test(normalized)) requirements.add('email:forward');
    else if (/\breply|respond\b/.test(normalized)) requirements.add('email:reply');
    else requirements.add('email:send');
  }
  if (/\b(?:slack|teams|sms|dm)\b/.test(normalized)) requirements.add('message:send');
  if (/\bcall\b/.test(normalized)) requirements.add('call:outbound');
  if (/\b(?:calendar|appointment|meeting|event)\b/.test(normalized)) requirements.add('calendar:write');
  if (/\b(?:publish|social|tweet|post)\b/.test(normalized)) requirements.add('social:publish');
  if (/\b(?:sheet|spreadsheet|excel|airtable)\b/.test(normalized)) requirements.add('sheet:write');
  if (/\b(?:salesforce|crm)\b/.test(normalized)) requirements.add('crm:write');
  if (/\bnotion\b/.test(normalized)) requirements.add('notion:write');
  if (/\b(?:github|gitlab|pull request|\\bpr\\b|issue|repository|repo)\b/.test(normalized)) {
    requirements.add('code-host:write');
  }
  if (/\b(?:deploy|deployment|netlify|vercel|railway)\b/.test(normalized)) requirements.add('deploy');
  const hasDispatchRequirement = [...requirements].some((requirement) =>
    requirement.startsWith('email:')
    || requirement === 'message:send'
    || requirement === 'call:outbound'
  );
  if (
    !hasDispatchRequirement
    && /\b(?:send|forward|message|notify|invite)\b/.test(normalized)
  ) {
    requirements.add('dispatch:send');
  }
  return [...requirements];
}

function externalActionKeyMatches(
  requirement: ExternalActionRequirement,
  actionKey: string,
): boolean {
  const key = actionKey.toLowerCase();
  switch (requirement) {
    case 'email:send': return key === 'email:send' || key === 'email:send_draft';
    case 'email:reply': return key === 'email:reply';
    case 'email:forward': return key === 'email:forward';
    case 'message:send': return key === 'message:send';
    case 'call:outbound': return key === 'call:outbound';
    case 'calendar:write': return /^(?:calendar|meeting):/.test(key);
    case 'social:publish': return key === 'social:publish';
    case 'sheet:write': return /(?:sheet|spreadsheet|excel|airtable)/.test(key);
    case 'crm:write': return /\b(?:salesforce|crm)\b/.test(key);
    case 'notion:write': return /\bnotion\b/.test(key);
    case 'code-host:write': return /\b(?:github|gitlab|pull|repo|issue)\b/.test(key);
    case 'deploy': return /\b(?:deploy|deployment|netlify|vercel|railway|publish)\b/.test(key);
    case 'dispatch:send':
      return /^(?:email:(?:send|send_draft|reply|forward)|message:send|invite:send|call:outbound)$/.test(key);
  }
}

function externalRequirementsSatisfied(
  requirements: ExternalActionRequirement[],
  confirmedActionKeys: string[],
): boolean {
  return requirements.length > 0
    && requirements.every((requirement) =>
      confirmedActionKeys.some((actionKey) => externalActionKeyMatches(requirement, actionKey))
    );
}

/**
 * Deterministic completion boundary shared by synthesis and direct controller
 * actions. A model judge may assess fuzzy objective quality, but it cannot
 * overrule unfinished plan state or treat a delegate's own prose as
 * independent verification.
 */
function deterministicCompletionPrecheck(
  execution: ExecutionRecord,
  plan?: PlanRecord,
  externalWriteStatus: FreshExternalWriteEvidenceStatus = 'missing',
  confirmedExternalActionKeys: string[] = [],
): GoalValidationResult | null {
  const perCriterion: NonNullable<GoalValidationResult['perCriterion']> = [];
  const objectiveText = [execution.objective, execution.successCriteria ?? ''].filter(Boolean).join('\n');
  const requiresExternalWrite = objectiveRequiresFreshExternalWrite(objectiveText);
  const objectiveExternalRequirements = requiredExternalActionRequirements(objectiveText);
  const toolEvidence = recentExecutionToolEvidence(execution);

  for (const step of plan?.steps ?? []) {
    perCriterion.push({
      criterion: step.verify || step.text,
      pass: step.status === 'done',
      method: 'deterministic',
      detail: `plan step is ${step.status}`,
    });
  }

  if (requiresExternalWrite) {
    const correlated = externalWriteStatus === 'confirmed'
      && externalRequirementsSatisfied(objectiveExternalRequirements, confirmedExternalActionKeys);
    perCriterion.push({
      criterion: 'Fresh external-write receipt for this execution',
      pass: correlated,
      method: 'deterministic',
      detail: correlated
        ? `fresh external action coverage confirmed: ${objectiveExternalRequirements.join(', ')}`
        : externalWriteStatus === 'confirmed'
          ? `confirmed writes do not cover required action families: ${objectiveExternalRequirements.join(', ') || 'unclassified external action'}`
        : `fresh external-write evidence is ${externalWriteStatus}`,
    });
  }

  for (const binding of execution.delegationBindings ?? []) {
    const boundStep = binding.planStepId
      ? plan?.steps.find((step) => step.id === binding.planStepId)
      : undefined;
    const cognitiveDeliverable = delegationCriterionIsCognitive(
      binding.task,
      binding.expectedOutput,
      binding.result,
      boundStep,
    );
    const bindingCriterion = [
      binding.task,
      binding.expectedOutput,
      boundStep?.text ?? '',
      boundStep?.verify ?? '',
    ].filter(Boolean).join('\n');
    const bindingExternalRequirements = requiredExternalActionRequirements(bindingCriterion);
    const correlatedExternalEvidence = externalWriteStatus === 'confirmed'
      && externalRequirementsSatisfied(bindingExternalRequirements, confirmedExternalActionKeys);
    const explicitlyLinkedToolEvidence = toolEvidence.includes(binding.delegationId);
    const independentlyGrounded = cognitiveDeliverable
      || (objectiveRequiresFreshExternalWrite(bindingCriterion)
        ? correlatedExternalEvidence
        : objectiveRequiresMutatingEvidence(bindingCriterion)
          ? explicitlyLinkedToolEvidence
          : true);
    const verified = binding.status === 'completed'
      && (
        (binding.resultEvidence !== undefined && binding.resultEvidence !== 'model_prose')
        || independentlyGrounded
      );
    perCriterion.push({
      criterion: `Verify delegation ${binding.delegationId} from ${binding.toAgent}`,
      pass: verified,
      method: 'deterministic',
      detail: binding.status !== 'completed'
        ? `delegation is ${binding.status}`
        : cognitiveDeliverable
          ? 'reported prose is itself the non-mutating cognitive deliverable; objective acceptance is still judged'
          : correlatedExternalEvidence
            ? `reported world effect is covered by matching external action evidence: ${bindingExternalRequirements.join(', ')}`
            : explicitlyLinkedToolEvidence
              ? 'reported mutation has a tool receipt explicitly linked by delegation id'
              : binding.resultEvidence === 'model_prose' || !binding.resultEvidence
                ? 'delegation result is reported model prose; unrelated execution-wide evidence does not verify it'
                : `delegation evidence is ${binding.resultEvidence}`,
    });
  }

  const failed = perCriterion.filter((criterion) => !criterion.pass);
  if (failed.length === 0) return null;
  const criteriaMet = perCriterion.length - failed.length;
  return {
    pass: false,
    advice: failed.some((criterion) => /external-write/i.test(criterion.criterion))
      ? 'produce and verify the fresh external write required by this execution before closing it'
      : failed.some((criterion) => /delegation/i.test(criterion.criterion))
        ? 'verify the reported delegation result and finish any remaining work before closing the execution'
      : `complete or verify the remaining plan step${failed.length === 1 ? '' : 's'} before closing the execution`,
    perCriterion,
    successRatePercent: Math.round((criteriaMet / Math.max(1, perCriterion.length)) * 100),
    criteriaMet,
    criteriaTotal: perCriterion.length,
  };
}

function rejectExecutionCompletion(
  store: ExecutionStore,
  execution: ExecutionRecord,
  summary: string,
  validation: GoalValidationResult,
  source: 'controller' | 'synthesis',
): ExecutionRecord {
  const advice = clean(validation.advice ?? 'completion evidence did not satisfy the execution objective', 360);
  const message = validation.judgeFailedOpen
    ? `Completion not accepted: the completion judge was unavailable, so this execution remains active. ${advice}`
    : `Completion not accepted: ${advice}`;
  let updatedExecution = store.update(execution.id, {
    status: 'active',
    blocker: undefined,
    lastAssistantSummary: clean(`${summary} | ${message}`, 400),
    nextStep: clean(`Address completion gap: ${advice}`, 220),
    nextReviewAt: plusMinutes(validation.judgeFailedOpen ? 30 : 10),
    lastControllerRunAt: new Date().toISOString(),
  }) ?? execution;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `completion-gate:${source}:${Date.now()}:${randomBytes(3).toString('hex')}`,
    type: 'status',
    message: clean(message, 500),
    metadata: {
      source,
      judgeFailedOpen: validation.judgeFailedOpen ?? false,
      successRatePercent: validation.successRatePercent,
      criteriaMet: validation.criteriaMet,
      criteriaTotal: validation.criteriaTotal,
      failedDirectives: validation.failedDirectives,
    },
  });
  return updatedExecution;
}

function delegationFilePath(toAgent: string, id: string): string | null {
  if (!isValidDelegationId(toAgent) || !isValidDelegationId(id)) return null;
  const root = path.resolve(DELEGATIONS_DIR);
  const queue = path.resolve(root, toAgent);
  if (path.dirname(queue) !== root) return null;
  const candidate = path.resolve(queue, `${id}.json`);
  return path.dirname(candidate) === queue ? candidate : null;
}

function refreshExecutionContinuity(sessionId: string): void {
  const session = new SessionStore().get(sessionId);
  if (session.turns.length === 0) return;
  refreshSessionBrief(session);
  refreshWorkingMemory(session);
}

function appendExecutionActivity(
  store: ExecutionStore,
  execution: ExecutionRecord,
  input: {
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  },
): ExecutionRecord {
  return store.addActivity({
    executionId: execution.id,
    key: input.key,
    type: input.type,
    message: input.message,
    metadata: input.metadata,
  }) ?? execution;
}

function loadWorkflowSummaries(): WorkflowSummary[] {
  return listWorkflows()
    .map((entry) => ({
      name: entry.data.name,
      enabled: entry.data.enabled !== false,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readDelegationById(id: string): DelegationRecord | null {
  if (!isValidDelegationId(id) || !existsSync(DELEGATIONS_DIR)) return null;
  for (const slug of readdirSync(DELEGATIONS_DIR)) {
    const filePath = delegationFilePath(slug, id);
    if (!filePath || !existsSync(filePath)) continue;
    try {
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as DelegationRecord;
      if (record.id !== id || record.toAgent !== slug) continue;
      return record;
    } catch {
      continue;
    }
  }
  return null;
}

function loadWorkflowRunStatus(runId: string): 'queued' | 'running' | 'completed' | 'error' {
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) return 'error';
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { status?: string };
    if (parsed.status === 'finalizing') return 'running';
    return parsed.status === 'running' || parsed.status === 'completed' || parsed.status === 'error' ? parsed.status : 'queued';
  } catch {
    return 'error';
  }
}

function readWorkflowRunRecord(runId: string): Record<string, unknown> | null {
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Walks the response text yielding parse candidates in cooperative
// order: fenced code block, then trimmed whole text, then each
// balanced top-level `{...}` block found by depth-tracking with
// string/escape awareness. The old "first { to last }" span heuristic
// failed on responses that contained more than one brace pair
// (e.g. "I'll respond with {foo: 1} — here's my answer: { ... }").
function* iterateJsonCandidates(text: string): Generator<string> {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) yield fenceMatch[1].trim();
  const trimmed = text.trim();
  if (trimmed) yield trimmed;
  yield* iterateBalancedObjects(text);
}

function* iterateBalancedObjects(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue; }
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let consumed = start;
    for (; consumed < text.length; consumed++) {
      const ch = text[consumed];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(start, consumed + 1);
          break;
        }
      }
    }
    if (depth !== 0) return; // unbalanced tail — no further candidates worth scanning
    i = consumed + 1;
  }
}

// Strict JSON.parse first, then a tolerant retry on a cleaned copy.
// Cleanups address the three failure modes observed across model
// outputs on the Codex backend: stray // comments on their own line,
// smart/curly quotes around keys or strings, and trailing commas
// before close-brace/bracket. None of these are valid JSON, but the
// model emits them often enough that recovering is cheaper than a
// second round-trip.
function relaxedJsonParse(candidate: string): unknown {
  try { return JSON.parse(candidate); } catch {}
  const cleaned = candidate
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch { return null; }
}

const JSON_RETRY_INSTRUCTION =
  '\n\nYour previous response could not be parsed as JSON. Reply with a single JSON object only — no prose, no markdown fences, no comments, no trailing commas.';

// Runs the model once, parses, and on failure re-runs with a sterner
// reminder appended before parsing again. On final failure logs a
// truncated sample of both raw responses so we can actually see what
// the model returned. Previously we logged only the executionId and
// the "unparsable output" message — diagnosing root cause required
// reproducing the exact prompt by hand.
async function runDecisionWithRetry<T>(
  assistant: ClementineAssistant,
  request: RunRequest,
  parser: (text: string) => T | null,
  logContext: Record<string, unknown>,
): Promise<T | null> {
  const first = await assistant.getRuntime().run(request);
  const parsedFirst = parser(first.text);
  if (parsedFirst) return parsedFirst;

  const retryRequest: RunRequest = {
    ...request,
    prompt: `${request.prompt}${JSON_RETRY_INSTRUCTION}`,
  };
  const second = await assistant.getRuntime().run(retryRequest);
  const parsedSecond = parser(second.text);
  if (parsedSecond) {
    logger.info({ ...logContext, rawSample: first.text.slice(0, 800) }, 'Decision parser recovered on retry');
    return parsedSecond;
  }

  logger.warn({
    ...logContext,
    rawSampleFirst: first.text.slice(0, 800),
    rawSampleRetry: second.text.slice(0, 800),
  }, 'Decision still unparsable after retry');
  return null;
}

function parseControllerDecision(text: string): ControllerDecision | null {
  for (const candidate of iterateJsonCandidates(text)) {
    if (!candidate) continue;
    const parsed = relaxedJsonParse(candidate) as Partial<ControllerDecision> | null;
    if (!parsed || typeof parsed !== 'object') continue;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
      nextReviewMinutes: typeof parsed.nextReviewMinutes === 'number' ? parsed.nextReviewMinutes : undefined,
      actions: Array.isArray(parsed.actions) ? parsed.actions as ControllerAction[] : [],
    };
  }
  return null;
}

function parseSynthesisDecision(text: string): SynthesisDecision | null {
  for (const candidate of iterateJsonCandidates(text)) {
    if (!candidate) continue;
    const parsed = relaxedJsonParse(candidate) as Partial<SynthesisDecision> | null;
    if (!parsed || typeof parsed !== 'object') continue;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'No synthesis summary provided.',
      nextStep: typeof parsed.nextStep === 'string' ? parsed.nextStep : undefined,
      status: parsed.status === 'active' || parsed.status === 'blocked' || parsed.status === 'completed' ? parsed.status : undefined,
      blocker: typeof parsed.blocker === 'string' ? parsed.blocker : undefined,
      notifyUser: typeof parsed.notifyUser === 'boolean' ? parsed.notifyUser : undefined,
      notificationTitle: typeof parsed.notificationTitle === 'string' ? parsed.notificationTitle : undefined,
      notificationBody: typeof parsed.notificationBody === 'string' ? parsed.notificationBody : undefined,
      nextReviewMinutes: typeof parsed.nextReviewMinutes === 'number' ? parsed.nextReviewMinutes : undefined,
    };
  }
  return null;
}

function inferTaskPriority(execution: ExecutionRecord): 'high' | 'medium' | 'low' {
  const text = `${execution.objective} ${execution.startedFromMessage}`.toLowerCase();
  if (/\b(tonight|today|urgent|asap|immediately|critical)\b/.test(text)) return 'high';
  return 'medium';
}

function inferTaskDueDate(execution: ExecutionRecord): string | undefined {
  const text = `${execution.objective} ${execution.startedFromMessage}`.toLowerCase();
  if (/\b(tonight|today|asap|urgent)\b/.test(text)) {
    return new Date().toISOString().slice(0, 10);
  }
  return undefined;
}

function appendTask(description: string, priority: 'high' | 'medium' | 'low', dueDate?: string): string {
  ensureTasksFile();
  let body = readFileSync(TASKS_FILE, 'utf-8');
  const taskId = nextTaskId(body);
  const meta = [
    `!!${priority}`,
    dueDate ? `📅 ${dueDate}` : '',
  ].filter(Boolean).join(' ');
  const taskLine = `- [ ] {${taskId}} ${description}${meta ? ` ${meta}` : ''}`;
  const marker = '## Pending\n';
  const insertAt = body.includes(marker) ? body.indexOf(marker) + marker.length : body.length;
  body = `${body.slice(0, insertAt)}\n${taskLine}${body.slice(insertAt)}`;
  writeFileSync(TASKS_FILE, body, 'utf-8');
  return taskId;
}

function syncWorkflowBindings(store: ExecutionStore, execution: ExecutionRecord): ExecutionRecord {
  const activity: Array<{
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const updatedBindings = (execution.workflowBindings ?? []).map((binding) => {
    const status = loadWorkflowRunStatus(binding.runId);
    if (binding.status !== status) {
      const runRecord = readWorkflowRunRecord(binding.runId);
      if (status === 'completed') {
        activity.push({
          key: `workflow:${binding.runId}:completed`,
          type: 'workflow_completed',
          message: clean(
            `Workflow "${binding.workflow}" completed.${typeof runRecord?.output === 'string' ? ` ${String(runRecord.output)}` : ''}`,
            500,
          ),
          metadata: { runId: binding.runId, workflow: binding.workflow, status },
        });
      } else if (status === 'error') {
        activity.push({
          key: `workflow:${binding.runId}:error`,
          type: 'workflow_failed',
          message: clean(
            `Workflow "${binding.workflow}" failed.${typeof runRecord?.error === 'string' ? ` ${String(runRecord.error)}` : ''}`,
            500,
          ),
          metadata: { runId: binding.runId, workflow: binding.workflow, status, error: runRecord?.error },
        });
      }
    }
    return {
      ...binding,
      status,
      updatedAt: binding.status === status ? binding.updatedAt : new Date().toISOString(),
    };
  });

  if (JSON.stringify(updatedBindings) === JSON.stringify(execution.workflowBindings ?? [])) {
    return execution;
  }

  let updatedExecution = store.update(execution.id, {
    workflowBindings: updatedBindings,
    nextReviewAt: plusMinutes(15),
  }) ?? execution;
  for (const item of activity) {
    updatedExecution = appendExecutionActivity(store, updatedExecution, item);
  }
  return updatedExecution;
}

function syncDelegationBindings(store: ExecutionStore, plans: PlanStore, execution: ExecutionRecord, plan?: PlanRecord): {
  execution: ExecutionRecord;
  plan?: PlanRecord;
  delegationReports: Array<{ id: string; result?: string }>;
} {
  let changed = false;
  let nextPlan = plan;
  const delegationReports: Array<{ id: string; result?: string }> = [];
  const activity: Array<{
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const updatedBindings = (execution.delegationBindings ?? []).map((binding) => {
    const record = readDelegationById(binding.delegationId);
    if (!record) return binding;
    const resultEvidence = record.resultEvidence ?? (record.status === 'completed' ? 'model_prose' : undefined);
    const completedBy = record.completedBy?.trim() || (record.status === 'completed' ? binding.toAgent : undefined);
    const onBehalfOf = record.onBehalfOf?.trim();
    if (
      record.status === binding.status
      && record.result === binding.result
      && resultEvidence === binding.resultEvidence
      && completedBy === binding.completedBy
      && onBehalfOf === binding.onBehalfOf
    ) return binding;
    changed = true;
    if (record.status === 'completed') {
      delegationReports.push({ id: record.id, result: record.result });
      const verified = resultEvidence !== undefined && resultEvidence !== 'model_prose';
      const boundStep = binding.planStepId
        ? nextPlan?.steps.find((step) => step.id === binding.planStepId)
        : undefined;
      const cognitiveDeliverable = delegationCriterionIsCognitive(
        record.task,
        record.expectedOutput,
        record.result,
        boundStep,
      );
      const actorLabel = onBehalfOf
        ? `${completedBy} reported delegated work on behalf of ${onBehalfOf}`
        : `${completedBy} reported delegated work`;
      activity.push({
        key: `delegation:${record.id}:completed`,
        type: 'delegation_completed',
        message: clean(
          verified
            ? `${actorLabel} with verified evidence.${record.result ? ` ${record.result}` : ''}`
            : `${actorLabel}; verification required.${record.result ? ` ${record.result}` : ''}`,
          500,
        ),
        metadata: {
          delegationId: record.id,
          toAgent: binding.toAgent,
          result: record.result,
          completedBy,
          ...(onBehalfOf ? { onBehalfOf } : {}),
          resultEvidence,
          verificationRequired: !verified,
        },
      });
      // A durable completion row is transport, not proof. Today delegated
      // completions carry model prose only, so retain the result for synthesis
      // but do not silently satisfy a bound plan step. A later evidence-aware
      // controller/task transition can advance the step.
      if (nextPlan && binding.planStepId && (verified || cognitiveDeliverable)) {
        nextPlan = plans.updateStep(nextPlan.id, binding.planStepId, 'done') ?? nextPlan;
      }
    }
    return {
      ...binding,
      status: record.status,
      updatedAt: record.updatedAt,
      result: record.result,
      resultEvidence,
      completedBy,
      onBehalfOf,
    };
  });

  if (!changed) {
    return { execution, plan: nextPlan, delegationReports };
  }

  let updatedExecution = store.update(execution.id, {
    delegationBindings: updatedBindings,
    nextReviewAt: plusMinutes(delegationReports.length > 0 ? 1 : 30),
  }) ?? execution;
  if (delegationReports.length > 0) {
    updatedExecution = store.update(updatedExecution.id, {
      lastAssistantSummary: clean(
        delegationReports
          .map((item) => item.result
            ? `Delegation ${item.id} reported (verification required): ${item.result}`
            : `Delegation ${item.id} reported a result; verification required.`)
          .join(' | '),
        400,
      ),
    }) ?? updatedExecution;
  }
  for (const item of activity) {
    updatedExecution = appendExecutionActivity(store, updatedExecution, item);
  }
  const syncedExecution = nextPlan ? store.syncWithPlan(updatedExecution.id, nextPlan) ?? updatedExecution : updatedExecution;
  return { execution: syncedExecution, plan: nextPlan, delegationReports };
}

function syncTaskBindings(store: ExecutionStore, plans: PlanStore, execution: ExecutionRecord, plan?: PlanRecord): {
  execution: ExecutionRecord;
  plan?: PlanRecord;
  completedTaskIds: string[];
} {
  ensureTasksFile();
  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const completedTaskIds: string[] = [];
  const activity: Array<{
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  let changed = false;
  let nextPlan = plan;
  const updatedBindings = (execution.taskBindings ?? []).map((binding) => {
    const task = tasksById.get(binding.taskId);
    if (!task) return binding;
    const nextStatus = task.status;
    if (binding.status === nextStatus) return binding;
    changed = true;
    if (nextStatus === 'completed') {
      completedTaskIds.push(binding.taskId);
      activity.push({
        key: `task:${binding.taskId}:completed`,
        type: 'task_completed',
        message: clean(`Task ${binding.taskId} completed.${binding.description ? ` ${binding.description}` : ''}`, 500),
        metadata: { taskId: binding.taskId, description: binding.description },
      });
      if (nextPlan && binding.planStepId) {
        nextPlan = plans.updateStep(nextPlan.id, binding.planStepId, 'done') ?? nextPlan;
      }
    }
    return {
      ...binding,
      status: nextStatus,
      completedAt: nextStatus === 'completed' ? new Date().toISOString() : undefined,
    };
  });

  if (!changed) {
    return { execution, plan: nextPlan, completedTaskIds };
  }

  let updatedExecution = store.update(execution.id, {
    taskBindings: updatedBindings,
    nextReviewAt: plusMinutes(completedTaskIds.length > 0 ? 1 : 30),
  }) ?? execution;
  for (const item of activity) {
    updatedExecution = appendExecutionActivity(store, updatedExecution, item);
  }
  const syncedExecution = nextPlan ? store.syncWithPlan(updatedExecution.id, nextPlan) ?? updatedExecution : updatedExecution;
  return { execution: syncedExecution, plan: nextPlan, completedTaskIds };
}

function currentActiveStep(plan?: PlanRecord): PlanStep | undefined {
  return plan?.steps.find((step) => step.status === 'in_progress');
}

function hasPendingTaskForStep(execution: ExecutionRecord, stepId?: string): boolean {
  return Boolean((execution.taskBindings ?? []).some((binding) => binding.planStepId === stepId && binding.status === 'pending'));
}

function hasPendingDelegationForStep(execution: ExecutionRecord, stepId?: string): boolean {
  return Boolean((execution.delegationBindings ?? []).some((binding) =>
    binding.planStepId === stepId
    && (
      binding.status !== 'completed'
      // Keep an unverified reported result attached to the current step so the
      // controller can inspect/verify it instead of dispatching a duplicate.
      || binding.resultEvidence === 'model_prose'
      || (binding.status === 'completed' && !binding.resultEvidence)
    )
  ));
}

function hasPendingTaskDescription(execution: ExecutionRecord, description: string): boolean {
  const normalized = clean(description, 240).toLowerCase();
  return (execution.taskBindings ?? []).some((binding) =>
    binding.status === 'pending' && clean(binding.description ?? '', 240).toLowerCase() === normalized,
  );
}

function tokenizeSignal(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
}

function selectDelegationCandidate(execution: ExecutionRecord, stepText?: string): string | undefined {
  const agents = loadTeamAgents().filter((agent) => agent.slug !== 'clementine' && agent.autonomyEnabled !== false);
  if (agents.length === 0) return undefined;

  const haystack = `${execution.title} ${execution.objective} ${stepText ?? execution.nextStep ?? ''}`.toLowerCase();
  let best: { slug: string; score: number } | undefined;

  for (const agent of agents) {
    let score = 0;
    if (agent.project && haystack.includes(agent.project.toLowerCase())) {
      score += 4;
    }

    const roleTokens = tokenizeSignal(`${agent.role ?? ''} ${agent.description}`);
    score += roleTokens.filter((token) => haystack.includes(token)).slice(0, 2).length;

    if (!best || score > best.score) {
      best = { slug: agent.slug, score };
    }
  }

  return best && best.score >= 4 ? best.slug : undefined;
}

function createTaskForExecutionStep(store: ExecutionStore, execution: ExecutionRecord, step: PlanStep): ExecutionRecord {
  const description = clean(step.text, 240);
  if (hasPendingTaskDescription(execution, description)) {
    return store.update(execution.id, {
      nextReviewAt: plusMinutes(60),
      lastControllerRunAt: new Date().toISOString(),
    }) ?? execution;
  }
  const taskId = appendTask(description, inferTaskPriority(execution), inferTaskDueDate(execution));
  logger.info({ executionId: execution.id, taskId, stepId: step.id }, 'Execution controller created task for active step');
  let updatedExecution = store.update(execution.id, {
    taskBindings: [
      ...(execution.taskBindings ?? []),
      {
        taskId,
        planStepId: step.id,
        description,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ],
    nextStep: description,
    lastAssistantSummary: `Created task ${taskId} for active execution step.`,
    lastControllerRunAt: new Date().toISOString(),
    nextReviewAt: plusMinutes(60),
  }) ?? execution;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `task:${taskId}:created`,
    type: 'task_created',
    message: `Created task ${taskId} for execution step: ${description}`,
    metadata: { taskId, planStepId: step.id, description },
  });
  return updatedExecution;
}

function createTaskForExecution(store: ExecutionStore, execution: ExecutionRecord, description: string, priority?: 'high' | 'medium' | 'low', dueDate?: string): ExecutionRecord {
  const normalizedDescription = clean(description, 240);
  if (hasPendingTaskDescription(execution, normalizedDescription)) {
    return store.update(execution.id, {
      nextReviewAt: plusMinutes(60),
      lastControllerRunAt: new Date().toISOString(),
    }) ?? execution;
  }

  const taskId = appendTask(normalizedDescription, priority ?? inferTaskPriority(execution), dueDate ?? inferTaskDueDate(execution));
  logger.info({ executionId: execution.id, taskId }, 'Execution controller created task');
  let updatedExecution = store.update(execution.id, {
    taskBindings: [
      ...(execution.taskBindings ?? []),
      {
        taskId,
        description: normalizedDescription,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ],
    nextStep: clean(description, 220),
    lastAssistantSummary: `Created task ${taskId} to move the execution forward.`,
    lastControllerRunAt: new Date().toISOString(),
    nextReviewAt: plusMinutes(60),
  }) ?? execution;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `task:${taskId}:created`,
    type: 'task_created',
    message: `Created task ${taskId}: ${normalizedDescription}`,
    metadata: { taskId, description: normalizedDescription, priority, dueDate },
  });
  return updatedExecution;
}

function queueWorkflow(store: ExecutionStore, execution: ExecutionRecord, workflow: string, inputs?: Record<string, string>): ExecutionRecord {
  const queued = queueWorkflowRun(workflow, normalizeWorkflowRunInputs(inputs ?? {}), {
    source: 'execution-controller',
    dedupe: false,
  });
  if (!queued.id) throw new Error(`Execution controller failed to queue workflow "${workflow}".`);
  const runId = queued.id;

  logger.info({ executionId: execution.id, runId, workflow }, 'Execution controller queued workflow');
  let updatedExecution = store.update(execution.id, {
    workflowBindings: [
      ...(execution.workflowBindings ?? []),
      {
        runId,
        workflow,
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    lastAssistantSummary: `Queued workflow "${workflow}" to advance the execution.`,
    lastControllerRunAt: new Date().toISOString(),
    nextReviewAt: plusMinutes(15),
  }) ?? execution;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `workflow:${runId}:queued`,
    type: 'workflow_queued',
    message: `Queued workflow "${workflow}".`,
    metadata: { runId, workflow, inputs },
  });
  return updatedExecution;
}

function delegateExecutionStep(
  store: ExecutionStore,
  execution: ExecutionRecord,
  toAgent: string,
  task: string,
  expectedOutput: string,
  planStepId?: string,
): ExecutionRecord {
  const record: DelegationRecord = {
    id: randomBytes(4).toString('hex'),
    fromAgent: 'clementine',
    toAgent,
    task,
    expectedOutput,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const filePath = delegationFilePath(toAgent, record.id);
  if (!filePath) {
    logger.warn({ executionId: execution.id, toAgent }, 'Refused delegation with an unsafe queue owner or id');
    return execution;
  }
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  logger.info({ executionId: execution.id, delegationId: record.id, toAgent }, 'Execution controller delegated step');
  let updatedExecution = store.update(execution.id, {
    delegationBindings: [
      ...(execution.delegationBindings ?? []),
      {
        delegationId: record.id,
        toAgent,
        task,
        expectedOutput,
        planStepId,
        status: 'pending',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ],
    nextStep: `Waiting on ${toAgent}: ${clean(task, 180)}`,
    lastAssistantSummary: `Delegated work to ${toAgent}.`,
    lastControllerRunAt: new Date().toISOString(),
    nextReviewAt: plusMinutes(20),
  }) ?? execution;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `delegation:${record.id}:created`,
    type: 'delegation_created',
    message: `Delegated work to ${toAgent}: ${clean(task, 220)}`,
    metadata: { delegationId: record.id, toAgent, task, expectedOutput, planStepId },
  });
  return updatedExecution;
}

function maybeNotifyExecutionCompleted(execution: ExecutionRecord): void {
  addNotification({
    id: `${Date.now()}-execution-${execution.id}-completed`,
    kind: 'execution',
    title: `Execution completed: ${execution.title}`,
    body: execution.lastAssistantSummary ?? execution.objective,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: buildExecutionNotificationMetadata(execution),
  });
}

function listUnsynthesizedActivity(execution: ExecutionRecord, limit = 8): ExecutionActivityRecord[] {
  return [...(execution.activity ?? [])]
    .filter((item) => item.type !== 'synthesis' && (!execution.lastSynthesisAt || item.createdAt > execution.lastSynthesisAt))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-limit);
}

function buildSynthesisPrompt(execution: ExecutionRecord, plan: PlanRecord | undefined, activity: ExecutionActivityRecord[]): string {
  const activeStep = currentActiveStep(plan);
  const taskBindings = (execution.taskBindings ?? [])
    .map((binding) => `- ${binding.taskId} | ${binding.status} | ${binding.description ?? ''}`)
    .join('\n') || 'none';
  const workflowBindings = (execution.workflowBindings ?? [])
    .map((binding) => `- ${binding.workflow} (${binding.runId}) | ${binding.status}`)
    .join('\n') || 'none';
  const delegationBindings = (execution.delegationBindings ?? [])
    .map((binding) => `- ${binding.toAgent} (${binding.delegationId}) | ${binding.status} | ${binding.task}${binding.result ? ` | ${binding.result}` : ''}`)
    .join('\n') || 'none';
  const recentActivity = activity
    .map((item) => `- ${item.createdAt} | ${item.type} | ${item.message}`)
    .join('\n');

  return [
    'You are Clementine\'s execution synthesizer.',
    'Merge the recent execution events into one coherent lane update.',
    'Be conservative: keep status active unless the execution is clearly blocked or objectively completed.',
    'A single completed task or delegation does not automatically mean the whole execution is complete.',
    'If status is blocked, provide a concrete blocker. If status is completed, only do that when the objective or plan is effectively done.',
    'Return only valid JSON with this schema:',
    '{"summary":"string","nextStep":"string","status":"active|blocked|completed","blocker":"string","notifyUser":false,"notificationTitle":"string","notificationBody":"string","nextReviewMinutes":30}',
    '',
    `Execution title: ${execution.title}`,
    `Objective: ${execution.objective}`,
    `Status: ${execution.status}`,
    execution.lastAssistantSummary ? `Current summary: ${execution.lastAssistantSummary}` : '',
    execution.nextStep ? `Current next step: ${execution.nextStep}` : 'Current next step: none',
    execution.blocker ? `Current blocker: ${execution.blocker}` : '',
    execution.successCriteria ? `Success criteria: ${execution.successCriteria}` : '',
    activeStep ? `Active plan step: ${activeStep.text}` : 'Active plan step: none',
    plan ? `Plan progress: ${plan.steps.filter((step) => step.status === 'done').length}/${plan.steps.length} complete` : 'Plan progress: no plan attached',
    `Task bindings:\n${taskBindings}`,
    `Workflow bindings:\n${workflowBindings}`,
    `Delegation bindings:\n${delegationBindings}`,
    `Recent activity to synthesize:\n${recentActivity}`,
  ].filter(Boolean).join('\n');
}

// Controller + synthesis are internal model calls that should be
// snappy. A 5-minute cap is generous for what's effectively a JSON
// rollup — anything longer is almost certainly a stuck stream that
// will not produce parsable output anyway. The retry budget inside
// runDecisionWithRetry doubles the worst case (10 min) which is still
// well inside any caller's tolerance.
const CONTROLLER_DECISION_WALL_CLOCK_MS = 5 * 60_000;

async function runSynthesisDecision(
  assistant: ClementineAssistant,
  execution: ExecutionRecord,
  plan: PlanRecord | undefined,
  activity: ExecutionActivityRecord[],
): Promise<SynthesisDecision | null> {
  const request: RunRequest = {
    sessionId: `execution:${execution.id}:synthesis`,
    channel: 'execution-synthesis',
    userId: execution.userId,
    model: MODELS.fast,
    instructions: 'You are a strict internal execution synthesizer that returns JSON only.',
    prompt: buildSynthesisPrompt(execution, plan, activity),
    maxWallClockMs: CONTROLLER_DECISION_WALL_CLOCK_MS,
  };

  return runDecisionWithRetry(assistant, request, parseSynthesisDecision, {
    executionId: execution.id,
    decisionKind: 'synthesis',
  });
}

async function applySynthesisDecision(
  store: ExecutionStore,
  execution: ExecutionRecord,
  plan: PlanRecord | undefined,
  decision: SynthesisDecision,
  observedThrough: string,
): Promise<ExecutionRecord> {
  const nextStatus = decision.status ?? execution.status;
  if (nextStatus === 'completed' && execution.status !== 'completed') {
    const writeTruth = store.reconcileExternalWriteTruth(execution.id);
    if (writeTruth?.status === 'failed' || writeTruth?.status === 'ambiguous') {
      return writeTruth.execution;
    }
    const deterministicBlock = deterministicCompletionPrecheck(
      writeTruth?.execution ?? execution,
      plan,
      writeTruth?.status,
      writeTruth?.confirmedActionKeys,
    );
    if (deterministicBlock) {
      return rejectExecutionCompletion(store, execution, decision.summary, deterministicBlock, 'synthesis');
    }
    const validation = await validateExecutionCompletion(execution, plan, decision.summary);
    if (!validation.pass) {
      return rejectExecutionCompletion(store, execution, decision.summary, validation, 'synthesis');
    }
  }

  const patch: Partial<Omit<ExecutionRecord, 'id' | 'createdAt' | 'sessionId'>> = {
    status: nextStatus,
    nextStep: nextStatus === 'completed'
      ? undefined
      : decision.nextStep
        ? clean(decision.nextStep, 220)
        : execution.nextStep,
    lastAssistantSummary: clean(decision.summary, 400),
    blocker: nextStatus === 'blocked'
      ? clean(decision.blocker ?? execution.blocker ?? 'Waiting on an external dependency.', 220)
      : undefined,
    lastSynthesisAt: observedThrough,
    nextReviewAt: nextStatus === 'completed'
      ? undefined
      : typeof decision.nextReviewMinutes === 'number'
        ? plusMinutes(Math.max(5, Math.min(decision.nextReviewMinutes, 240)))
        : execution.nextReviewAt,
  };

  let updatedExecution = store.update(execution.id, patch) ?? execution;
  const effectiveStatus = updatedExecution.status;
  updatedExecution = appendExecutionActivity(store, updatedExecution, {
    key: `synthesis:${observedThrough}`,
    type: 'synthesis',
    message: clean(decision.summary, 500),
    metadata: {
      status: effectiveStatus,
      nextStep: updatedExecution.nextStep,
      blocker: updatedExecution.blocker,
    },
  });

  if (effectiveStatus === 'blocked' && execution.status !== 'blocked') {
    updatedExecution = appendExecutionActivity(store, updatedExecution, {
      key: `blocked:${observedThrough}`,
      type: 'blocked',
      message: updatedExecution.blocker ?? 'Execution became blocked.',
      metadata: { blocker: updatedExecution.blocker },
    });
  }

  if (effectiveStatus === 'completed' && execution.status !== 'completed') {
    updatedExecution = appendExecutionActivity(store, updatedExecution, {
      key: `completed:${observedThrough}`,
      type: 'completed',
      message: clean(decision.summary, 500),
    });
  }

  if (decision.notifyUser && effectiveStatus !== 'completed') {
    addNotification({
      id: `${Date.now()}-execution-${updatedExecution.id}-synthesis`,
      kind: 'execution',
      title: decision.notificationTitle ? clean(decision.notificationTitle, 120) : `Execution update: ${updatedExecution.title}`,
      body: clean(decision.notificationBody ?? decision.summary, 2000),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: buildExecutionNotificationMetadata(updatedExecution),
    });
  }

  actionBus.emit({
    kind: 'execution.transitioned',
    executionId: updatedExecution.id,
    title: updatedExecution.title,
    previousState: execution.status,
    nextState: effectiveStatus,
    summary: clean(decision.summary, 400),
    nextReviewAt: updatedExecution.nextReviewAt,
  });

  return updatedExecution;
}

async function maybeSynthesizeExecution(
  assistant: ClementineAssistant,
  store: ExecutionStore,
  execution: ExecutionRecord,
  plan?: PlanRecord,
): Promise<{ execution: ExecutionRecord; nextReviewMinutes?: number }> {
  const activity = listUnsynthesizedActivity(execution);
  if (activity.length === 0) {
    return { execution };
  }

  const decision = await runSynthesisDecision(assistant, execution, plan, activity);
  if (!decision) {
    return { execution };
  }

  return {
    execution: await applySynthesisDecision(store, execution, plan, decision, activity[activity.length - 1]?.createdAt ?? new Date().toISOString()),
    nextReviewMinutes: decision.nextReviewMinutes,
  };
}

function buildControllerPrompt(execution: ExecutionRecord, plan: PlanRecord | undefined): string {
  ensureTasksFile();
  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'));
  const taskStatuses = (execution.taskBindings ?? [])
    .map((binding) => {
      const task = tasks.find((entry) => entry.id === binding.taskId);
      return `- ${binding.taskId} | ${task?.status ?? binding.status} | ${binding.description ?? task?.description ?? ''}`;
    })
    .join('\n') || 'none';

  const workflowBindings = (execution.workflowBindings ?? [])
    .map((binding) => `- ${binding.workflow} (${binding.runId}) | ${binding.status}`)
    .join('\n') || 'none';
  const delegationBindings = (execution.delegationBindings ?? [])
    .map((binding) => [
      `- ${binding.toAgent} (${binding.delegationId}) | ${binding.status}`,
      binding.resultEvidence ? `evidence=${binding.resultEvidence}` : '',
      binding.completedBy ? `completedBy=${binding.completedBy}` : '',
      binding.onBehalfOf ? `onBehalfOf=${binding.onBehalfOf}` : '',
      binding.task,
      binding.result ? `result: ${binding.result}` : '',
    ].filter(Boolean).join(' | '))
    .join('\n') || 'none';
  const workflows = loadWorkflowSummaries()
    .filter((workflow) => workflow.enabled)
    .slice(0, 12)
    .map((workflow) => `- ${workflow.name}`)
    .join('\n') || 'none';
  const availableAgents = loadTeamAgents()
    .filter((agent) => agent.slug !== 'clementine' && agent.autonomyEnabled !== false)
    .map((agent) => `- ${agent.slug} | ${agent.role ?? 'agent'}${agent.project ? ` | project=${agent.project}` : ''} | ${agent.description}`)
    .join('\n') || 'none';
  const activeStep = currentActiveStep(plan);

  return [
    'You are Clementine\'s execution controller. Move the tracked execution forward with the smallest useful next action.',
    'Prefer creating or updating durable work artifacts over talking to the user.',
    'Do not duplicate work that is already represented by a pending task or queued/running workflow.',
    'If another installed agent is clearly a better owner for the current step, delegate it instead of creating a generic task.',
    'Notify the user only for blockers, completion, or genuinely important state changes.',
    'Return only valid JSON with this schema:',
    '{"summary":"string","nextReviewMinutes":30,"actions":[{"type":"create_task|queue_workflow|delegate|update_execution|notify_user|mark_blocked|mark_completed|noop","description":"string","priority":"high|medium|low","dueDate":"YYYY-MM-DD","workflow":"string","inputs":{"key":"value"},"toAgent":"slug","task":"string","expectedOutput":"string","nextStep":"string","summary":"string","blocker":"string","title":"string","body":"string","successCriteria":"string","reason":"string"}]}',
    '',
    `Execution title: ${execution.title}`,
    `Objective: ${execution.objective}`,
    `Reason for tracking: ${execution.reason}`,
    `Status: ${execution.status}`,
    execution.blocker ? `Current blocker: ${execution.blocker}` : '',
    `Next step: ${execution.nextStep ?? 'decide the next step'}`,
    execution.successCriteria ? `Done criteria: ${execution.successCriteria}` : '',
    activeStep ? `Active plan step: ${activeStep.text}` : 'Active plan step: none',
    plan ? `Plan progress: ${plan.steps.filter((step) => step.status === 'done').length}/${plan.steps.length} complete` : 'Plan progress: no plan attached',
    `Linked task status:\n${taskStatuses}`,
    `Linked workflow status:\n${workflowBindings}`,
    `Linked delegation status:\n${delegationBindings}`,
    `Available workflows:\n${workflows}`,
    `Available installed agents:\n${availableAgents}`,
    '',
    'Rules:',
    '- If a pending task already captures the current next step, prefer update_execution or noop.',
    '- Use create_task when the next action should become a concrete tracked task.',
    '- Use queue_workflow only if the workflow exists by exact name.',
    '- Use delegate only if the target agent exists by exact slug and is a genuinely better owner for the step.',
    '- A completed delegation labeled evidence=model_prose is a reported work product, not independent proof of an external effect. Inspect it and create the smallest verification task when the objective requires external truth.',
    '- Use mark_blocked when progress genuinely cannot continue without outside input or a missing dependency.',
    '- Use mark_completed only when the objective is satisfied.',
    '- Keep actions to 0-2 items.',
  ].filter(Boolean).join('\n');
}

async function runControllerDecision(assistant: ClementineAssistant, execution: ExecutionRecord, plan?: PlanRecord): Promise<ControllerDecision | null> {
  const request: RunRequest = {
    sessionId: `execution:${execution.id}:controller`,
    channel: 'execution-controller',
    userId: execution.userId,
    model: MODELS.fast,
    instructions: 'You are a strict internal controller that returns JSON only.',
    prompt: buildControllerPrompt(execution, plan),
    maxWallClockMs: CONTROLLER_DECISION_WALL_CLOCK_MS,
  };

  return runDecisionWithRetry(assistant, request, parseControllerDecision, {
    executionId: execution.id,
    decisionKind: 'controller',
  });
}

function applyNextReview(store: ExecutionStore, execution: ExecutionRecord, minutes?: number): ExecutionRecord {
  return store.update(execution.id, {
    nextReviewAt: plusMinutes(Math.max(5, Math.min(minutes ?? 30, 240))),
    lastControllerRunAt: new Date().toISOString(),
  }) ?? execution;
}

async function advanceExecution(assistant: ClementineAssistant, execution: ExecutionRecord): Promise<void> {
  const store = new ExecutionStore();
  const plans = new PlanStore();
  let plan = execution.planId ? plans.get(execution.planId) : undefined;
  let synthesisReviewMinutes: number | undefined;

  // Heartbeat at the TOP of every cycle so the heartbeat reaper can
  // tell "controller is alive and working" from "controller crashed
  // mid-cycle." We don't wait until the cycle is done — if we did,
  // a crash during synthesis would never get a heartbeat written
  // and the reaper would have to fall back to the 60-min activity
  // sweep, defeating the point.
  const heartbeatPatch = store.update(execution.id, { lastHeartbeatAt: new Date().toISOString() });
  if (heartbeatPatch) execution = heartbeatPatch;

  execution = syncWorkflowBindings(store, execution);
  const syncResult = syncTaskBindings(store, plans, execution, plan);
  execution = syncResult.execution;
  plan = syncResult.plan;
  const delegationSync = syncDelegationBindings(store, plans, execution, plan);
  execution = delegationSync.execution;
  plan = delegationSync.plan;
  execution = plan ? store.syncWithPlan(execution.id, plan) ?? execution : execution;
  const syncSynthesis = await maybeSynthesizeExecution(assistant, store, execution, plan);
  execution = syncSynthesis.execution;
  synthesisReviewMinutes = syncSynthesis.nextReviewMinutes;

  if (execution.status === 'completed') {
    maybeNotifyExecutionCompleted(execution);
    refreshExecutionContinuity(execution.sessionId);
    return;
  }

  const activeStep = currentActiveStep(plan);
  if (activeStep && !hasPendingTaskForStep(execution, activeStep.id) && !hasPendingDelegationForStep(execution, activeStep.id)) {
    const delegateTo = selectDelegationCandidate(execution, activeStep.text);
    const updated = delegateTo
      ? delegateExecutionStep(
          store,
          execution,
          delegateTo,
          clean(activeStep.text, 240),
          'Complete this step and report the result, any blockers, and any artifacts or changes made.',
          activeStep.id,
        )
      : createTaskForExecutionStep(store, execution, activeStep);
    const synthesized = await maybeSynthesizeExecution(assistant, store, updated, plan);
    refreshExecutionContinuity(synthesized.execution.sessionId);
    return;
  }

  if (!plan && execution.nextStep && !(execution.taskBindings ?? []).some((binding) => binding.status === 'pending')) {
    const updated = createTaskForExecution(store, execution, execution.nextStep);
    const synthesized = await maybeSynthesizeExecution(assistant, store, updated, plan);
    refreshExecutionContinuity(synthesized.execution.sessionId);
    return;
  }

  const decision = await runControllerDecision(assistant, execution, plan);
  if (!decision) {
    applyNextReview(store, execution, 30);
    return;
  }

  let currentExecution = execution;
  for (const action of decision.actions.slice(0, 2)) {
    switch (action.type) {
      case 'create_task':
        if (action.description) {
          currentExecution = createTaskForExecution(store, currentExecution, action.description, action.priority, action.dueDate);
        }
        break;
      case 'queue_workflow': {
        const workflow = action.workflow?.trim();
        const exists = workflow && loadWorkflowSummaries().some((entry) => entry.enabled && entry.name === workflow);
        if (workflow && exists) {
          currentExecution = queueWorkflow(store, currentExecution, workflow, action.inputs);
        }
        break;
      }
      case 'delegate': {
        const toAgent = action.toAgent?.trim();
        const task = action.task?.trim();
        const expectedOutput = action.expectedOutput?.trim();
        const exists = toAgent && loadTeamAgents().some((agent) => agent.slug === toAgent && agent.slug !== 'clementine');
        if (toAgent && task && expectedOutput && exists) {
          currentExecution = delegateExecutionStep(store, currentExecution, toAgent, task, expectedOutput, activeStep?.id);
        }
        break;
      }
      case 'update_execution':
        currentExecution = store.update(currentExecution.id, {
          nextStep: action.nextStep ? clean(action.nextStep, 220) : currentExecution.nextStep,
          successCriteria: action.successCriteria ? clean(action.successCriteria, 300) : currentExecution.successCriteria,
          lastAssistantSummary: action.summary ? clean(action.summary, 400) : decision.summary,
          blocker: undefined,
          status: 'active',
        }) ?? currentExecution;
        break;
      case 'notify_user':
        if (action.body) {
          addNotification({
            id: `${Date.now()}-execution-${currentExecution.id}-notify`,
            kind: 'execution',
            title: action.title ? clean(action.title, 120) : `Execution update: ${currentExecution.title}`,
            body: action.body.slice(0, 2000),
            createdAt: new Date().toISOString(),
            read: false,
            metadata: buildExecutionNotificationMetadata(currentExecution),
          });
        }
        break;
      case 'mark_blocked':
        currentExecution = store.update(currentExecution.id, {
          status: 'blocked',
          blocker: action.blocker ? clean(action.blocker, 220) : clean(action.reason ?? 'Controller identified a blocker.', 220),
          nextStep: action.nextStep ? clean(action.nextStep, 220) : currentExecution.nextStep,
          lastAssistantSummary: action.summary ? clean(action.summary, 400) : decision.summary,
        }) ?? currentExecution;
        addNotification({
          id: `${Date.now()}-execution-${currentExecution.id}-blocked`,
          kind: 'execution',
          title: `Execution blocked: ${currentExecution.title}`,
          body: currentExecution.blocker ?? currentExecution.lastAssistantSummary ?? currentExecution.objective,
          createdAt: new Date().toISOString(),
          read: false,
          metadata: buildExecutionNotificationMetadata(currentExecution),
        });
        break;
      case 'mark_completed':
        {
          const summary = action.summary ? clean(action.summary, 400) : decision.summary;
          const writeTruth = store.reconcileExternalWriteTruth(currentExecution.id);
          if (writeTruth?.status === 'failed' || writeTruth?.status === 'ambiguous') {
            currentExecution = writeTruth.execution;
            break;
          }
          const deterministicBlock = deterministicCompletionPrecheck(
            writeTruth?.execution ?? currentExecution,
            plan,
            writeTruth?.status,
            writeTruth?.confirmedActionKeys,
          );
          if (deterministicBlock) {
            currentExecution = rejectExecutionCompletion(
              store,
              currentExecution,
              summary,
              deterministicBlock,
              'controller',
            );
            break;
          }
          const validation = await validateExecutionCompletion(currentExecution, plan, summary);
          if (!validation.pass) {
            currentExecution = rejectExecutionCompletion(store, currentExecution, summary, validation, 'controller');
            break;
          }
          currentExecution = store.update(currentExecution.id, {
            status: 'completed',
            blocker: undefined,
            lastAssistantSummary: summary,
            nextReviewAt: undefined,
          }) ?? currentExecution;
          if (currentExecution.status === 'completed') {
            maybeNotifyExecutionCompleted(currentExecution);
          }
        }
        break;
      case 'noop':
      default:
        break;
    }
  }

  const actionSynthesis = await maybeSynthesizeExecution(assistant, store, currentExecution, plan);
  currentExecution = actionSynthesis.execution;
  synthesisReviewMinutes = actionSynthesis.nextReviewMinutes ?? synthesisReviewMinutes;

  if (currentExecution.status === 'completed') {
    refreshExecutionContinuity(currentExecution.sessionId);
    return;
  }

  const updated = applyNextReview(store, currentExecution, synthesisReviewMinutes ?? decision.nextReviewMinutes ?? 30);
  refreshExecutionContinuity(updated.sessionId);
}

const ADVANCE_FAILURE_AUTO_FAIL_THRESHOLD = 5;

export async function processExecutionController(assistant: ClementineAssistant): Promise<void> {
  const store = new ExecutionStore();
  const dueExecutions = store.listDue(new Date(), 8);
  for (const execution of dueExecutions) {
    try {
      await advanceExecution(assistant, execution);
      // Success: reset the failure counter. Reading the fresh record
      // because advanceExecution may have written other fields we
      // shouldn't clobber.
      if ((execution.consecutiveAdvanceFailures ?? 0) > 0) {
        store.update(execution.id, { consecutiveAdvanceFailures: 0 });
      }
    } catch (error) {
      const previousFailures = execution.consecutiveAdvanceFailures ?? 0;
      const nextFailures = previousFailures + 1;
      const errorMessage = error instanceof Error ? clean(error.message, 400) : String(error);

      // Terminal auth (Codex sign-in revoked/expired) is NOT this execution's
      // fault — the token is down globally. Auto-failing real work because auth
      // lapsed would discard it; counting it toward the failure budget would
      // burn through to auto-fail in a few cycles. Instead: park, do NOT
      // increment the failure counter, and let it resume automatically once a
      // re-auth lands (which clears the DEAD latch). The runtime already
      // surfaced the daily-bucketed "re-authenticate" notification.
      const status = (error as { status?: number } | null)?.status;
      if (isCodexAuthDead() || classifyCodexAuthError({ message: errorMessage, status }) === 'terminal') {
        logger.warn(
          { executionId: execution.id },
          'Execution controller paused — Codex auth revoked/expired; will resume after re-authentication',
        );
        store.update(execution.id, {
          nextReviewAt: plusMinutes(15),
          lastControllerRunAt: new Date().toISOString(),
          lastAssistantSummary: 'Paused — Codex sign-in expired or was revoked. Will resume automatically after re-authentication.',
          // consecutiveAdvanceFailures intentionally preserved (not incremented).
        });
        continue;
      }

      logger.error(
        { err: error, executionId: execution.id, consecutiveAdvanceFailures: nextFailures },
        'Execution controller cycle failed',
      );

      // Early-warning at cycle 2 so the user can intervene before
      // the 5-cycle auto-fail kicks in (~75 min of silent thrash
      // otherwise). Dedup'd per execution + cycle so we never spam
      // the same notification on subsequent ticks of the same cycle.
      if (
        nextFailures === 2 &&
        isUserFacingExecution(execution)
      ) {
        const earlyId = `execution-${execution.id}-early-warning`;
        if (!getNotification(earlyId)) {
          addNotification({
            id: earlyId,
            kind: 'execution',
            title: `Execution may be stuck: ${execution.title}`,
            body: `The controller has failed ${nextFailures} cycles in a row. Last error: ${errorMessage}\n\nIf this keeps failing for 3 more cycles I'll auto-fail the execution. Open Console → Activity to intervene now (re-state the objective, attach a plan, or mark blocked).`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: {
              executionId: execution.id,
              consecutiveAdvanceFailures: nextFailures,
              earlyWarning: true,
            },
          });
        }
      }

      // Hard auto-fail after N consecutive cycles. Spinning forever
      // on a malformed prompt / persistent integration error is the
      // classic "feels like babysitting" failure mode — the user
      // sees the same warning every nextReview tick and has to
      // intervene manually. Bound it.
      if (nextFailures >= ADVANCE_FAILURE_AUTO_FAIL_THRESHOLD) {
        const fresh = store.get(execution.id);
        if (fresh && fresh.status !== 'completed') {
          const reason = `Controller failed ${nextFailures} cycles in a row — auto-failed. Last error: ${errorMessage}`;
          store.update(execution.id, {
            status: 'completed',
            blocker: reason,
            lastAssistantSummary: reason,
            consecutiveAdvanceFailures: nextFailures,
            lastControllerRunAt: new Date().toISOString(),
          });
          actionBus.emit({
            kind: 'execution.transitioned',
            executionId: execution.id,
            title: execution.title,
            previousState: fresh.status,
            nextState: 'completed',
            summary: reason,
          });
          if (isUserFacingExecution(execution)) {
            addNotification({
              id: `${Date.now()}-execution-${execution.id}-autofail`,
              kind: 'execution',
              title: `Execution auto-failed: ${execution.title}`,
              body: reason,
              createdAt: new Date().toISOString(),
              read: false,
              metadata: { executionId: execution.id, consecutiveAdvanceFailures: nextFailures },
            });
          } else {
            // Internal executions (controller-driven, synthesizer-only,
            // etc.) previously auto-failed in total silence — only a
            // stack trace in the daemon log. Emit one rolled-up daily
            // notification so the user knows internal work is dropping
            // without spamming them per execution.
            const dayKey = new Date().toISOString().slice(0, 10);
            const dailyId = `system-internal-execution-autofail-${dayKey}`;
            if (!getNotification(dailyId)) {
              addNotification({
                id: dailyId,
                kind: 'system',
                title: 'Internal execution auto-failed — investigate Activity',
                body: `An internal (non-user-facing) execution auto-failed today after ${nextFailures} consecutive errors. Most recent: "${execution.title}". Open Console → Activity to see the full failure trail. Further internal auto-fails today are silently logged to avoid noise.`,
                createdAt: new Date().toISOString(),
                read: false,
                metadata: {
                  errorCategory: 'internal_execution_autofail',
                  executionId: execution.id,
                  consecutiveAdvanceFailures: nextFailures,
                },
              });
            }
          }
          continue;
        }
      }

      store.update(execution.id, {
        nextReviewAt: plusMinutes(30),
        lastControllerRunAt: new Date().toISOString(),
        lastAssistantSummary: errorMessage,
        consecutiveAdvanceFailures: nextFailures,
      });
    }
  }
}
