import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, DISCORD_DM_ALLOWED_USERS } from '../config.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import { ExecutionStore } from '../execution/store.js';
import { isUserFacingExecution } from '../execution/scope.js';
import { addNotification } from '../runtime/notifications.js';
import { GOALS_DIR } from '../tools/shared.js';
import { getProactivityPolicySnapshot } from './proactivity-policy.js';
import { isActionable as isActionableApproval, listPending as listApprovalRegistry, type PendingApprovalRow } from '../runtime/harness/approval-registry.js';

const logger = pino({ name: 'clementine-next.proactive-briefs' });

const BRIEF_STATE_FILE = path.join(BASE_DIR, 'state', 'proactive-briefs.json');
const RECENT_FAILURE_WINDOW_MS = 6 * 60 * 60_000;
const URGENT_REPEAT_MINUTES = 4 * 60;

interface ProactiveBriefState {
  lastBriefAt?: string;
  lastSignature?: string;
  lastTitle?: string;
  lastSummary?: string;
}

interface GoalRecord {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  priority?: 'high' | 'medium' | 'low';
  nextActions?: string[];
  blockers?: string[];
  updatedAt?: string;
}

export interface BriefBackgroundTaskLike {
  status: string;
  pendingApprovalId?: string;
}

export function isActiveBackgroundTaskForBrief(
  task: BriefBackgroundTaskLike,
  actionableApprovalIds: ReadonlySet<string>,
): boolean {
  const isActive =
    task.status === 'pending' ||
    task.status === 'running' ||
    task.status === 'cancelling' ||
    task.status === 'awaiting_approval' ||
    task.status === 'interrupted';
  if (!isActive) return false;

  // Some old background tasks can be left in awaiting_approval after their
  // approval row has been resolved, expired, or migrated away. They are not
  // actionable, so they should not inflate Discord "background task" counts.
  if (task.status === 'awaiting_approval' && task.pendingApprovalId) {
    return actionableApprovalIds.has(task.pendingApprovalId);
  }
  return true;
}

export function singleApprovalMetadataForBrief(approvals: PendingApprovalRow[]): Record<string, string> {
  if (approvals.length !== 1) return {};
  const approval = approvals[0];
  return {
    approvalId: approval.approvalId,
    approvalSessionId: approval.sessionId,
    approvalSubject: approval.subject,
  };
}

function ensureStateDir(): void {
  mkdirSync(path.dirname(BRIEF_STATE_FILE), { recursive: true });
}

function loadState(): ProactiveBriefState {
  if (!existsSync(BRIEF_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BRIEF_STATE_FILE, 'utf-8')) as ProactiveBriefState;
  } catch {
    return {};
  }
}

