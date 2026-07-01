import { listWorkflows } from '../memory/workflow-store.js';
import { validateWorkflowDefinition, type WorkflowFrontmatter } from '../execution/workflow-validator.js';
import { collectDiagnostics } from './diagnostics.js';
import { getProactivityPolicySnapshot } from '../agents/proactivity-policy.js';
import { listActiveScopes, listStandingGrants } from '../agents/plan-scope.js';
import { loadTeamAgents } from '../tools/shared.js';
import { listWorkflowPatterns } from '../memory/workflow-pattern-store.js';
import { listRuns } from '../runtime/run-events.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { statSync } from 'node:fs';

export type HarnessAuditStatus = 'pass' | 'warn' | 'fail';

export interface HarnessAuditCheck {
  id: string;
  title: string;
  status: HarnessAuditStatus;
  detail: string;
  impact: 'low' | 'medium' | 'high';
}

export interface HarnessAuditSection {
  id: 'tools' | 'workflows' | 'approvals' | 'agents' | 'learning';
  title: string;
  score: number;
  checks: HarnessAuditCheck[];
}

export interface HarnessAuditSnapshot {
  generatedAt: string;
  score: number;
  summary: { pass: number; warn: number; fail: number };
  sections: HarnessAuditSection[];
}

function check(
  id: string,
  title: string,
  status: HarnessAuditStatus,
  detail: string,
  impact: HarnessAuditCheck['impact'] = 'medium',
): HarnessAuditCheck {
  return { id, title, status, detail, impact };
}

function scoreChecks(checks: HarnessAuditCheck[]): number {
  const total = checks.reduce((sum, item) => sum + weight(item), 0);
  if (total === 0) return 100;
  const lost = checks.reduce((sum, item) => {
    if (item.status === 'pass') return sum;
    const severity = item.status === 'fail' ? 1 : 0.45;
    return sum + weight(item) * severity;
  }, 0);
  return Math.max(0, Math.round(100 - (lost / total) * 100));
}

function weight(check: HarnessAuditCheck): number {
  switch (check.impact) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low':
    default: return 1;
  }
}

function section(id: HarnessAuditSection['id'], title: string, checks: HarnessAuditCheck[]): HarnessAuditSection {
  return { id, title, score: scoreChecks(checks), checks };
}

function mutatingStepWithoutSideEffect(prompt: string): boolean {
  return /\b(send|email|publish|post|upload|create|update|write|append|delete|archive|deploy)\b/i.test(prompt);
}

function buildToolChecks(): HarnessAuditCheck[] {
  const diagnostics = collectDiagnostics();
  const mcp = diagnostics.mcp.summary;
  const loopSessions = diagnostics.toolEvents.bySession.filter((session) => session.suspectedPattern === 'per-row-loop');
  return [
    check(
      'mcp-health',
      'MCP server health',
      mcp.unavailable > 0 || mcp.degraded > 0 ? 'fail' : mcp.connecting > 0 ? 'warn' : 'pass',
      `${mcp.connected}/${mcp.total} connected, ${mcp.degraded} degraded, ${mcp.unavailable} unavailable.`,
      mcp.unavailable > 0 ? 'high' : 'medium',
    ),
    check(
      'tool-session-scope',
      'Tool calls are session-scoped',
      diagnostics.toolEvents.unscopedEvents > 0 ? 'warn' : 'pass',
      diagnostics.toolEvents.unscopedEvents > 0
        ? `${diagnostics.toolEvents.unscopedEvents} tool event(s) were unscoped today, weakening trace-to-pattern learning.`
        : 'All tool events today had a usable session bucket.',
      'medium',
    ),
    check(
      'loop-vs-batch',
      'Batching habits',
      loopSessions.length > 0 ? 'warn' : 'pass',
      loopSessions.length > 0
        ? `${loopSessions.length} session(s) look like per-row loops; batch tools or forEach workflows may cut cost/latency.`
        : 'No obvious per-row tool-loop sessions in today\'s telemetry.',
      'low',
    ),
  ];
}

