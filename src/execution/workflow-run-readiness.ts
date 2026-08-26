import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { listSkills } from '../memory/skill-store.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';
import { listWorkspaceProjects } from '../tools/shared.js';
import { readCachedScan } from '../runtime/cli-discovery.js';
import { getSavedClis } from '../runtime/saved-clis.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { listMcpServerHealth, slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import {
  buildWorkflowExecutionPlan,
  type WorkflowExecutionPlan,
  type WorkflowExecutionPlanOptions,
  type WorkflowExecutionVisualContract,
  type WorkflowToolReadinessInventory,
  type WorkflowToolReadinessItem,
  type WorkflowToolReadinessKind,
} from '../dashboard/workflow-execution-plan.js';

// Only capabilities we can authoritatively verify from LOCAL state hard-block a
// run: a `usesSkill` whose skill is not installed, a `deterministic.runner`
// whose script is missing from the workflow's own scripts/, or a declared
// local project/workspace that is not available. Those genuinely cannot execute.
// A plain tool / CLI / MCP / composio "miss" is NOT
// authoritative — the runtime tool surface is broader than the local catalog
// (LOCAL_MCP_TOOL_NAMES is a subset), an `allowedTools: ['*']` grant reads as a
// literal tool named "*", and composio/MCP resolve at runtime. Hard-blocking on
// those would false-block a runnable workflow AND silently drop scheduled runs
// (the scheduler warns-and-skips on a blocked queue result), so they only
// INFORM. Guardrails inform; they don't override.
const BLOCKING_READINESS_KINDS: ReadonlySet<WorkflowToolReadinessKind> = new Set(['skill', 'script', 'project']);

/**
 * Split readiness items into hard blockers vs informational warnings, scoped to
 * one step when `targetStepId` is set. A run is blocked ONLY by a missing
 * authoritative capability (see BLOCKING_READINESS_KINDS); every other miss —
 * and every `unknown` — is surfaced as a warning so the operator sees it without
 * the run being refused.
 */
export function partitionWorkflowReadiness(
  items: WorkflowToolReadinessItem[],
  targetStepId?: string,
): { blockers: WorkflowToolReadinessItem[]; warnings: WorkflowToolReadinessItem[] } {
  const relevant = targetStepId ? items.filter((item) => item.stepIds.includes(targetStepId)) : items;
  const blockers: WorkflowToolReadinessItem[] = [];
  const warnings: WorkflowToolReadinessItem[] = [];
  for (const item of relevant) {
    if (item.status === 'ready') continue;
    if (item.status === 'missing' && BLOCKING_READINESS_KINDS.has(item.kind)) blockers.push(item);
    else warnings.push(item);
  }
  return { blockers, warnings };
}

export interface WorkflowRunReadinessCheck {
  ok: boolean;
  blockers: WorkflowToolReadinessItem[];
  warnings: WorkflowToolReadinessItem[];
  message: string;
  plan: WorkflowExecutionPlan;
}

interface WorkflowRunReadinessOptions
  extends Omit<WorkflowExecutionPlanOptions, 'workflowAllowedTools' | 'readiness'> {
  targetStepId?: string;
}

export function buildWorkflowReadinessInventory(workflowSlug?: string): WorkflowToolReadinessInventory {
  const cachedCliScan = readCachedScan();
  return {
    availableTools: compactUniqueStrings(Array.from(LOCAL_MCP_TOOL_NAMES as readonly string[])),
    availableClis: compactUniqueStrings([
      ...getSavedClis(),
      ...(cachedCliScan?.detected ?? []).map((cli) => cli.command),
      ...(cachedCliScan?.clis ?? []).map((cli) => cli.command),
    ]),
    installedSkills: listSkills().map((skill) => skill.name),
    workflowScripts: workflowSlug ? listWorkflowScriptNames(workflowSlug) : undefined,
    mcpServers: workflowMcpReadinessServers(),
    workspaceProjects: workflowWorkspaceReadinessProjects(),
  };
}

