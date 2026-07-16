import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import {
  readWorkflow,
  type WorkflowDefinition,
} from '../memory/workflow-store.js';
import { writeWorkflowAndSyncTriggers } from '../execution/workflow-write.js';

export const OBJECTIVE_EXECUTION_WORKFLOW_SLUG = 'objective-execution-loop';
export const OBJECTIVE_EXECUTION_WORKFLOW_NAME = 'Objective Execution Loop';

interface EnsureBuiltInWorkflowsOptions {
  overwrite?: boolean;
}

export interface EnsureBuiltInWorkflowsResult {
  installed: string[];
  skipped: string[];
}

function objectiveExecutionWorkflow(): WorkflowDefinition {
  return {
    name: OBJECTIVE_EXECUTION_WORKFLOW_NAME,
    description: 'Turn a user goal or meeting notes into an objective contract, persistent operating record, reversible work, approval-gated external actions, and a progress report.',
    enabled: true,
    whenToUse: 'Use when the user asks Clementine to own a multi-step or multi-day objective, especially when the request needs discovery, planning, tools, follow-through, human review, and progress reporting.',
    trigger: { manual: true },
    allowSends: false,
    goal: {
      objective: 'Convert the user objective into an inspectable operating plan, persist the work, execute approved safe actions, gate externally visible actions, and report exact outcomes and blockers.',
      successCriteria: [
        'The objective brief names the desired outcome, success metrics or explicit unknowns, time horizon, stakeholders, constraints, and review policy.',
        'A persistent goal or operating record exists with next actions and evidence targets.',
        'Reversible/internal work is executed or honestly blocked with evidence.',
        'Externally visible, irreversible, or account-changing actions run only after a workflow approval gate.',
        'The final report lists completed work, blocked work, approval items, evidence handles, and the next checkpoint.',
      ],
      maxAttempts: 2,
    },
    inputs: {
      objective: { type: 'string', description: 'Plain-language goal, delegation, or outcome the user wants Clementine to own.' },
      context: { type: 'string', default: '', description: 'Meeting notes, transcript excerpts, owner preferences, customer/business context, prior decisions, or source material.' },
      success_target: { type: 'string', default: '', description: 'Specific metric or target when known. If unknown, the workflow should surface measurable options and assumptions.' },
      time_horizon: { type: 'string', default: '', description: 'Deadline or operating window, e.g. today, next week, next 4 weeks, this quarter.' },
      stakeholders: { type: 'string', default: '', description: 'People, teams, customers, accounts, or audiences affected by the work.' },
      constraints: { type: 'string', default: '', description: 'Budget, tone, policy, legal, brand, data, access, or tool constraints.' },
      review_policy: { type: 'string', default: 'Ask before externally visible, irreversible, spend, legal, financial, or account-changing actions.', description: 'Human-in-the-loop policy for actions Clementine should not take silently.' },
      reporting_cadence: { type: 'string', default: 'Report when the run finishes or blocks; for long objectives, include the next checkpoint.', description: 'How often the user expects progress updates.' },
    },
    steps: [
      {
        id: 'intake_brief',
        intent: 'intake',
        sideEffect: 'read',
        maxTurns: 6,
        allowedTools: ['workflow_step_result'],
        output: {
          type: 'object',
          required_keys: ['objective', 'success_metrics', 'time_horizon', 'constraints', 'open_questions', 'review_policy'],
          non_empty: ['objective', 'review_policy'],
        },
        prompt: [
          'Turn the user request and context into an assistant operating brief.',
          '',
          'Inputs:',
          '- Objective: {{input.objective}}',
          '- Context / notes: {{input.context}}',
          '- Success target: {{input.success_target}}',
          '- Time horizon: {{input.time_horizon}}',
          '- Stakeholders: {{input.stakeholders}}',
          '- Constraints: {{input.constraints}}',
          '- Review policy: {{input.review_policy}}',
          '',
          'Act like a real personal assistant after a planning conversation: separate facts from assumptions, name missing information, and define what would make the work successful.',
          'Do not invent metrics, credentials, access, offers, prices, policy approvals, or external commitments.',
          '',
          'Return JSON only:',
          '{',
          '  "objective": "<clear delegated objective>",',
          '  "success_metrics": ["<measurable target or metric option>", "..."],',
          '  "time_horizon": "<deadline/window or unknown>",',
          '  "stakeholders": ["<person/team/customer/audience>", "..."],',
          '  "constraints": ["<constraint>", "..."],',
          '  "assumptions": ["<assumption>", "..."],',
          '  "open_questions": ["<question Clementine still needs answered>", "..."],',
          '  "review_policy": "<what requires human approval>"',
          '}',
        ].join('\n'),
      },
      {
        id: 'operating_plan',
        dependsOn: ['intake_brief'],
        intent: 'planning',
        sideEffect: 'read',
        maxTurns: 8,
        allowedTools: ['workflow_step_result'],
        output: {
          type: 'object',
          required_keys: ['work_items', 'approval_policy', 'checkpoint_plan'],
          non_empty: ['work_items', 'approval_policy'],
          min_items: { work_items: 1 },
        },
        prompt: [
          'Convert the intake brief into an execution plan Clementine can actually run.',
          '',
          'Design the plan so work can survive restarts and long gaps. Every work item needs a stable id, concrete action, evidence target, likely tools, risk class, and review requirement.',
          '',
          'Classify each item:',
          '- risk_class "read" for research/context gathering.',
          '- risk_class "write" for internal/reversible drafts, files, records, or task updates.',
          '- risk_class "send" for externally visible, irreversible, spend, legal, financial, publishing, messaging, or account-changing actions.',
          '',
          'Return JSON only as an object with a single top-level work_items array so downstream forEach can fan out:',
          '{',
          '  "work_items": [',
          '    { "id": "work-001", "action": "...", "risk_class": "read|write|send", "tool_strategy": "...", "evidence_target": "...", "requires_human_review": true }',
          '  ],',
          '  "approval_policy": "<when to ask before acting>",',
          '  "checkpoint_plan": ["<checkpoint>", "..."]',
          '}',
        ].join('\n'),
      },
      {
        id: 'persist_operating_record',
        dependsOn: ['intake_brief', 'operating_plan'],
        intent: 'persistence',
        sideEffect: 'write',
        maxTurns: 8,
        retryBudget: 1,
        allowedTools: ['goal_upsert', 'goal_list', 'task_add', 'write_file', 'workflow_step_result'],
        output: {
          type: 'object',
          required_keys: ['goal_status', 'operating_record', 'next_actions'],
          non_empty: ['goal_status', 'next_actions'],
        },
        prompt: [
          'Persist this objective so it is not just a chat answer.',
          '',
          'Use Clementine-local persistence when available:',
          '- Prefer goal_upsert for the long-running objective (omit id to create, pass id to update).',
          '- Add one-shot task ledger entries only for concrete next actions; do not use task_add for recurring scheduled work.',
          '- If a goal/task tool is unavailable or blocked, write a local operating record file instead.',
          '',
          'Do not create duplicate goals if an obvious matching active goal already exists.',
          '',
          'Return JSON only:',
          '{',
          '  "goal_status": "created|updated|existing|file_only|blocked",',
          '  "goal_id": "<id or empty>",',
          '  "task_ids": ["<task id>", "..."],',
          '  "operating_record": "<file path, goal id, or record handle>",',
          '  "next_actions": ["<next action>", "..."],',
          '  "blockers": ["<blocker>", "..."]',
          '}',
        ].join('\n'),
      },
      {
        id: 'execute_work_item',
        dependsOn: ['operating_plan', 'persist_operating_record'],
        forEach: 'operating_plan',
        intent: 'execution',
        sideEffect: 'write',
        maxTurns: 12,
        retryBudget: 1,
        allowedTools: [
          'composio_search_tools',
          'composio_list_tools',
          'composio_execute_tool',
          'read_file',
          'write_file',
          'run_shell_command',
          'goal_upsert',
          'task_update',
          'notify_user',
          'workflow_step_result',
        ],
        prompt: [
          'Execute this single approved work item as far as Clementine safely can.',
          '',
          'Work item:',
          '{{item}}',
          '',
          'Rules:',
          '- If this item is read or reversible/internal write work, do the real work with available tools.',
          '- If this item would send, publish, spend money, contact someone, change production/account settings, make legal/financial commitments, or otherwise cross the review policy, do not execute it here. Prepare the exact proposed action for the approval packet instead.',
          '- Discover connected app/tool actions before using them; never invent a tool slug or claim a tool result that did not happen.',
          '- If a required account/tool/data source is unavailable, return status "blocked" with a concrete blocker and the fallback.',
          '',
          'Return JSON only:',
          '{',
          '  "work_item_id": "<id>",',
          '  "status": "done|drafted|blocked|needs_approval",',
          '  "evidence": ["<file path, URL, record id, summary, or tool evidence>", "..."],',
          '  "approval_action": { "needed": true, "action": "<external action to approve>", "tool_strategy": "<tool or app path>", "preview": "<what the human should review>" },',
          '  "blocker": "<reason or empty>",',
          '  "next_step": "<next step or empty>"',
          '}',
        ].join('\n'),
      },
      {
        id: 'prepare_approval_packet',
        dependsOn: ['execute_work_item', 'operating_plan'],
        intent: 'review',
        sideEffect: 'read',
        maxTurns: 6,
        allowedTools: ['workflow_step_result'],
        output: {
          type: 'object',
          required_keys: ['approval_actions', 'review_summary'],
        },
        prompt: [
          'Assemble the human review packet for any externally visible or irreversible actions.',
          '',
          'Use the executed work outputs and operating plan. Include only actions that still need approval before execution. If no actions need approval, return approval_actions as an empty array and explain that in review_summary.',
          '',
          'Each approval action must include:',
          '- stable id',
          '- source work item id',
          '- action',
          '- preview',
          '- target/tool strategy',
          '- risk reason',
          '- evidence the human should inspect',
          '',
          'Return JSON only:',
          '{',
          '  "approval_actions": [',
          '    { "id": "approval-001", "work_item_id": "work-001", "action": "...", "preview": "...", "tool_strategy": "...", "risk_reason": "...", "evidence": [] }',
          '  ],',
          '  "review_summary": "<what the user is approving or why no approval is needed>"',
          '}',
        ].join('\n'),
      },
      {
        id: 'execute_approved_external_action',
        dependsOn: ['prepare_approval_packet'],
        forEach: 'prepare_approval_packet',
        intent: 'approved_action',
        sideEffect: 'send',
        requiresApproval: true,
        approvalPreview: 'Review and approve externally visible or irreversible actions before Clementine executes them.',
        maxTurns: 10,
        retryBudget: 1,
        allowedTools: ['composio_search_tools', 'composio_list_tools', 'composio_execute_tool', 'write_file', 'goal_upsert', 'task_update', 'notify_user', 'workflow_step_result'],
        prompt: [
          'The workflow approval gate has been approved. Execute this one approved external action exactly as reviewed.',
          '',
          'Approved action item:',
          '{{item}}',
          '',
          'Rules:',
          '- Use the exact target/tool strategy from the approval item when possible.',
          '- Discover connected app actions before calling composio_execute_tool; never guess slugs or input keys.',
          '- If the required account/tool is unavailable, return blocked with the exact blocker and do not fake completion.',
          '- Record concrete evidence: URL, external id, file path, message id, or a clear tool result summary.',
          '',
          'Return JSON only:',
          '{',
          '  "approval_action_id": "<id>",',
          '  "status": "executed|blocked",',
          '  "evidence": ["<url/id/path/tool evidence>", "..."],',
          '  "blocker": "<reason or empty>"',
          '}',
        ].join('\n'),
      },
      {
        id: 'progress_report',
        dependsOn: ['persist_operating_record', 'execute_work_item', 'prepare_approval_packet', 'execute_approved_external_action'],
        intent: 'reporting',
        sideEffect: 'write',
        maxTurns: 6,
        allowedTools: ['goal_upsert', 'task_update', 'notify_user', 'workflow_step_result'],
        output: {
          type: 'object',
          required_keys: ['summary', 'completed', 'blocked', 'approval_actions', 'next_checkpoint'],
          non_empty: ['summary'],
        },
        prompt: [
          'Report progress to the user and update the persistent record if useful.',
          '',
          'The report must be honest and operational:',
          '- what got done',
          '- what is blocked and why',
          '- what still needs human review',
          '- concrete evidence handles',
          '- the next checkpoint for long-running objectives',
          '',
          'Call notify_user with the concise human summary, then return the same facts as JSON:',
          '{',
          '  "summary": "<human summary>",',
          '  "completed": ["<done item>", "..."],',
          '  "blocked": ["<blocked item>", "..."],',
          '  "approval_actions": ["<pending or executed approval item>", "..."],',
          '  "next_checkpoint": "<next review date/action>"',
          '}',
        ].join('\n'),
      },
    ],
    description_body: [
      '# Objective Execution Loop',
      '',
      'This built-in workflow is Clementine\'s generic long-horizon assistant loop. It is not tied to a business domain or content type. It takes a delegated objective or meeting notes, turns them into a measurable operating brief, persists the work as a goal/task/record, performs safe reversible work, parks before externally visible actions, resumes from the Tasks UI after review, and reports back with exact evidence and blockers.',
      '',
      'The workflow exists so Clementine can behave more like a real assistant: clarify the outcome, track what matters over time, use whatever connected tools fit the job, and keep risky actions human-reviewed instead of pretending every task is a single chat reply.',
    ].join('\n'),
  };
}

