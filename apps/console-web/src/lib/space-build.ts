/**
 * Watching Clementine build a Space — pure derivations over the space's own
 * chat stream.
 *
 * A Space is built inside its dedicated chat session (`space-<slug>`), so every
 * tool call Clem makes while building — writing the view, pulling a source,
 * editing, refreshing — already streams into that session as activity items.
 * This module turns those items into a human timeline and a build state the
 * Space screens can render live. No server, no reducer: the stream is the truth.
 */
import type { ActivityItem, ChatMessage } from './useChat';
import type { SpaceRecord } from './spaces';

export type SpaceBuildState = 'idle' | 'building' | 'needs_input' | 'built' | 'failed';

export interface SpaceBuildStep {
  id: string;
  /** Plain-language label, e.g. "Wrote the view". */
  label: string;
  /** Optional detail, e.g. the operation or row count Clem reported. */
  detail?: string;
  status: ActivityItem['status'];
  kind: 'write' | 'read' | 'plan' | 'discover' | 'delegate' | 'check' | 'other';
}

const SPACE_TOOL_LABELS: Record<string, { label: string; kind: SpaceBuildStep['kind'] }> = {
  space_save: { label: 'Wrote the Space', kind: 'write' },
  space_edit_view: { label: 'Edited the view', kind: 'write' },
  space_set_data: { label: 'Stored data', kind: 'write' },
  space_edit_runner: { label: 'Edited a data runner', kind: 'write' },
  space_refresh: { label: 'Pulled fresh data', kind: 'read' },
  space_get: { label: 'Checked the Space', kind: 'read' },
  space_get_view: { label: 'Read the view', kind: 'read' },
  space_history: { label: 'Read the data history', kind: 'read' },
  space_publish: { label: 'Published a share snapshot', kind: 'write' },
  tool_search: { label: 'Finding the right tool', kind: 'discover' },
  composio_search_tools: { label: 'Finding the right tool', kind: 'discover' },
  check_capability: { label: 'Checking a capability', kind: 'discover' },
  plan_task: { label: 'Planning the build', kind: 'plan' },
  publish_plan: { label: 'Publishing the plan', kind: 'plan' },
  run_worker: { label: 'Delegated part of the work', kind: 'delegate' },
  memory_recall_all: { label: 'Checking what I know', kind: 'read' },
  memory_search: { label: 'Checking what I know', kind: 'read' },
  workflow_get: { label: 'Reading a workflow', kind: 'read' },
  workflow_run: { label: 'Ran a workflow', kind: 'other' },
};

function humanizeOperation(raw: string): string {
  // OUTLOOK_GET_CALENDAR_VIEW → "outlook: get calendar view"
  const m = /^([A-Z0-9]+)_([A-Z0-9_]+)$/.exec(raw.trim());
  if (!m) return raw.trim();
  return `${m[1]!.toLowerCase()}: ${m[2]!.toLowerCase().replace(/_/g, ' ')}`;
}

/** Turn one activity item into a Space build step, or null when it is noise. */
export function spaceBuildStepFromActivity(item: ActivityItem): SpaceBuildStep | null {
  if (item.kind === 'check') {
    return { id: item.id, label: item.label || 'Checked the result', detail: item.detail, status: item.status, kind: 'check' };
  }
  if (item.kind === 'event') {
    return { id: item.id, label: item.label, detail: item.detail, status: item.status, kind: 'other' };
  }
  if (item.kind === 'batch') {
    const meter = item.batch ? ` ${item.batch.done}/${item.batch.total}` : '';
    return { id: item.id, label: `${item.label || 'Working through items'}${meter}`, detail: item.detail, status: item.status, kind: 'delegate' };
  }
  const label = item.label.trim();
  const known = SPACE_TOOL_LABELS[label];
  if (known) return { id: item.id, label: known.label, detail: item.detail, status: item.status, kind: known.kind };
  // A provider operation the model called through a carrier.
  const op = /^(?:composio:)?([A-Z0-9]+_[A-Z0-9_]+)$/.exec(label)?.[1] ?? /^([A-Z0-9]+_[A-Z0-9_]+)/.exec(item.detail ?? '')?.[1];
  if (op) {
    const verb = /(GET|LIST|SEARCH|FETCH|READ|FIND|VIEW)/.test(op) ? 'Read' : 'Called';
    return { id: item.id, label: `${verb} ${humanizeOperation(op)}`, detail: item.detail, status: item.status, kind: verb === 'Read' ? 'read' : 'other' };
  }
  if (label === 'call_tool' || label === 'work_call') return null; // the carrier; its target shows as its own item
  if (item.kind === 'agent') return { id: item.id, label: label || 'Delegated work', detail: item.detail, status: item.status, kind: 'delegate' };
  return { id: item.id, label: label.replace(/_/g, ' '), detail: item.detail, status: item.status, kind: 'other' };
}

function lastAssistant(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === 'assistant') return messages[i];
  return undefined;
}

/** The current build state of a Space, read from its chat stream. */
export function spaceBuildState(messages: readonly ChatMessage[]): SpaceBuildState {
  const last = lastAssistant(messages);
  if (!last) return 'idle';
  switch (last.status) {
    case 'awaiting-reply':
    case 'awaiting-approval':
    case 'awaiting-plan':
      return 'needs_input';
    case 'failed': return 'failed';
    case 'complete': return 'built';
    case 'stopped': return 'failed';
    default:
      // The live bubble (thinking) is the build in progress.
      return 'building';
  }
}

/** The steps of the most recent build turn, oldest first. */
export function spaceBuildSteps(messages: readonly ChatMessage[]): SpaceBuildStep[] {
  const last = lastAssistant(messages);
  if (!last?.activity) return [];
  const steps: SpaceBuildStep[] = [];
  for (const item of last.activity) {
    const step = spaceBuildStepFromActivity(item);
    if (!step) continue;
    const prev = steps[steps.length - 1];
    if (prev && prev.label === step.label && prev.status === step.status && step.kind === 'discover') continue; // collapse repeated searches
    steps.push(step);
  }
  return steps;
}

/** The latest progress line Clem reported during the build, if any. */
export function spaceBuildProgress(messages: readonly ChatMessage[]): string | undefined {
  const last = lastAssistant(messages);
  return last?.progress?.trim() || undefined;
}

/** One line that says what a Space is made of, for the built summary. */
export function describeSpaceShape(space: Partial<Pick<SpaceRecord, 'dataSources' | 'actions' | 'version'>>): string {
  const sources = space.dataSources?.length ?? 0;
  const actions = space.actions?.length ?? 0;
  const scheduled = (space.dataSources ?? []).filter((s) => Boolean((s as { schedule?: string }).schedule)).length;
  const parts = [
    `${sources} live ${sources === 1 ? 'source' : 'sources'}`,
    `${actions} ${actions === 1 ? 'action' : 'actions'}`,
    scheduled > 0 ? `${scheduled} on a schedule` : 'refreshes on demand',
  ];
  if (typeof space.version === 'number') parts.push(`v${space.version}`);
  return parts.join(' · ');
}