export function buildWorkflowExecutionPlanWithReadiness(
  def: WorkflowDefinition,
  workflowSlug?: string,
  options: Omit<WorkflowExecutionPlanOptions, 'workflowAllowedTools' | 'readiness'> = {},
): WorkflowExecutionPlan {
  return buildWorkflowExecutionPlan(def.steps, {
    ...options,
    workflowAllowedTools: def.allowedTools,
    workflowProject: def.project,
    workflowGoal: def.goal,
    readiness: buildWorkflowReadinessInventory(workflowSlug),
  });
}

export function checkWorkflowRunReadiness(
  def: WorkflowDefinition,
  workflowSlug?: string,
  options: WorkflowRunReadinessOptions = {},
): WorkflowRunReadinessCheck {
  const { targetStepId, ...planOptions } = options;
  const plan = buildWorkflowExecutionPlanWithReadiness(def, workflowSlug, planOptions);
  const capabilityReadiness = partitionWorkflowReadiness(plan.toolReadiness.items, targetStepId);
  // A declared deterministic.runner / loopUntil.probe.runner is authoritative
  // via the SAME 'script' readiness item buildWorkflowExecutionPlan already
  // emits (workflow-execution-plan.ts, source 'deterministic_runner' /
  // 'loop_probe_runner') by checking the script's actual presence under the
  // workflow's own scripts/ directory — 'script' is already in
  // BLOCKING_READINESS_KINDS above, so a genuinely missing script already
  // hard-blocks. 60db67d8 (2026-08-25) briefly layered an unconditional
  // "retired" blocker on top of this — and filtered the real script-existence
  // item OUT of blockers to make room for it — refusing every declaration
  // whether or not its script existed, which starved 5 live owner workflows
  // (3 on live cron schedules) of a run record entirely. Restored: this
  // function trusts the existing, narrower, already-correct check again.
  const resourceReadiness = requiredResourceReadiness(def);
  const blockers = [...capabilityReadiness.blockers, ...resourceReadiness.blockers];
  const warnings = [...capabilityReadiness.warnings, ...resourceReadiness.warnings];
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    message: renderWorkflowRunReadinessMessage(def.name, blockers, warnings),
    plan,
  };
}

const SAFE_ACCOUNT_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,254}$/;

function requiredResourceReadiness(
  def: WorkflowDefinition,
): { blockers: WorkflowToolReadinessItem[]; warnings: WorkflowToolReadinessItem[] } {
  const blockers: WorkflowToolReadinessItem[] = [];
  const warnings: WorkflowToolReadinessItem[] = [];
  const stepIds = compactUniqueStrings((def.steps ?? []).map((step) => step.id));

  for (const [fallbackId, resource] of Object.entries(def.resources ?? {})) {
    if (resource.required !== true || resource.kind !== 'account') continue;
    const cli = resource.cli?.trim().toLowerCase();
    if (!cli) continue;
    const resourceId = resource.id?.trim() || fallbackId;
    if (cli !== 'sf') {
      warnings.push(resourceProbeItem({
        resourceId,
        cli,
        status: 'unknown',
        reason: `Required account resource "${resourceId}" uses CLI "${cli}"; no authoritative local account snapshot is available for it yet.`,
        detail: 'unsupported account CLI; execution must verify through its admitted transport',
        stepIds,
      }));
      continue;
    }

    const account = resource.account?.trim();
    if (!account || !SAFE_ACCOUNT_SELECTOR.test(account)) {
      blockers.push(resourceProbeItem({
        resourceId,
        cli,
        status: 'unknown',
        reason: `Required account "${resourceId}" (${cli}) cannot be verified because its durable account selector is missing or invalid.`,
        detail: 'workflow readiness performed zero provider or CLI process calls',
        stepIds,
      }));
      continue;
    }

    // connected-clis.json proves only that the binary was registered, while
    // cli-auth-health.json is a generic, staleable cache and the Salesforce
    // catalog has no exact-org auth probe. Neither can attest this selector.
    // Readiness also owns no physical provider/CLI authority, so it must not
    // execute `sf org display` or `sf org list`. Fail closed until an admitted
    // carrier can provide a bounded, exact-account snapshot.
    blockers.push(resourceProbeItem({
      resourceId,
      cli,
      status: 'unknown',
      reason: `Required account "${account}" (${cli}) cannot be verified without an admitted exact-account read; workflow readiness has no provider or CLI execution authority.`,
      detail: 'zero provider or CLI process calls were attempted',
      stepIds,
    }));
  }

  return { blockers, warnings };
}

