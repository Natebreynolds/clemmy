import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBackgroundTaskStatus,
  listBackgroundTaskStatusSummaries,
  renderBackgroundTaskStatus,
} from '../execution/background-task-status.js';
import { enqueueDurableChatTask } from '../execution/background-promote.js';
import {
  reviseBackgroundTaskContract,
  type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import { getActiveGoalForSession, holdTaskForLater, listHeldTasks, getHeldTask } from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { getSession as getHarnessSession } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { linkFocusActionForSession, updateLinkedFocusAction } from '../memory/focus.js';
import {
  admitDurableFanoutPlan,
  listFanoutActivations,
  loadFanoutPlan,
  maybeAdmitFanoutReducer,
  scheduleDurableFanout,
  settleFanoutActivation,
} from '../execution/durable-fanout.js';
import { textResult } from './shared.js';

/** Split an agreed plan (markdown bullets / numbered lines) into discrete next
 *  actions for the goal contract's step list. Best-effort + bounded. */
function planToNextActions(plan: string): string[] {
  return plan
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
}

export function backgroundRouteForOriginSession(sessionId: string): Pick<BackgroundTaskRecord, 'source' | 'channel' | 'userId'> {
  try {
    const row = getHarnessSession(sessionId);
    if (!row) return { source: 'desktop' };
    const metadata = row.metadata ?? {};
    const rawChannel = String(row.channel ?? metadata.source ?? '').trim();
    const source = rawChannel === 'discord' || rawChannel === 'slack' || rawChannel === 'webhook'
      || rawChannel === 'cli' || rawChannel === 'gateway' || rawChannel === 'mobile'
      ? rawChannel as BackgroundTaskRecord['source']
      : 'desktop';
    const slackChannelId = typeof metadata.slackChannelId === 'string' && metadata.slackChannelId.trim()
      ? metadata.slackChannelId.trim()
      : '';
    const slackThreadTs = typeof metadata.slackThreadTs === 'string' && metadata.slackThreadTs.trim()
      ? metadata.slackThreadTs.trim()
      : '';
    const channelId = source === 'slack' && slackChannelId
      ? (slackThreadTs ? `${slackChannelId}:${slackThreadTs}` : slackChannelId)
      : typeof metadata.channelId === 'string' && metadata.channelId.trim()
        ? metadata.channelId.trim()
        : typeof metadata.discordChannelId === 'string' && metadata.discordChannelId.trim()
          ? metadata.discordChannelId.trim()
          : '';
    const channel = (source === 'discord' || source === 'slack') && channelId
      ? `${source}:${channelId}`
      : rawChannel || undefined;
    const metadataUser = typeof metadata.userId === 'string' && metadata.userId.trim()
      ? metadata.userId.trim()
      : source === 'slack' && typeof metadata.slackUserId === 'string' && metadata.slackUserId.trim()
        ? metadata.slackUserId.trim()
        : typeof metadata.discordUserId === 'string' && metadata.discordUserId.trim()
          ? metadata.discordUserId.trim()
          : undefined;
    return {
      source,
      channel,
      userId: row.userId ?? metadataUser,
    };
  } catch {
    return { source: 'desktop' };
  }
}

const statusSchema = z.enum([
  'active',
  'pending',
  'running',
  'cancelling',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_continue',
  'done',
  'blocked',
  'failed',
  'aborted',
  'interrupted',
  'all',
]);

export function registerBackgroundTaskTools(server: McpServer): void {
  server.tool(
    'background_tasks_recent',
    'List recent durable background tasks with status, latest activity, approvals, and result preview. Use this when the user asks what Clementine is working on, what finished, or what is running in the background.',
    {
      status: statusSchema.nullable(),
      limit: z.number().int().min(1).max(50).nullable(),
    },
    async ({ status, limit }) => {
      const details = listBackgroundTaskStatusSummaries({
        status: status ?? 'active',
        limit: limit ?? 10,
      });
      if (details.length === 0) {
        return textResult('No matching background tasks found.');
      }

      const lines = details.map((item) => {
        const task = item.task;
        const approvalSuffix = item.pendingApprovals.length > 0
          ? ` | approvals: ${item.pendingApprovals.map((approval) => approval.approvalId).join(', ')}`
          : '';
        const activity = item.latestActivitySummary ? ` | latest: ${item.latestActivitySummary.slice(0, 180)}` : '';
        return `- ${task.id} [${task.status}] ${task.title}${approvalSuffix}${activity}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'background_task_status',
    'Inspect a durable background task by task id, run id, or session id. Includes recent tool activity, pending approvals, notifications, check-ins, and final result when available.',
    {
      id: z.string().nullable(),
    },
    async ({ id }) => {
      const details = getBackgroundTaskStatus(id ?? undefined);
      if (!details) {
        return textResult(id ? `No background task found for ${id}.` : 'No background tasks recorded yet.');
      }
      return textResult(renderBackgroundTaskStatus(details), { maxChars: 12_000 });
    },
  );

  server.tool(
    'background_task_revise',
    [
      'Course-correct an active durable background task without creating a replacement task or losing its receipts.',
      'Use when the user changes the source, scope, constraint, success criteria, or approach of work that is already queued/running/parked.',
      'The revision is versioned and applied at the next model boundary on the SAME task/session. Choose how prior evidence should be treated: preserve when compatible, revalidate when it may no longer satisfy the contract, invalidate only when it must not count.',
    ].join(' '),
    {
      id: z.string().min(1).describe('Background task id from background_tasks_recent/background_task_status.'),
      instruction: z.string().min(4).describe('The user\'s exact course correction in concrete, executable terms.'),
      evidence_policy: z.enum(['preserve', 'revalidate', 'invalidate'])
        .nullable()
        .optional()
        .describe('How already-completed evidence should be treated. Omit to revalidate by default.'),
    },
    async ({ id, instruction, evidence_policy }) => {
      const evidencePolicy = evidence_policy ?? 'revalidate';
      const task = reviseBackgroundTaskContract(id, {
        instruction,
        evidencePolicy,
      });
      if (!task) {
        return textResult(`Task ${id} was not found or is already terminal, so its contract was not changed.`);
      }
      updateLinkedFocusAction(task.id, {
        status: 'running',
        note: `Course-corrected to contract v${task.contractVersion ?? 1}; reconciling saved work.`,
      });
      return textResult(
        `Updated ${task.id} to contract v${task.contractVersion ?? 1}. `
        + `The same durable task will reconcile saved work at its next model boundary; prior evidence policy: ${evidencePolicy}.`,
      );
    },
  );

  server.tool(
    'dispatch_background_task',
    [
      'Hand an AGREED, multi-step task to the reliable background runner (fire-and-forget).',
      'Call this ONLY AFTER you and the user have aligned on what to do (CONVERSE FIRST) and they want it run in the background rather than waited-on here.',
      'It runs in the daemon — board-visible, survives a restart — and reports its outcome back to THIS chat automatically when it finishes (or if it gets stuck or needs your input).',
      'Pass the AGREED objective + the concrete steps you settled on (NOT the raw user message).',
      'After it returns: confirm to the user that it is running and that you will report back, then STOP — do NOT do the work yourself this turn, do NOT poll. The user is free to fire another task immediately.',
    ].join('\n'),
    {
      objective: z.string().min(4).describe('One line: what this run must achieve.'),
      handoff_note: z.string().nullable().describe('YOUR OWN WORDS to the user confirming the handoff — the exact message they will read as your reply. Rubric: confirm it is running in the background, that you will report back here, and anything worth noting in your own voice. Null falls back to a plain generated line — always prefer writing this yourself.'),
      plan: z.string().min(1).describe('The agreed steps/approach to execute (markdown bullets are fine). This was settled with the user — the worker follows it, it does not re-derive a different approach.'),
      success_criteria: z.array(z.string()).nullable().describe('Concrete done-checks; the run is complete only when all hold.'),
      context_refs: z.array(z.string()).nullable().describe('File paths, resource ids, or tool-call ids the worker should load first before producing artifacts.'),
      max_minutes: z.number().int().min(1).max(240).nullable().describe('Soft wall-clock budget; defaults to the policy long-task minutes.'),
      manifest: z.object({
        items: z.array(z.string().min(1)).min(1).max(2000)
          .describe('CANONICAL item identities (real ids/names you enumerated — never "item 1..N" placeholders). Every item is durably tracked and settled individually.'),
        phases: z.array(z.string().min(1)).min(1).max(6).nullable()
          .describe('Phase names each item passes through, in order (default: ["execute"]).'),
        missing_required_inputs: z.array(z.string()).nullable()
          .describe('Load-bearing inputs you do NOT have. Naming any pauses admission with ONE typed clarification instead of guessing unattended.'),
      }).nullable().describe(
        'For MANY-ITEM work (each item processed independently, then combined): the typed fan-out manifest. '
        + 'The runtime windows items across durable workers, settles each item exactly once (a restart resumes, never redoes), '
        + 'and runs the reducer once when every item has settled. Omit for ordinary single-objective tasks.'),
    },
    async ({ objective, handoff_note, plan, success_criteria, context_refs, max_minutes, manifest }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('I can only dispatch a background task from a live chat session (no session context here) — run the task directly instead.');
      }
      void handoff_note; // consumed by the terminal reply renderer via output marker below

      // Typed fan-out lane: the brain's OWN plan carries the manifest — no
      // second classifier call, no phrase heuristics. Admission validates the
      // contract; missing inputs come back as ONE typed clarification.
      if (manifest) {
        const phases = manifest.phases?.length ? manifest.phases : ['execute'];
        const admitted = admitDurableFanoutPlan({
          kind: 'durable_manifest',
          objective,
          successCriteria: success_criteria ?? [],
          missingRequiredInputs: manifest.missing_required_inputs ?? [],
          effectCeiling: 'read',
          estimatedActivations: Math.max(1, manifest.items.length),
          manifest: {
            manifestId: `chat-${sessionId.slice(0, 24)}`,
            contractVersion: 'v1',
            canonicalItems: manifest.items.map((id) => ({ id })),
            phases: phases.map((id, index) => ({
              id,
              dependsOn: index === 0 ? [] : [phases[index - 1]!],
              runnerClass: 'worker',
            })),
            reducer: { id: 'reduce', requiredPhases: phases, outputContract: 'report@1' },
          },
        }, { originSessionId: sessionId });
        if (!admitted.ok) {
          return admitted.kind === 'needs_input'
            ? textResult(`Before I can fan this out I need: ${admitted.missing.join('; ')}. Ask the user, then dispatch again with the answers.`)
            : textResult(`The fan-out manifest was refused: ${admitted.errors.join('; ')}. Fix the manifest and dispatch again.`);
        }
        const originRoute = backgroundRouteForOriginSession(sessionId);
        const scheduled = scheduleDurableFanout(admitted.plan.planId, originRoute);
        const windows = scheduled?.workerTasks.length ?? 0;
        linkFocusActionForSession(sessionId, {
          id: admitted.plan.planId,
          label: `${objective} (${manifest.items.length} items)`,
          status: 'running',
          kind: 'background',
          ref: admitted.plan.planId,
        });
        return textResult(
          `Admitted durable fan-out plan ${admitted.plan.planId}: ${manifest.items.length} items × ${phases.length} phase(s) `
          + `across ${windows} worker window(s) on the background runner. Every item settles exactly once (a restart resumes rather than redoes), `
          + `and the combined result reports back HERE automatically after the last item. Tell the user it's running; do NOT process items yourself this turn.`,
        );
      }
      const composedPrompt = [
        `Objective: ${objective}`,
        '',
        'Agreed plan (execute these steps — this was settled with the user; do NOT re-derive a different approach):',
        plan,
        success_criteria && success_criteria.length > 0
          ? `\nSuccess criteria (the run is done only when ALL hold):\n- ${success_criteria.join('\n- ')}`
          : '',
        context_refs && context_refs.length > 0
          ? `\nLoad this context FIRST, before producing any artifact:\n- ${context_refs.join('\n- ')}`
          : '',
      ].filter(Boolean).join('\n');

      const originRoute = backgroundRouteForOriginSession(sessionId);
      const task = enqueueDurableChatTask({
        message: objective,
        composedPrompt,
        sessionId,
        userId: originRoute.userId,
        channel: originRoute.channel,
        source: originRoute.source,
        maxMinutes: max_minutes ?? undefined,
        // Rich contract rides through enqueue's goal-bind-at-creation (the
        // single mechanism every entry path now shares).
        goal: {
          objective,
          successCriteria: success_criteria ?? undefined,
          nextActions: planToNextActions(plan),
        },
      });
      const goal = getActiveGoalForSession(task.runSessionId);
      linkFocusActionForSession(sessionId, {
        id: task.id,
        label: task.title,
        status: 'running',
        kind: 'background',
        ref: task.id,
        note: goal ? 'Bound to its durable goal contract.' : undefined,
      });

      return textResult(
        `Dispatched "${task.title}" to the background (task ${task.id})`
        + (goal ? ' with a goal contract — it will keep working until the success criteria are met, not just run once' : '')
        + `. It's running in the daemon now and will report its result back HERE automatically when it finishes — or pause and ask you here if it needs a decision. `
        + `Tell the user it's on it and that you'll report back; do NOT wait, poll, or do the work yourself this turn — you're free to take their next request right now. It's also watchable on the Tasks board.`,
      );
    },
  );

  server.tool(
    'hold_task_for_later',
    [
      'HOLD an agreed multi-step task for later instead of running it now — the "or you can ask me later and I\'ll bring it back up" choice.',
      'Call this ONLY after you and the user aligned on the task AND they chose to hold it (not run it now, not background it now).',
      'Pass the AGREED objective + steps + success criteria you settled on. It is saved against this chat and shown in your Current Focus as a held task.',
      'The user resumes it whenever by reference ("pick up the Salesforce scrape") — you then call resume_held_task with its id, which dispatches it to the background bound to its goal. Confirm it is held, tell them how to bring it back, and STOP.',
    ].join('\n'),
    {
      objective: z.string().min(4).describe('One line: what the held task must achieve.'),
      steps: z.array(z.string()).nullable().describe('The agreed steps/approach (settled with the user).'),
      success_criteria: z.array(z.string()).nullable().describe('Concrete done-checks for when it is eventually run.'),
    },
    async ({ objective, steps, success_criteria }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('I can only hold a task from a live chat session (no session context here).');
      }
      const held = holdTaskForLater({
        objective,
        steps: steps ?? undefined,
        successCriteria: success_criteria ?? undefined,
        sessionId,
        originatingRequest: objective,
      });
      if (!held) {
        return textResult('I could not hold that — give me a short objective and I\'ll keep it for later.');
      }
      return textResult(
        `Held "${held.plan.objective}" for later (id ${held.id}). It won't run until you bring it back — `
        + `just say "pick up ${held.plan.objective.slice(0, 40)}…" (or "what's on hold?") and I'll resume it, running it in the background then. `
        + `Tell the user it's saved + how to resume, and STOP.`,
      );
    },
  );

  server.tool(
    'resume_held_task',
    [
      'Resume a task the user previously asked you to HOLD (see your Current Focus "Held" list), now that they want it run.',
      'Pass the held task id (held-xxxx). It dispatches the held plan to the background bound to its goal contract — it runs until its criteria are met and reports back HERE.',
      'After it returns: confirm it is now running in the background and that you will report back, then STOP — do not do the work yourself this turn.',
    ].join('\n'),
    {
      id: z.string().min(1).describe('The held task id (held-xxxx) from your Current Focus held list.'),
    },
    async ({ id }) => {
      const held = getHeldTask(id);
      if (!held) {
        const sessionId = getToolOutputContext()?.sessionId;
        const open = sessionId ? listHeldTasks(sessionId) : [];
        return textResult(
          open.length > 0
            ? `No held task "${id}". Held right now: ${open.map((h) => `${h.id} — ${h.plan.objective.slice(0, 60)}`).join('; ')}.`
            : `No held task "${id}", and nothing is currently on hold.`,
        );
      }
      const result = approvePlanAndQueueBackgroundTask(id);
      if (!result) {
        return textResult(`I found the held task "${id}" but could not queue it — try again or re-state the task.`);
      }
      linkFocusActionForSession(getToolOutputContext()?.sessionId, {
        id: result.task.id,
        label: result.task.title,
        status: 'running',
        kind: 'background',
        ref: result.task.id,
        note: `Resumed from held task ${id}.`,
      });
      return textResult(
        `Picking "${result.task.title}" back up — it's now running in the background (task ${result.task.id}) bound to its goal, and will report back HERE when done. `
        + `Tell the user it's resumed + running; do NOT do the work yourself this turn.`,
      );
    },
  );

  server.tool(
    'fanout_settle_item',
    [
      'Settle ONE item×phase of a durable fan-out plan you are a worker for.',
      'Call this after you have genuinely processed the item. Exactly-once: if a previous attempt already settled it, you get alreadySettled — skip the item, never redo it.',
      'The reducer runs automatically once every item and phase of the plan has settled; you never trigger it yourself.',
    ].join('\n'),
    {
      plan_id: z.string().min(1),
      item_id: z.string().min(1),
      phase_id: z.string().min(1),
      status: z.enum(['done', 'failed']),
      receipt: z.string().nullable().describe('One line of evidence for HOW the item settled (an id, a count, an error). Stored on the durable journal row.'),
    },
    async ({ plan_id, item_id, phase_id, status, receipt }) => {
      const settled = settleFanoutActivation({
        planId: plan_id, itemId: item_id, phaseId: phase_id, status,
        receiptRef: receipt ?? undefined,
      });
      if (!settled.settled) return textResult(`Not settled: ${settled.reason}`);
      if (settled.alreadySettled) {
        return textResult(`Item ${item_id} phase ${phase_id} was ALREADY settled by an earlier attempt — skip it and continue with the next open item.`);
      }
      const open = listFanoutActivations(plan_id).filter((a) => a.status !== 'done').length;
      // The last settlement admits the reducer. Journal readiness + the
      // atomic lease make this exactly-once no matter how many workers,
      // retries, or processes reach zero "simultaneously".
      if (open === 0) maybeAdmitFanoutReducer(plan_id);
      return textResult(
        `Settled ${item_id} × ${phase_id} (${status}). ${open} activation(s) still open on plan ${plan_id}.`
        + (open === 0 ? ' The plan is complete — the reducer has been admitted and will report back.' : ''),
      );
    },
  );

  server.tool(
    'fanout_list_open_items',
    'List the still-open item×phase activations of a durable fan-out plan (paged). Use this to find remaining work instead of guessing from your prompt.',
    {
      plan_id: z.string().min(1),
      limit: z.number().int().min(1).max(200).nullable(),
    },
    async ({ plan_id, limit }) => {
      const plan = loadFanoutPlan(plan_id);
      if (!plan) return textResult(`No durable fan-out plan ${plan_id}.`);
      const open = listFanoutActivations(plan_id).filter((a) => a.status !== 'done');
      const page = open.slice(0, limit ?? 100);
      return textResult([
        `Plan ${plan_id} (${plan.status}): ${open.length} open activation(s).`,
        ...page.map((a) => `- ${a.itemId} × ${a.phaseId} [${a.status}]`),
        ...(open.length > page.length ? [`…and ${open.length - page.length} more.`] : []),
      ].join('\n'));
    },
  );
}
