import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanProposal } from '../agents/plan-proposals.js';
import { DEFAULT_PROACTIVITY_POLICY } from '../agents/proactivity-policy.js';
import type { CheckInTemplate } from '../agents/check-in-templates.js';
import type { BackgroundTaskRecord } from '../execution/background-tasks.js';
import { workflowTriggerPayloadHash } from '../execution/workflow-trigger-registry.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import {
  backgroundProspectiveDefinition,
  checkInProspectiveDefinition,
  goalProspectiveDefinition,
  monitorProspectiveDefinitions,
  timerProspectiveDefinition,
  workflowProspectiveDefinitions,
} from './prospective-adapters.js';

test('timer and self-driving goal adapters preserve exact cue, session, and risk boundaries', () => {
  const timer = timerProspectiveDefinition({
    id: 'timer-a',
    message: 'Review the launch dashboard',
    fireAt: Date.parse('2026-08-01T16:00:00.000Z'),
    createdAt: Date.parse('2026-07-26T16:00:00.000Z'),
  });
  assert.equal(timer.id, 'timer:timer-a');
  assert.deepEqual(timer.trigger, { kind: 'time', at: '2026-08-01T16:00:00.000Z' });
  assert.equal(timer.approvalMode, 'none');

  const goal = goalProspectiveDefinition({
    id: 'goal-a',
    proposedAt: '2026-07-26T16:00:00.000Z',
    proposedByAgent: 'planner',
    status: 'active',
    originatingRequest: 'Run the launch',
    sessionId: 'chat:launch',
    plan: {
      objective: 'Launch the verified campaign',
      steps: [{ n: 1, action: 'Verify it', rationale: 'Avoid a bad send', verification: 'Checks pass' }],
      successCriteria: ['Campaign is live'],
      stages: null,
      risks: [],
      estimatedComplexity: 'moderate',
      recommendsTrackedExecution: true,
      needsUserInput: [],
      appliedInstructions: [],
      externalSends: [{ slug: 'GMAIL_SEND_EMAIL', summary: 'Launch email', count: 1 }],
    },
    selfDriving: true,
    nextResumeAt: '2026-08-02T16:00:00.000Z',
    version: 'v1',
  } satisfies PlanProposal);
  assert.equal(goal?.id, 'goal:goal-a');
  assert.equal(goal?.sessionId, 'chat:launch');
  assert.equal(goal?.risk, 'send');
  assert.equal(goal?.approvalMode, 'enforce_at_action');
  assert.deepEqual(goal?.trigger, { kind: 'time', at: '2026-08-02T16:00:00.000Z' });
});

test('workflow adapters use the authoritative directory slug and exact trigger-registry identities', () => {
  const workflow: WorkflowDefinition = {
    // Intentionally different: the directory slug is the runtime identity.
    name: 'Display Name',
    description: 'Process qualified leads',
    enabled: true,
    trigger: {
      schedule: '0 8 * * *',
      timezone: 'America/Los_Angeles',
      webhookPath: 'qualified-lead',
      events: [{
        type: 'crm.lead.qualified',
        filter: { region: 'west' },
        dedupeKey: 'lead-{{payload.id}}',
      }],
    },
    steps: [{ id: 'send', prompt: 'Send the approved follow-up', sideEffect: 'send' }],
  };
  const definitions = workflowProspectiveDefinitions('lead-flow', workflow);
  assert.equal(definitions.length, 3);

  const schedule = definitions.find((item) => item.sourceKind === 'workflow_schedule');
  assert.equal(schedule?.id, 'workflow_schedule:lead-flow');
  assert.equal(schedule?.workflowName, 'lead-flow');
  assert.equal(schedule?.action.ref, 'lead-flow');
  assert.equal(schedule?.risk, 'send');
  assert.equal(schedule?.approvalMode, 'enforce_at_action');

  const webhook = definitions.find((item) => item.sourceKind === 'workflow_webhook');
  assert.equal(webhook?.id, 'workflow_webhook:webhook:lead-flow:qualified-lead');

  const signature = workflowTriggerPayloadHash({
    type: 'crm.lead.qualified',
    filter: { region: 'west' },
    dedupeKeyTemplate: 'lead-{{payload.id}}',
  }).slice(0, 16);
  const event = definitions.find((item) => item.sourceKind === 'workflow_event');
  assert.equal(
    event?.id,
    `workflow_event:system_event:lead-flow:crm.lead.qualified:${signature}`,
  );
});

test('monitor, check-in, and background adapters stay read-only and omit disabled or terminal work', () => {
  const monitors = monitorProspectiveDefinitions({
    ...DEFAULT_PROACTIVITY_POLICY,
    inboxWatchEnabled: true,
    calendarWatchEnabled: false,
  });
  assert.deepEqual(monitors.map((item) => item.id), ['monitor:inbox']);
  assert.equal(monitors[0]?.risk, 'read');

  const checkIn: CheckInTemplate = {
    id: 'check-a',
    name: 'Monday review',
    description: 'Review launch progress',
    agentSlug: 'clem',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'Want to review the launch?',
    urgency: 'normal',
    cooldownHours: 24,
    enabled: true,
    version: 'v1',
    createdAt: '2026-07-26T16:00:00.000Z',
    updatedAt: '2026-07-26T16:00:00.000Z',
  };
  assert.equal(checkInProspectiveDefinition(checkIn)?.id, 'check_in:check-a');
  assert.equal(checkInProspectiveDefinition({ ...checkIn, enabled: false }), null);

  const background: BackgroundTaskRecord = {
    id: 'task-a',
    title: 'Research launch options',
    prompt: 'Research launch options and report back',
    status: 'blocked',
    originSessionId: 'chat:launch',
    runSessionId: 'background:task-a',
    maxMinutes: 90,
    source: 'cli',
    createdAt: '2026-07-26T16:00:00.000Z',
    updatedAt: '2026-07-26T16:05:00.000Z',
  };
  const pendingReport = backgroundProspectiveDefinition(background);
  assert.equal(pendingReport?.id, 'background:task-a');
  assert.equal(pendingReport?.sessionId, 'chat:launch');
  assert.equal(pendingReport?.action.kind, 'report_back');
  assert.equal(backgroundProspectiveDefinition({ ...background, status: 'done' }), null);
});