function buildWorkflowChecks(): HarnessAuditCheck[] {
  const workflows = listWorkflows();
  const validations = workflows
    .map((workflow) => ({ workflow, validation: validateWorkflowDefinition(workflow.data as unknown as WorkflowFrontmatter) }));
  const enabled = workflows.filter((workflow) => workflow.data.enabled !== false);
  const enabledValidations = validations.filter((item) => item.workflow.data.enabled !== false);
  const invalid = enabledValidations.filter((item) => !item.validation.ok);
  const warnCount = enabledValidations
    .map((item) => item.validation.warnings.length)
    .reduce((sum, count) => sum + count, 0);
  const disabledWarnCount = validations
    .filter((item) => item.workflow.data.enabled === false)
    .map((item) => item.validation.warnings.length)
    .reduce((sum, count) => sum + count, 0);
  const scheduledWithoutTimezone = enabled.filter((workflow) => workflow.data.trigger?.schedule && !workflow.data.trigger.timezone);
  const riskyUndeclared = workflows.flatMap((workflow) =>
    workflow.data.steps
      .filter((step) => !step.sideEffect && mutatingStepWithoutSideEffect(step.prompt))
      .map((step) => `${workflow.data.name}:${step.id}`),
  );
  const withoutGoal = enabled.filter((workflow) => !workflow.data.goal?.objective);
  return [
    check(
      'workflow-inventory',
      'Workflow inventory',
      workflows.length === 0 ? 'warn' : 'pass',
      workflows.length === 0 ? 'No workflows found.' : `${workflows.length} workflow(s), ${enabled.length} enabled.`,
      'low',
    ),
    check(
      'workflow-validation',
      'Workflow validation',
      invalid.length > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass',
      invalid.length > 0
        ? `${invalid.length} workflow(s) have blocking validation errors.`
        : warnCount > 0
          ? `${warnCount} workflow validator warning(s) across enabled workflows${disabledWarnCount > 0 ? ` (${disabledWarnCount} warning(s) on disabled drafts ignored).` : '.'}`
          : 'All workflows pass structural validation cleanly.',
      invalid.length > 0 ? 'high' : 'medium',
    ),
    check(
      'workflow-timezones',
      'Scheduled workflow timezones',
      scheduledWithoutTimezone.length > 0 ? 'warn' : 'pass',
      scheduledWithoutTimezone.length > 0
        ? `${scheduledWithoutTimezone.length} scheduled workflow(s) rely on host-local timezone.`
        : 'Scheduled workflows declare timezone or none are scheduled.',
      'medium',
    ),
    check(
      'workflow-side-effects',
      'Side-effect declarations',
      riskyUndeclared.length > 0 ? 'warn' : 'pass',
      riskyUndeclared.length > 0
        ? `${riskyUndeclared.length} mutating-looking step(s) omit sideEffect: ${riskyUndeclared.slice(0, 5).join(', ')}.`
        : 'Mutating-looking steps are explicitly classified or absent.',
      'high',
    ),
    check(
      'workflow-goals',
      'Pinned goals',
      withoutGoal.length > 0 ? 'warn' : 'pass',
      withoutGoal.length > 0
        ? `${withoutGoal.length} enabled workflow(s) lack a pinned run goal; completion may not equal success.`
        : 'Enabled workflows have pinned goals or no enabled workflows exist.',
      'medium',
    ),
  ];
}

