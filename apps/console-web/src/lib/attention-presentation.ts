import { apiGet, apiPost } from './api';
import { unifiedChatSessionId } from './last-session';

export interface AttentionLifecycle {
  canDismiss: boolean;
  canDefer: boolean;
  effect: 'hide_only';
  dismissLabel: string;
  deferLabel: string;
  generation: string;
  explanation: string;
}

/** Server-owned asks that have no approval, plan or answer authority here. */
export interface AttentionItem {
  key: string;
  kind: 'workflow' | 'conversation' | 'calendar' | 'notification';
  title: string;
  detail: string;
  createdAt: string;
  notificationId?: string;
  sessionId?: string;
  runId?: string;
  workflow?: string;
  workflowSlug?: string;
  projectId?: string;
  lifecycle: AttentionLifecycle;
}
export interface AttentionPresentationItem extends AttentionItem {
  action: 'dismiss' | 'defer';
  generation: string;
  mutationToken: string;
  until?: string;
}
export interface AttentionPresentationList { items: AttentionPresentationItem[]; count: number }
export interface AttentionPresentationReceipt {
  ok: boolean;
  key: string;
  action: 'dismiss' | 'defer' | 'restore';
  generation: string;
  mutationToken: string;
  until?: string;
}
export const ATTENTION_PRESENTATION_QUERY = ['inbox-attention-presentations'] as const;
export const ATTENTION_PRESENTATION_EVENT = 'clem:attention-presentation';
export const ATTENTION_PRESENTATION_INVALIDATE = [
  'inbox-attention-presentations', 'inbox-question-presentations', 'inbox-questions',
  'needs-you-summary', 'notifications', 'home-from-clem', 'command-center', 'working-now-badge',
] as const;
export const listAttentionPresentations = () =>
  apiGet<AttentionPresentationList>('/api/console/inbox/attention/presentation');

export function sameAttentionPresentation(a: Pick<AttentionPresentationReceipt, 'key' | 'generation' | 'mutationToken'> | null,
  b: Pick<AttentionPresentationReceipt, 'key' | 'generation' | 'mutationToken'>): boolean {
  return Boolean(a && a.key === b.key && a.generation === b.generation && a.mutationToken === b.mutationToken);
}

/** Moving an ask changes attention only, never its underlying work or decision. */
export async function presentAttentionItem(key: string, action: AttentionPresentationReceipt['action'], generation: string, mutationToken?: string) {
  if (!key || !generation || action === 'restore' && !mutationToken) throw new Error('Refresh this item before changing its attention setting.');
  const receipt = await apiPost<AttentionPresentationReceipt>('/api/console/inbox/attention/presentation', {
    key, action, generation, ...(mutationToken ? { mutationToken } : {}),
  });
  if (!receipt.ok || receipt.key !== key || receipt.action !== action || receipt.generation !== generation
    || !receipt.mutationToken || action === 'restore' && receipt.mutationToken !== mutationToken) {
    throw new Error('The attention setting could not be confirmed. Refresh before trying again.');
  }
  if (receipt.generation && receipt.mutationToken && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ATTENTION_PRESENTATION_EVENT, { detail: receipt }));
  }
  return receipt;
}

export function attentionItemContext(item: Pick<AttentionItem, 'key' | 'workflow' | 'workflowSlug' | 'runId' | 'sessionId' | 'notificationId'>): { href: string; label: string } | null {
  const workflow = item.workflowSlug || item.workflow;
  if (workflow) {
    const params = new URLSearchParams({ workflow, ...(item.runId ? { run: item.runId } : {}) });
    return { href: `/automate?${params}`, label: item.runId ? 'Open workflow run' : 'Open workflow' };
  }
  if (item.sessionId) return { href: `/chat/${encodeURIComponent(unifiedChatSessionId(item.sessionId))}`, label: 'Open conversation' };
  return null;
}

export const attentionInboxHref = (item: Pick<AttentionItem, 'key' | 'notificationId'>) =>
  `/inbox?tab=needs&select=${encodeURIComponent(item.notificationId || item.key)}`;