function saveState(state: ProactiveBriefState): void {
  ensureStateDir();
  const tmpPath = `${BRIEF_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, BRIEF_STATE_FILE);
}

function clean(value: string, max = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function looksInternalPrompt(value: string): boolean {
  return /^(you are|execute the following job prompt|autonomy mode:|task id:|workflow architect)/i.test(value.trim());
}

function humanLabel(primary: string | undefined, fallback: string | undefined, empty: string): string {
  const first = primary ? clean(primary, 140) : '';
  if (first && !looksInternalPrompt(first)) return first;

  const second = fallback ? clean(fallback, 140) : '';
  if (second && !looksInternalPrompt(second)) return second;

  return empty;
}

function readGoals(): GoalRecord[] {
  if (!existsSync(GOALS_DIR)) return [];
  return readdirSync(GOALS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as GoalRecord;
      } catch {
        return null;
      }
    })
    .filter((goal): goal is GoalRecord => Boolean(goal));
}

function signatureFor(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function shouldSendBrief(state: ProactiveBriefState, signature: string, cadenceMinutes: number, urgent: boolean): boolean {
  if (!state.lastBriefAt) return true;
  const elapsedMs = Date.now() - new Date(state.lastBriefAt).getTime();
  if (state.lastSignature === signature) {
    return urgent && elapsedMs >= Math.max(URGENT_REPEAT_MINUTES, cadenceMinutes * 60_000);
  }
  if (urgent) return true;
  return elapsedMs >= cadenceMinutes * 60_000;
}

export function getProactiveBriefState(): ProactiveBriefState {
  return loadState();
}

export async function processProactiveBriefs(assistant: ClementineAssistant): Promise<void> {
  const proactivity = getProactivityPolicySnapshot();
  if (!proactivity.proactiveWorkAllowed) return;

  const policy = proactivity.policy;
  const executions = new ExecutionStore().list(50)
    .filter((execution) =>
      (execution.status === 'active' || execution.status === 'blocked') &&
      isUserFacingExecution(execution),
    );
  // Brief surfaces ONLY approvals that are stale enough to need a
  // nudge. Fresh approvals (just requested) already get their own
  // dedicated Discord card with Approve/Edit/Reject buttons — listing
  // them in the brief moments later produced "Clementine needs
  // approval" messages immediately following every approval request,
  // which trained users to ignore the brief. The threshold is the
  // brief's own cadence: if it's been longer than one cadence window
  // since the approval was requested AND nothing has resolved it,
  // surface it; otherwise stay quiet and trust the dedicated card.
  const APPROVAL_BRIEF_AGE_MS = Math.max(15, policy.briefCadenceMinutes) * 60_000;
  // v0.5.11: read from approval-registry directly instead of the runtime
  // wrapper. The runtime's PendingApproval only carries `toolName` —
  // the registry row carries `subject` + `args` + `requestedAt`, which
  // is what the user actually needs to recognize the request. Previously
  // briefs said "Approval needed: request_approval in sess-abc" which
  // told the user nothing about what was being asked.
  const registryRows: PendingApprovalRow[] = (() => {
    try {
      return listApprovalRegistry({ status: 'pending' });
    } catch {
      return [];
    }
  })();
  const actionableRegistryRows = registryRows.filter((approval) => isActionableApproval(approval));
  const runtimePendingApprovalIds = new Set<string>();
  try {
    for (const approval of assistant.getRuntime().listPendingApprovals()) {
      if (approval.status === 'pending') runtimePendingApprovalIds.add(approval.id);
    }
  } catch {
    // Runtime approval state is best-effort for brief hygiene. The harness
    // registry above remains the authoritative source for new approvals.
  }
  const actionableApprovalIds = new Set<string>([
    ...actionableRegistryRows.map((approval) => approval.approvalId),
    ...runtimePendingApprovalIds,
  ]);
  const backgroundTasks = listBackgroundTasks().slice(0, 50);
  const activeTasks = backgroundTasks.filter((task) =>
    isActiveBackgroundTaskForBrief(task, actionableApprovalIds),
  );
  const recentFailures = backgroundTasks.filter((task) =>
    (task.status === 'failed' || task.status === 'aborted') &&
    task.completedAt &&
    Date.now() - new Date(task.completedAt).getTime() <= RECENT_FAILURE_WINDOW_MS,
  );
  const approvals = actionableRegistryRows.filter((approval) => {
    const requestedAt = approval.requestedAt;
    if (!requestedAt) return true;
    return Date.now() - new Date(requestedAt).getTime() >= APPROVAL_BRIEF_AGE_MS;
  });
  const blockedGoals = readGoals().filter((goal) => goal.status === 'blocked');
  const blockedExecutions = executions.filter((execution) => execution.status === 'blocked');
  // Same idea for attention-needing background tasks: a task that's
  // ONLY awaiting_approval is already represented by the approval row
  // above (one card, one mention). Drop the duplicate "task needs
  // attention" line in that case so each item shows up exactly once.
  // Interrupted / cancelling tasks remain — those have no approval
  // counterpart.
  const attentionTasks = activeTasks.filter((task) =>
    task.status === 'interrupted' ||
    task.status === 'cancelling' ||
    (task.status === 'awaiting_approval' && !task.pendingApprovalId),
  );
  const urgent = approvals.length > 0 ||
    recentFailures.length > 0 ||
    blockedGoals.length > 0 ||
    blockedExecutions.length > 0 ||
    attentionTasks.length > 0;

  const signal = {
    executions: executions.map((execution) => [execution.id, execution.status, execution.nextStep, execution.blocker]),
    activeTasks: activeTasks.map((task) => [task.id, task.status, task.lastCheckInMessage, task.pendingApprovalId]),
    recentFailures: recentFailures.map((task) => [task.id, task.status, task.error]),
    approvals: approvals.map((approval) => [approval.approvalId, approval.subject, approval.sessionId]),
    blockedGoals: blockedGoals.map((goal) => [goal.id, goal.title, goal.blockers?.[0]]),
  };
  const hasSignal = executions.length > 0 || activeTasks.length > 0 || recentFailures.length > 0 || approvals.length > 0 || blockedGoals.length > 0;
  if (!hasSignal) return;

  const state = loadState();
  const signature = signatureFor(signal);
  if (!shouldSendBrief(state, signature, policy.briefCadenceMinutes, urgent)) return;

  const lines = [
    urgent
      ? 'I need your attention on current work.'
      : 'Quick status update on active Clementine work.',
    `${plural(executions.length, 'active run')}, ${plural(activeTasks.length, 'background task')}, ${plural(approvals.length, 'pending approval')}.`,
    '',
    // v0.5.11: surface the actual SUBJECT (what the user is being asked
    // to approve) + relative age so the user can recognize it without
    // opening the dashboard. Add a dashboard deep-link footer so a single
    // brief can point at the Approvals panel instead of N noise lines.
    ...(approvals.length > 0
      ? [
          ...approvals.slice(0, 4).map((approval) => {
            const ageMin = Math.max(0, Math.floor((Date.now() - new Date(approval.requestedAt).getTime()) / 60_000));
            const ageLabel = ageMin >= 60 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m` : `${ageMin}m`;
            const subject = clean(approval.subject || approval.tool || 'unknown action', 200);
            const sourceWorkflow = (approval.args && typeof approval.args === 'object' && typeof (approval.args as { workflow?: unknown }).workflow === 'string')
              ? ` (workflow: ${clean((approval.args as { workflow: string }).workflow, 60)})`
              : '';
            return `- Pending ${ageLabel}: ${subject}${sourceWorkflow}`;
          }),
          ...(approvals.length > 4 ? [`- … +${approvals.length - 4} more pending.`] : []),
          approvals.length === 1
            ? `Tap Approve, Edit, or Reject below — or reply \`approve ${approvals[0].approvalId}\` / \`reject ${approvals[0].approvalId}\`.`
            : 'Reply `approvals` to get individual approval cards, or open the Approvals panel.',
        ]
      : []),
    ...blockedExecutions.slice(0, 4).map((execution) =>
      `- Blocked run: ${humanLabel(execution.title, execution.objective, `Run ${shortId(execution.id)}`)}${execution.blocker ? ` — ${clean(execution.blocker, 160)}` : ''}`,
    ),
    ...attentionTasks.slice(0, 4).map((task) =>
      `- Task needs attention: ${humanLabel(task.title, task.prompt, `Task ${shortId(task.id)}`)} (${task.status.replace('_', ' ')}).`,
    ),
    ...recentFailures.slice(0, 3).map((task) =>
      `- Recent failure: ${humanLabel(task.title, task.prompt, `Task ${shortId(task.id)}`)} — ${clean(task.error ?? task.status, 160)}`,
    ),
    ...blockedGoals.slice(0, 3).map((goal) =>
      `- Blocked goal: ${clean(goal.title, 140)}${goal.blockers?.[0] ? ` — ${clean(goal.blockers[0], 160)}` : ''}`,
    ),
    ...executions.filter((execution) => execution.status === 'active').slice(0, 3).map((execution) =>
      `- Working on: ${humanLabel(execution.title, execution.objective, `Run ${shortId(execution.id)}`)}. Next: ${clean(execution.nextStep ?? 'decide the next step', 140)}`,
    ),
    ...activeTasks.slice(0, 4).map((task) =>
      task.status === 'running'
        ? `- Background task: ${humanLabel(task.title, task.prompt, `Task ${shortId(task.id)}`)} is running${task.lastCheckInMessage ? `. Latest: ${clean(task.lastCheckInMessage, 140)}` : '.'}`
        : '',
    ),
    '',
    urgent
      ? 'Reply here if you want me to change course, or open Run Control to approve, retry, or cancel.'
      : 'No action needed unless you want to redirect the work. Details are in Run Control.',
  ].filter(Boolean);

  const now = new Date().toISOString();
  const title = approvals.length > 0
    ? 'Clementine needs approval'
    : urgent
      ? 'Clementine needs attention'
      : 'Clementine work update';
  const approvalMetadata = singleApprovalMetadataForBrief(approvals);

  addNotification({
    id: `${Date.now()}-proactive-brief`,
    kind: 'execution',
    title,
    body: lines.join('\n'),
    createdAt: now,
    read: false,
    metadata: {
      proactiveBrief: true,
      discordUserId: policy.allowDiscordCheckIns ? DISCORD_DM_ALLOWED_USERS[0] : undefined,
      activeExecutionCount: executions.length,
      activeBackgroundTaskCount: activeTasks.length,
      pendingApprovalCount: approvals.length,
      blockedGoalCount: blockedGoals.length,
      ...approvalMetadata,
    },
  });

  saveState({
    lastBriefAt: now,
    lastSignature: signature,
    lastTitle: title,
    lastSummary: lines.slice(0, 8).join('\n'),
  });
  logger.info({ title, activeTasks: activeTasks.length, executions: executions.length, approvals: approvals.length }, 'Proactive brief queued');
}
