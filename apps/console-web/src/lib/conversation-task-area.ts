import { delegatedTaskCard, orderDelegatedTasks, type DelegatedTask, type DelegatedTaskCardView } from '@clem/chat-engine';

export type ConversationTaskGroupKind = 'decision' | 'attention' | 'background' | 'finished' | 'stopped';
export interface ConversationTaskGroup {
  kind: ConversationTaskGroupKind;
  title: string;
  summary: string;
  tasks: DelegatedTask[];
  /** Identities of current decisions/blockers, not polling timestamps. */
  attentionKeys: string[];
  defaultOpen: boolean;
}
export type ConversationTaskExpansion = Partial<Record<ConversationTaskGroupKind, { open: boolean; seen: readonly string[] }>>;

const GROUPS: ReadonlyArray<{ kind: ConversationTaskGroupKind; title: string; defaultOpen: boolean }> = [
  { kind: 'decision', title: 'Needs your input', defaultOpen: true },
  { kind: 'attention', title: 'Needs attention', defaultOpen: true },
  { kind: 'background', title: 'Background work', defaultOpen: false },
  { kind: 'finished', title: 'Finished work', defaultOpen: false },
  { kind: 'stopped', title: 'Stopped work', defaultOpen: false },
];

function groupKind(task: DelegatedTask, card: DelegatedTaskCardView): ConversationTaskGroupKind {
  // The presenter discards cached questions and approval IDs once the task
  // leaves needs_you. A permission to resume does not prove it is running.
  if (card.question || card.approvalId) return 'decision';
  if (task.phase === 'stopped') return 'stopped';
  if (task.phase === 'finished') return card.next ? 'attention' : 'finished';
  if (task.phase === 'working' || task.phase === 'waiting_to_start' || task.phase === 'stopping') return 'background';
  // Paused, failed, and a state this client does not recognize are not success.
  return 'attention';
}

export function conversationTaskGroups(tasks: readonly DelegatedTask[]): ConversationTaskGroup[] {
  const rows = orderDelegatedTasks(tasks).map(task => ({ task, card: delegatedTaskCard(task) }));
  return GROUPS.flatMap(group => {
    const members = rows.filter(({ task, card }) => groupKind(task, card) === group.kind);
    if (members.length === 0) return [];
    const states = new Map<string, number>();
    for (const { card } of members) states.set(card.phase.label, (states.get(card.phase.label) ?? 0) + 1);
    const summary = members.length === 1
      ? `${members[0].card.title} · ${members[0].card.phase.label}`
      : [...states].map(([label, count]) => `${count} ${label.toLocaleLowerCase()}`).join(' · ');
    return [{ ...group, summary, tasks: members.map(row => row.task), attentionKeys: group.defaultOpen ? members.map(({ task, card }) => JSON.stringify([
      task.taskId, task.phase, card.question ? task.question?.id : null, card.question,
      card.approvalId, card.next?.action, card.next?.text, card.controls.answer, card.controls.resume,
    ])) : [] }];
  });
}

/** A new question is visible even if an earlier one was deliberately folded. */
export function conversationTaskGroupOpen(group: ConversationTaskGroup, preferences: ConversationTaskExpansion): boolean {
  const saved = preferences[group.kind];
  if (!saved) return group.defaultOpen;
  return saved.open || group.attentionKeys.some(key => !saved.seen.includes(key));
}

const remembered = new Map<string, ConversationTaskExpansion>();

export function readConversationTaskExpansion(conversationId?: string): ConversationTaskExpansion {
  return conversationId ? { ...remembered.get(conversationId) } : {};
}

/** Window-only view preference; never task state or an authorization. */
export function rememberConversationTaskExpansion(conversationId: string | undefined, preferences: ConversationTaskExpansion): void {
  if (!conversationId) return;
  remembered.delete(conversationId);
  remembered.set(conversationId, { ...preferences });
  if (remembered.size > 100) remembered.delete(remembered.keys().next().value!);
}