function buildApprovalChecks(): HarnessAuditCheck[] {
  const policy = getProactivityPolicySnapshot().policy;
  const activeScopes = listActiveScopes();
  const standingGrants = listStandingGrants();
  let pending = 0;
  let stalePending = 0;
  try {
    const rows = approvalRegistry.listPending({ status: 'pending' });
    pending = rows.length;
    const staleCutoff = Date.now() - 60 * 60_000;
    stalePending = rows.filter((row) => Date.parse(row.requestedAt) < staleCutoff).length;
  } catch {
    pending = 0;
    stalePending = 0;
  }
  const wildcardScopes = activeScopes.filter((scope) => scope.allowedTools.includes('*'));
  return [
    check(
      'approval-scope',
      'Approval scope policy',
      policy.autoApproveScope === 'yolo' ? 'warn' : 'pass',
      `Current scope is ${policy.autoApproveScope}.`,
      policy.autoApproveScope === 'yolo' ? 'high' : 'low',
    ),
    check(
      'pending-approvals',
      'Pending approvals',
      stalePending > 0 ? 'fail' : pending > 0 ? 'warn' : 'pass',
      stalePending > 0
        ? `${stalePending}/${pending} pending approval(s) are older than 1 hour.`
        : pending > 0
          ? `${pending} approval(s) are waiting on the user.`
          : 'No pending approvals.',
      stalePending > 0 ? 'high' : 'medium',
    ),
    check(
      'plan-scopes',
      'Plan-scope auto-approval windows',
      wildcardScopes.length > 0 ? 'warn' : 'pass',
      wildcardScopes.length > 0
        ? `${wildcardScopes.length} active plan scope(s) allow all tools; verify they are still intentional.`
        : `${activeScopes.length} active plan scope(s), none wildcarded.`,
      'medium',
    ),
    check(
      'standing-grants',
      'Standing grants',
      standingGrants.length > 0 ? 'warn' : 'pass',
      standingGrants.length > 0
        ? `${standingGrants.length} durable grant(s) can auto-approve read/write-class tools.`
        : 'No durable standing grants.',
      'medium',
    ),
  ];
}

function buildAgentChecks(): HarnessAuditCheck[] {
  const agents = loadTeamAgents();
  const known = new Set(['clementine', ...agents.map((agent) => agent.slug)]);
  const danglingMessages = agents.flatMap((agent) => agent.canMessage.filter((slug) => !known.has(slug)).map((slug) => `${agent.slug}->${slug}`));
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60_000;
  const workflowEditedAt = new Map<string, number>();
  for (const workflow of listWorkflows()) {
    try {
      const editedMs = statSync(workflow.filePath).mtimeMs;
      workflowEditedAt.set(workflow.name, editedMs);
      workflowEditedAt.set(workflow.data.name, editedMs);
    } catch {
      // Missing stat should not hide a failed run.
    }
  }
  const latestRunsByWorkstream = new Map<string, ReturnType<typeof listRuns>[number]>();
  for (const run of listRuns(80)) {
    const updatedMs = Date.parse(run.updatedAt || run.createdAt);
    if (Number.isFinite(updatedMs) && updatedMs < recentCutoff) continue;
    const key = `${run.source}:${run.title || run.id}`;
    const current = latestRunsByWorkstream.get(key);
    const currentMs = current ? Date.parse(current.updatedAt || current.createdAt) : 0;
    if (!current || updatedMs >= currentMs) latestRunsByWorkstream.set(key, run);
  }
  const blockedCandidates = Array.from(latestRunsByWorkstream.values()).filter((run) => run.status === 'failed' || run.needsAttention);
  const stalePreEditRuns = blockedCandidates.filter((run) => {
    if (run.source !== 'workflow') return false;
    const workflowName = (run.title || '').replace(/^Workflow:\s*/, '').trim();
    const editedAt = workflowEditedAt.get(workflowName);
    if (!editedAt) return false;
    const runUpdated = Date.parse(run.updatedAt || run.createdAt);
    return Number.isFinite(runUpdated) && editedAt > runUpdated + 1000;
  });
  const blockedRuns = blockedCandidates.filter((run) => !stalePreEditRuns.includes(run));
  const proactiveWithoutTools = agents.filter((agent) => agent.autonomyEnabled && (agent.allowedTools ?? []).length === 0);
  return [
    check(
      'agent-roster',
      'Agent roster',
      agents.length === 0 ? 'warn' : 'pass',
      agents.length === 0 ? 'No team agents configured.' : `${agents.length} team agent(s) configured.`,
      'low',
    ),
    check(
      'agent-message-graph',
      'Agent message graph',
      danglingMessages.length > 0 ? 'fail' : 'pass',
      danglingMessages.length > 0
        ? `Dangling canMessage edge(s): ${danglingMessages.slice(0, 8).join(', ')}.`
        : 'Agent canMessage edges resolve to known agents.',
      'medium',
    ),
    check(
      'agent-tools',
      'Autonomous agent tool bounds',
      proactiveWithoutTools.length > 0 ? 'warn' : 'pass',
      proactiveWithoutTools.length > 0
        ? `${proactiveWithoutTools.length} autonomous agent(s) have no explicit allowedTools list.`
        : 'Autonomous agents have explicit tool bounds or none are active.',
      'high',
    ),
    check(
      'recent-run-health',
      'Recent run health',
      blockedRuns.length > 0 ? 'warn' : 'pass',
      blockedRuns.length > 0
        ? `${blockedRuns.length} current workstream(s) have a failed or needs-attention latest run in the last 7 days${stalePreEditRuns.length > 0 ? ` (${stalePreEditRuns.length} stale pre-edit workflow run(s) ignored).` : '.'}`
        : stalePreEditRuns.length > 0
          ? `No current workstreams have failed/needs-attention latest runs in the last 7 days (${stalePreEditRuns.length} stale pre-edit workflow run(s) ignored).`
          : 'No current workstreams have failed/needs-attention latest runs in the last 7 days.',
      'medium',
    ),
  ];
}