function writeReferenceFiles(slug: string): void {
  const dir = path.join(WORKFLOWS_DIR, slug, 'references');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'operating-principles.md'),
    [
      '# Objective Execution Operating Principles',
      '',
      '- Start from the user outcome, not from a preselected domain template.',
      '- Convert vague delegation into a measurable objective, assumptions, open questions, constraints, and review policy.',
      '- Persist long-running work as a goal, task, or operating record so it survives restarts and context loss.',
      '- Separate reversible/internal work from externally visible or irreversible action.',
      '- Discover connected tools before executing them; never invent tool names, credentials, records, URLs, or results.',
      '- Ask for approval before sends, publishing, spend, account changes, legal/financial commitments, or other high-impact actions.',
      '- Report exact evidence, blockers, and next checkpoints; do not summarize a blocked run as complete.',
    ].join('\n'),
    'utf-8',
  );
}

export function ensureBuiltInWorkflows(options: EnsureBuiltInWorkflowsOptions = {}): EnsureBuiltInWorkflowsResult {
  const installed: string[] = [];
  const skipped: string[] = [];

  const existing = readWorkflow(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
  if (existing && !options.overwrite) {
    skipped.push(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
  } else {
    writeWorkflowAndSyncTriggers(OBJECTIVE_EXECUTION_WORKFLOW_SLUG, objectiveExecutionWorkflow());
    writeReferenceFiles(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
    installed.push(OBJECTIVE_EXECUTION_WORKFLOW_SLUG);
  }

  return { installed, skipped };
}
