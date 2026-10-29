import { presentInboxAttention, presentInboxQuestion, type AttentionItem, type AttentionPresentationItem, type InboxNotification, type InboxUnlistedItem, type QuestionPresentationItem } from './api';

export interface SavedAttentionReceipt {
  source: 'question' | 'attention';
  id: string;
  generation: string;
  mutationToken: string;
}
export interface SavedAttentionItem extends SavedAttentionReceipt {
  title: string;
  context: string | null;
  meta: string;
  at: string;
  action: 'dismiss' | 'defer';
  until?: string;
  sessionId: string | null;
}

/** One recovery view, without turning a workflow or calendar item into a question. */
export function savedAttentionItems(questions: readonly QuestionPresentationItem[], items: readonly AttentionPresentationItem[]): SavedAttentionItem[] {
  const rows: SavedAttentionItem[] = questions.map(row => ({ source: 'question', id: row.id,
    generation: row.generation, mutationToken: row.mutationToken, title: row.question,
    context: row.context || row.unavailableReason, meta: [row.agentLabel, row.workflowName, row.projectName].filter(Boolean).join(' · '),
    at: row.askedAt, action: row.action, ...(row.until ? { until: row.until } : {}),
    sessionId: row.source === 'workflow' ? null : row.sessionId }));
  const labels = { workflow: 'Workflow', conversation: 'Conversation', calendar: 'Calendar', notification: 'Clem’s update' };
  rows.push(...items.map(row => ({ source: 'attention' as const, id: row.key,
    generation: row.generation, mutationToken: row.mutationToken, title: row.title,
    context: row.detail || null, meta: [labels[row.kind], row.projectName].filter(Boolean).join(' · '),
    at: row.createdAt, action: row.action, ...(row.until ? { until: row.until } : {}), sessionId: row.sessionId ?? null })));
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
export function matchesSavedAttention(row: SavedAttentionItem, view: 'all' | 'later' | 'dismissed', search: string): boolean {
  if (view === 'later' && row.action !== 'defer' || view === 'dismissed' && row.action !== 'dismiss') return false;
  const text = [row.title, row.context, row.meta].filter(Boolean).join(' ').toLocaleLowerCase();
  return search.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}
export function sameAttentionReceipt(current: SavedAttentionReceipt | null, expected: SavedAttentionReceipt): boolean {
  return Boolean(current && current.source === expected.source && current.id === expected.id
    && current.generation === expected.generation && current.mutationToken === expected.mutationToken);
}
export async function restoreSavedAttention(receipt: SavedAttentionReceipt): Promise<void> {
  if (receipt.source === 'attention') await presentInboxAttention(receipt.id, 'restore', receipt.generation, receipt.mutationToken);
  else await presentInboxQuestion(receipt.id, 'restore', receipt.generation, receipt.mutationToken);
}

export function notificationAttentionKey(row: Pick<InboxNotification, 'id' | 'needsYouKey' | 'context'>): string {
  return row.needsYouKey || row.context.actionItemId || `notification:${row.id}`;
}
/** A capped notification feed must not make canonical attention impossible to open. */
export function attentionFallbackRows(items: readonly AttentionItem[], notifications: readonly InboxNotification[], unlisted: readonly InboxUnlistedItem[]): InboxUnlistedItem[] {
  const represented = new Set(notifications.map(notificationAttentionKey));
  const existing = unlisted.filter(item => {
    if (represented.has(item.key)) return false;
    represented.add(item.key); return true;
  });
  const remaining = items.filter(item => {
    if (represented.has(item.key)) return false;
    represented.add(item.key); return true;
  });
  return [...existing, ...remaining.map(item => ({ key: item.key,
    kind: 'attention' as const, title: item.title, detail: item.detail, lifecycle: item.lifecycle,
    ...(item.workflow ? { workflow: item.workflow } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.runId ? { runId: item.runId } : {}) }))];
}
