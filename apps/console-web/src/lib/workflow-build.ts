/**
 * Watching a workflow being created — the pure half. The authoring chat
 * streams the model's own `workflow_create` / `workflow_update` call, and the
 * call's arguments ARE the definition taking shape: name, trigger, steps with
 * their effects and approval gates. So the canvas can show the draft the
 * moment the model commits to it, before the write lands, and then swap to
 * the stored definition once the tool returns. Same principle as
 * `space-build.ts`: the stream is the truth, nothing is invented.
 */
import type { ChatMessage, ActivityItem } from './useChat';

export const WORKFLOW_AUTHORING_TOOLS = new Set([
  'workflow_create', 'workflow_update', 'workflow_from_session', 'workflow_apply_contract_fixes', 'workflow_schedule',
]);

export interface WorkflowDraftStep {
  id: string;
  purpose: string;
  effect: 'read' | 'write' | 'send' | 'unknown';
  gated: boolean;
  tool?: string;
  skill?: string;
  dependsOn: string[];
}

export interface WorkflowDraft {
  name: string;
  description: string;
  schedule?: string;
  timezone?: string;
  steps: WorkflowDraftStep[];
  goal?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v) as unknown; return asRecord(parsed); } catch { return null; }
  }
  return null;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The definition in an authoring tool call's arguments; null when the call is not one. */
export function workflowDraftFromArgs(tool: string, args: unknown): WorkflowDraft | null {
  if (!WORKFLOW_AUTHORING_TOOLS.has(tool)) return null;
  const a = asRecord(args);
  if (!a) return null;
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  const steps: WorkflowDraftStep[] = rawSteps.map((s, i) => {
    const r = asRecord(s) ?? {};
    const call = asRecord(r.call);
    const effect = str(r.sideEffect);
    return {
      id: str(r.id) || `step-${i + 1}`,
      purpose: (str(r.prompt) || str(r.name)).split('\n')[0].slice(0, 140),
      effect: effect === 'read' || effect === 'write' || effect === 'send' ? effect : 'unknown',
      gated: r.requiresApproval === true,
      ...(call && str(call.tool) ? { tool: str(call.tool) } : {}),
      ...(str(r.usesSkill) ? { skill: str(r.usesSkill) } : {}),
      dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn.filter((d): d is string => typeof d === 'string') : [],
    };
  });
  const goal = asRecord(a.goal);
  const name = str(a.name);
  if (!name && steps.length === 0) return null;
  return {
    name,
    description: str(a.description),
    ...(str(a.trigger_schedule) ? { schedule: str(a.trigger_schedule) } : {}),
    ...(str(a.trigger_timezone) ? { timezone: str(a.trigger_timezone) } : {}),
    steps,
    ...(goal && str(goal.objective) ? { goal: str(goal.objective) } : {}),
  };
}

export type WorkflowBuildState = 'idle' | 'drafting' | 'writing' | 'testing' | 'written' | 'failed';

export interface WorkflowBuild {
  state: WorkflowBuildState;
  /** The newest draft the model committed to (from its own call). */
  draft: WorkflowDraft | null;
  /** The name once a write succeeded — the canvas fetches the stored definition. */
  writtenName: string | null;
}

/** Fold the conversation into a build state. The newest assistant message wins. */
export function workflowBuildFromMessages(messages: readonly ChatMessage[]): WorkflowBuild {
  let draft: WorkflowDraft | null = null;
  let writtenName: string | null = null;
  let state: WorkflowBuildState = 'idle';
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const row of m.activity ?? []) {
      const d = row.draft;
      if (!d) continue;
      draft = d;
      if (row.status === 'running') state = 'writing';
      else if (row.status === 'done') { state = 'written'; writtenName = d.name || writtenName; }
      else state = 'failed';
    }
    if (m.status === 'thinking' && state === 'idle') state = 'drafting';
    // A creation test after the write: the bridged workflow step rows.
    if (state === 'written' && (m.activity ?? []).some((row) => row.kind === 'event' && row.id.startsWith('step-') && row.status === 'running')) state = 'testing';
  }
  return { state, draft, writtenName };
}

/** The label the build card shows for a workflow authoring row. */
export function authoringRowLabel(row: Pick<ActivityItem, 'label' | 'draft'>): string {
  if (!row.draft) return row.label;
  const n = row.draft.steps.length;
  return `${row.draft.name ? `Writing “${row.draft.name}”` : 'Writing the workflow'} · ${n} step${n === 1 ? '' : 's'}`;
}
