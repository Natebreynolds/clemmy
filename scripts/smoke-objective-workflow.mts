/**
 * Deterministic long-run smoke for the built-in objective execution loop.
 *
 * It drives the real workflow queue/runner/checkpoint machinery with a stub
 * assistant, so it needs no live app connections and no model tokens. The
 * scenario proves:
 *   1. the generic built-in pack is installed into a fresh Clementine home;
 *   2. the run persists an objective operating record;
 *   3. the run parks at the human review gate for external action;
 *   4. approving the gate resumes from the checkpoint;
 *   5. one failed external-action item marks the run needs-attention;
 *   6. retrying failed items reprocesses only the failed item.
 *
 * Run: npx tsx scripts/smoke-objective-workflow.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clemmy-objective-workflow-smoke-'));
process.env.CLEMENTINE_HOME = path.join(TMP_HOME, '.clementine-next');
process.env.WORKFLOW_USE_HARNESS = 'off';
process.env.WORKFLOW_APPROVAL_PARKING = 'on';
// This smoke validates orchestration deterministically. The unit test asserts
// the workflow declares a pinned goal; live goal judging belongs in a separate
// model-backed smoke.
process.env.CLEMMY_GOAL_CONTRACT = 'off';
fs.mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const {
  ensureBuiltInWorkflows,
  OBJECTIVE_EXECUTION_WORKFLOW_NAME,
  OBJECTIVE_EXECUTION_WORKFLOW_SLUG,
} = await import('../src/runtime/builtin-workflows.js');
const { readWorkflow } = await import('../src/memory/workflow-store.js');
const {
  processWorkflowRuns,
  reapResolvedParkedRuns,
} = await import('../src/execution/workflow-runner.js');
const approvalRegistry = await import('../src/runtime/harness/approval-registry.js');
const { queueWorkflowRun, requeueWorkflowFailedItemsFromRun } = await import('../src/tools/workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('../src/tools/shared.js');
const { listFinalFailedItems } = await import('../src/execution/workflow-events.js');

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!cond) failures += 1;
}

function readRun(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

function idFromMessage(message: string): string {
  return (
    message.match(/"id"\s*:\s*"(work-\d+|approval-\d+)"/)?.[1]
    ?? message.match(/"work_item_id"\s*:\s*"(work-\d+)"/)?.[1]
    ?? message.match(/\b(work-\d+|approval-\d+)\b/)?.[1]
    ?? 'unknown'
  );
}

const workItems = [
  {
    id: 'work-001',
    action: 'Audit the current inquiry funnel and identify baseline measurement gaps.',
    risk_class: 'read',
    tool_strategy: 'Use connected analytics/CRM/read-only records when available; otherwise summarize required data.',
    evidence_target: 'Baseline measurement note',
    requires_human_review: false,
  },
  {
    id: 'work-002',
    action: 'Draft a four-week operating plan with experiments, owners, and evidence checkpoints.',
    risk_class: 'write',
    tool_strategy: 'Write a local plan artifact and goal/task updates.',
    evidence_target: 'Operating plan file',
    requires_human_review: false,
  },
  {
    id: 'work-003',
    action: 'Enable the first approved externally visible experiment after review.',
    risk_class: 'send',
    tool_strategy: 'Use the exact connected app/action selected during review.',
    evidence_target: 'External action id or blocker',
    requires_human_review: true,
  },
];

const actionAttempts = new Map<string, number>();
let failApproval001Once = true;

const stub = {
  async respond(req: { sessionId: string; message: string }) {
    const m = req.message;
    if (/Step:\s*intake_brief/.test(m)) {
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          objective: 'Increase qualified inbound inquiries by 15% over the next four weeks.',
          success_metrics: ['qualified inquiry count', 'conversion rate from visitor to inquiry', 'weekly evidence checkpoint'],
          time_horizon: 'four weeks',
          stakeholders: ['owner', 'assistant', 'sales reviewer'],
          constraints: ['No externally visible changes without approval.', 'Use existing tools when connected.'],
          assumptions: ['Baseline data may need discovery.'],
          open_questions: ['Which inquiry source is currently authoritative?'],
          review_policy: 'Human review is required before externally visible changes or account-changing actions.',
        }),
      };
    }
    if (/Step:\s*operating_plan/.test(m)) {
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          work_items: workItems,
          approval_policy: 'Do read/write prep autonomously; ask before external actions.',
          checkpoint_plan: ['Day 0 baseline', 'Weekly metric review', 'Final four-week report'],
        }),
      };
    }
    if (/Step:\s*persist_operating_record/.test(m)) {
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          goal_status: 'created',
          goal_id: 'goal-objective-smoke',
          task_ids: ['T-001', 'T-002'],
          operating_record: '/tmp/objective-operating-record.md',
          next_actions: ['Audit baseline', 'Draft plan', 'Prepare review packet'],
          blockers: [],
        }),
      };
    }
    if (/Step:\s*execute_work_item/.test(m)) {
      const key = idFromMessage(m);
      if (key === 'work-003') {
        return {
          sessionId: req.sessionId,
          text: JSON.stringify({
            work_item_id: key,
            status: 'needs_approval',
            evidence: ['Prepared reviewed external-action proposal.'],
            approval_action: {
              needed: true,
              action: 'Enable the first reviewed experiment in the connected system.',
              tool_strategy: 'connected-app action selected after review',
              preview: 'External experiment launch packet',
            },
            blocker: '',
            next_step: 'Wait for approval gate.',
          }),
        };
      }
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          work_item_id: key,
          status: 'done',
          evidence: [`evidence://${key}`],
          approval_action: { needed: false, action: '', tool_strategy: '', preview: '' },
          blocker: '',
          next_step: '',
        }),
      };
    }
    if (/Step:\s*prepare_approval_packet/.test(m)) {
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          approval_actions: [
            {
              id: 'approval-001',
              work_item_id: 'work-003',
              action: 'Enable the first reviewed experiment in the connected system.',
              preview: 'External experiment launch packet',
              tool_strategy: 'connected-app action selected after review',
              risk_reason: 'Externally visible account-changing action.',
              evidence: ['evidence://work-001', 'evidence://work-002'],
            },
          ],
          review_summary: 'One external action needs user approval before execution.',
        }),
      };
    }
    if (/Step:\s*execute_approved_external_action/.test(m)) {
      const key = idFromMessage(m);
      actionAttempts.set(key, (actionAttempts.get(key) ?? 0) + 1);
      if (key === 'approval-001' && failApproval001Once) {
        failApproval001Once = false;
        throw new Error('simulated transient connected-app failure');
      }
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          approval_action_id: key,
          status: 'executed',
          evidence: [`external-action://${key}`],
          blocker: '',
        }),
      };
    }
    if (/Step:\s*progress_report/.test(m)) {
      return {
        sessionId: req.sessionId,
        text: JSON.stringify({
          summary: 'Objective operating loop completed this pass with evidence and review handling.',
          completed: ['Intake brief', 'Operating plan', 'Safe work items'],
          blocked: [],
          approval_actions: Array.from(actionAttempts.entries()).map(([id, attempts]) => `${id}:${attempts}`),
          next_checkpoint: 'Review metric movement at the next weekly checkpoint.',
        }),
      };
    }
    return { sessionId: req.sessionId, text: '{"ok":true}' };
  },
} as unknown as Parameters<typeof processWorkflowRuns>[0];

try {
  const seeded = ensureBuiltInWorkflows();
  check('built-in objective workflow installed', seeded.installed.includes(OBJECTIVE_EXECUTION_WORKFLOW_SLUG));

  const workflow = readWorkflow(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
  check('workflow reads back', Boolean(workflow), workflow?.data.name ?? '');
  check('external action step is gated send', workflow?.data.steps.some((s) =>
    s.id === 'execute_approved_external_action' && s.requiresApproval === true && s.sideEffect === 'send' && s.forEach === 'prepare_approval_packet',
  ) === true);

  const queued = queueWorkflowRun(OBJECTIVE_EXECUTION_WORKFLOW_NAME, {
    objective: 'Increase qualified inbound inquiries by 15% over the next four weeks.',
    context: 'Owner wants Clementine to take meeting notes, define the operating plan, execute safe prep work, and ask before externally visible actions.',
    success_target: '15% more qualified inquiries',
    time_horizon: 'four weeks',
    stakeholders: 'owner, assistant, sales reviewer',
    constraints: 'No externally visible account changes without approval.',
    review_policy: 'Ask before externally visible, irreversible, spend, legal, financial, or account-changing actions.',
    reporting_cadence: 'Report at completion and every weekly checkpoint.',
  });
  check('workflow queued', queued.status === 'queued', queued.id ?? queued.message);
  const runId = queued.id!;

  await processWorkflowRuns(stub);
  const parked = readRun(runId);
  check('run parked at external-action approval gate', parked.status === 'parked', String(parked.status));
  const approval = approvalRegistry.listPending({ status: 'pending' })
    .find((row) => row.sessionId === `workflow-gate:${runId}:execute_approved_external_action`);
  check('approval row created for external action gate', Boolean(approval), approval?.approvalId ?? '');

  if (approval) approvalRegistry.resolve(approval.approvalId, 'approved', 'objective-workflow-smoke');
  reapResolvedParkedRuns();
  const resumed = readRun(runId);
  check('approved parked run re-admitted', resumed.status === 'running', String(resumed.status));

  await processWorkflowRuns(stub);
  const completedWithErrors = readRun(runId);
  check('run completed with item failure', completedWithErrors.status === 'completed_with_errors', String(completedWithErrors.status));
  check('run marked needs attention', completedWithErrors.needsAttention === true, String(completedWithErrors.needsAttention));

  const failedItems = listFinalFailedItems(OBJECTIVE_EXECUTION_WORKFLOW_SLUG, runId);
  check('only approval-001 is finally failed', failedItems.length === 1 && failedItems[0].itemKey === 'approval-001', JSON.stringify(failedItems));

  const retry = requeueWorkflowFailedItemsFromRun(runId, { stepId: 'execute_approved_external_action' });
  check('failed-item retry queued', retry.status === 'queued', retry.id ?? retry.message);

  await processWorkflowRuns(stub);
  const retryParked = readRun(retry.id!);
  check('retry run parked at approval gate', retryParked.status === 'parked', String(retryParked.status));
  const retryApproval = approvalRegistry.listPending({ status: 'pending' })
    .find((row) => row.sessionId === `workflow-gate:${retry.id}:execute_approved_external_action`);
  check('retry approval row created', Boolean(retryApproval), retryApproval?.approvalId ?? '');
  if (retryApproval) approvalRegistry.resolve(retryApproval.approvalId, 'approved', 'objective-workflow-smoke-retry');
  reapResolvedParkedRuns();
  const retryResumed = readRun(retry.id!);
  check('approved retry run re-admitted', retryResumed.status === 'running', String(retryResumed.status));

  await processWorkflowRuns(stub);
  const retryRun = readRun(retry.id!);
  check('retry run completed cleanly', retryRun.status === 'completed', String(retryRun.status));
  check('retry has no final failed items', listFinalFailedItems(OBJECTIVE_EXECUTION_WORKFLOW_SLUG, retry.id!).length === 0);
  check('external action was attempted exactly twice', (actionAttempts.get('approval-001') ?? 0) === 2, JSON.stringify(Object.fromEntries(actionAttempts)));
} finally {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