function resourceProbeItem(input: {
  resourceId: string;
  cli: string;
  status: 'missing' | 'unknown';
  reason: string;
  detail: string;
  stepIds: string[];
  /** The exact read-only command that produced this evidence, when known. */
  probeName?: string;
}): WorkflowToolReadinessItem {
  return {
    kind: 'cli',
    name: `${input.cli}:${input.resourceId}`,
    status: input.status,
    reason: input.reason,
    stepIds: input.stepIds,
    evidence: [{
      kind: 'cli_command',
      name: input.probeName ?? input.cli,
      status: input.status,
      detail: conciseProbeDetail(input.detail),
    }],
  };
}


function conciseProbeDetail(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}

export function renderWorkflowVisualContract(
  planOrContract: WorkflowExecutionPlan | WorkflowExecutionVisualContract | undefined | null,
  options: { includePasses?: boolean; maxChecks?: number; maxRemediations?: number } = {},
): string {
  const contract = isWorkflowExecutionPlan(planOrContract)
    ? planOrContract.visualContract
    : planOrContract;
  if (!contract) return '';
  const includePasses = options.includePasses === true;
  const maxChecks = Math.max(1, Math.min(10, Math.trunc(Number(options.maxChecks ?? 6))));
  const maxRemediations = Math.max(1, Math.min(10, Math.trunc(Number(options.maxRemediations ?? 6))));
  const status = contract.status.toUpperCase();
  const checks = (contract.checks ?? [])
    .filter((check) => includePasses || check.status !== 'pass')
    .slice(0, maxChecks);
  const remediations = (contract.remediations ?? []).slice(0, maxRemediations);
  const lines = [
    `Workflow visual contract: ${status} (${contract.blockedCount} block, ${contract.warningCount} warning, ${contract.passCount} pass).`,
    contract.summary,
  ];
  for (const check of checks) {
    const evidence = check.evidence.length ? ` Evidence: ${check.evidence.slice(0, 3).join('; ')}` : '';
    const steps = check.stepIds.length ? ` Steps: ${check.stepIds.slice(0, 6).join(', ')}.` : '';
    lines.push(`- [${check.status.toUpperCase()}] ${check.label}: ${check.detail}${steps}${evidence}`);
  }
  if (!includePasses && checks.length === 0) {
    lines.push('- All visible contract checks passed.');
  }
  if (remediations.length > 0) {
    lines.push('Recommended contract fixes:');
    for (const fix of remediations) {
      const evidence = fix.evidence.length ? ` Evidence: ${fix.evidence.slice(0, 3).join('; ')}` : '';
      const steps = fix.stepIds.length ? ` Steps: ${fix.stepIds.slice(0, 6).join(', ')}.` : '';
      const actions = Array.isArray(fix.actions) && fix.actions.length
        ? ` Actions: ${fix.actions.slice(0, 3).map((action) => action.command ? `${action.label} (${action.command})` : action.label).join('; ')}.`
        : '';
      lines.push(`- [${fix.status.toUpperCase()}] ${fix.title}: ${fix.detail}${steps}${evidence}${actions}`);
    }
  }
  return lines.join('\n');
}