function buildLearningChecks(): HarnessAuditCheck[] {
  const patterns = listWorkflowPatterns();
  const latestWorkflowRuns = new Map<string, ReturnType<typeof listRuns>[number]>();
  for (const run of listRuns(80).filter((item) => item.source === 'workflow')) {
    const key = run.title?.replace(/^Workflow:\s*/, '') || run.id;
    const current = latestWorkflowRuns.get(key);
    const runMs = Date.parse(run.updatedAt || run.createdAt);
    const currentMs = current ? Date.parse(current.updatedAt || current.createdAt) : 0;
    if (!current || runMs >= currentMs) latestWorkflowRuns.set(key, run);
  }
  const currentCleanWorkflowCount = Array.from(latestWorkflowRuns.values())
    .filter((run) => run.status === 'completed' && !run.needsAttention)
    .length;
  const patternCoverageWarn = patterns.length === 0
    ? currentCleanWorkflowCount > 0
    : currentCleanWorkflowCount > patterns.length;
  return [
    check(
      'workflow-patterns',
      'Workflow pattern memory',
      patterns.length === 0 && currentCleanWorkflowCount > 0 ? 'warn' : 'pass',
      patterns.length === 0
        ? currentCleanWorkflowCount > 0
          ? 'Current clean workflow streams exist, but no workflow patterns have been recorded yet.'
          : 'No workflow pattern memory yet; it will fill after clean workflow runs.'
        : `${patterns.length} learned workflow pattern(s) available for procedural recall.`,
      'medium',
    ),
    check(
      'pattern-coverage',
      'Pattern coverage',
      patternCoverageWarn ? 'warn' : 'pass',
      patterns.length > 0
        ? `${patterns.length} pattern(s) cover ${currentCleanWorkflowCount} current clean workflow stream(s).`
        : 'Pattern coverage starts after the first current clean workflow completion.',
      'low',
    ),
  ];
}

export function collectHarnessAudit(): HarnessAuditSnapshot {
  const sections = [
    section('tools', 'Tools And Telemetry', buildToolChecks()),
    section('workflows', 'Workflows', buildWorkflowChecks()),
    section('approvals', 'Approvals', buildApprovalChecks()),
    section('agents', 'Agents', buildAgentChecks()),
    section('learning', 'Learning Loop', buildLearningChecks()),
  ];
  const allChecks = sections.flatMap((item) => item.checks);
  return {
    generatedAt: new Date().toISOString(),
    score: scoreChecks(allChecks),
    summary: {
      pass: allChecks.filter((item) => item.status === 'pass').length,
      warn: allChecks.filter((item) => item.status === 'warn').length,
      fail: allChecks.filter((item) => item.status === 'fail').length,
    },
    sections,
  };
}