export function renderWorkflowRunReadinessMessage(
  workflowName: string,
  blockers: WorkflowToolReadinessItem[],
  warnings: WorkflowToolReadinessItem[] = [],
): string {
  if (blockers.length === 0) {
    if (warnings.length === 0) return `Workflow "${workflowName}" readiness preflight passed.`;
    return [
      `Workflow "${workflowName}" readiness preflight has ${warnings.length} unconfirmed capabilit${warnings.length === 1 ? 'y' : 'ies'}, but no missing required capability.`,
      ...warnings.slice(0, 6).map((item) => `- ${formatReadinessItem(item)}`),
    ].join('\n');
  }
  const lines = [
    `Workflow "${workflowName}" was not queued because required capabilit${blockers.length === 1 ? 'y is' : 'ies are'} missing:`,
    ...blockers.slice(0, 8).map((item) => `- ${formatReadinessItem(item)}`),
  ];
  if (blockers.length > 8) lines.push(`- ...and ${blockers.length - 8} more.`);
  if (warnings.length > 0) {
    lines.push(`Unconfirmed but not blocking: ${warnings.slice(0, 4).map((item) => `${item.kind}:${item.name}`).join(', ')}.`);
  }
  lines.push('Fix or reconnect the missing capabilities, then run the workflow again.');
  return lines.join('\n');
}

function isWorkflowExecutionPlan(value: unknown): value is WorkflowExecutionPlan {
  return Boolean(value && typeof value === 'object' && 'visualContract' in value && 'toolReadiness' in value);
}

function formatReadinessItem(item: WorkflowToolReadinessItem): string {
  const steps = item.stepIds.length ? ` (step${item.stepIds.length === 1 ? '' : 's'}: ${item.stepIds.join(', ')})` : '';
  const sources = Array.isArray(item.sources) && item.sources.length
    ? ` via ${item.sources.map(readinessSourceLabel).join(', ')}`
    : '';
  const evidence = Array.isArray(item.evidence) && item.evidence.length
    ? ` Evidence: ${item.evidence.slice(0, 3).map((entry) => {
      const detail = entry.detail ? ` (${entry.detail})` : '';
      return `${entry.kind}:${entry.name}=${entry.status}${detail}`;
    }).join('; ')}`
    : '';
  return `${item.kind} "${item.name}"${steps}${sources} - ${item.reason}${evidence}`;
}

function readinessSourceLabel(source: string): string {
  switch (source) {
    case 'workflow_allowed_tool': return 'workflow tools';
    case 'step_allowed_tool': return 'step tools';
    case 'step_call': return 'direct call';
    case 'deterministic_runner': return 'deterministic runner';
    case 'loop_probe_runner': return 'loop probe';
    case 'uses_skill': return 'skill';
    case 'workflow_project': return 'workflow project';
    case 'step_project': return 'step project';
    default: return source.replace(/_/g, ' ');
  }
}

function workflowMcpReadinessServers(): WorkflowToolReadinessInventory['mcpServers'] {
  try {
    const health = listMcpServerHealth();
    const seen = new Set<string>();
    const configured = discoverMcpServers().map((server) => {
      const slug = slugifyServerName(server.name);
      const h = health.find((item) => item.slug === slug || item.name === server.name);
      seen.add(slug);
      return {
        name: server.name,
        slug,
        enabled: server.enabled !== false,
        state: h?.state ?? 'unknown',
        toolCount: h?.toolCount ?? 0,
      };
    });
    const healthOnly = health
      .filter((server) => !seen.has(server.slug))
      .map((server) => ({
        name: server.name,
        slug: server.slug,
        enabled: true,
        state: server.state,
        toolCount: server.toolCount,
      }));
    return [...configured, ...healthOnly];
  } catch {
    return [];
  }
}

function workflowWorkspaceReadinessProjects(): WorkflowToolReadinessInventory['workspaceProjects'] {
  try {
    return listWorkspaceProjects().map((project) => ({
      name: project.name,
      path: project.path,
      type: project.type,
    }));
  } catch {
    return [];
  }
}

export function listWorkflowScriptNames(workflowSlug: string): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(workflowSlug)) return [];
  const scriptsDir = path.join(WORKFLOWS_DIR, workflowSlug, 'scripts');
  if (!existsSync(scriptsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix = '') => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  try {
    walk(scriptsDir);
  } catch {
    return [];
  }
  return compactUniqueStrings(out);
}

function compactUniqueStrings(items: Array<string | undefined | null>): string[] {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}
