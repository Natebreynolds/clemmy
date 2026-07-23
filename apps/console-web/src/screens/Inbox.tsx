import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, RefreshCw, Mail, BellRing, Send } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import {
  listApprovals, decideApproval, cancelStaleApprovals,
  listNotifications, markNotificationRead, retryNotification,
  listTrustProposals, decideTrustProposal,
  relativeTime, notifTone, notifFailed,
  type ApprovalRow, type NotificationRow, type TrustProposalRow,
} from '@/lib/inbox';

/** Client mirror of the backend's needs-attention rule (runtime/notifications.ts)
 *  — these are DECISIONS/blocks for the user, so they belong on the "Needs you"
 *  tab beside approvals, not buried under general notifications. */
function needsAttentionNotif(n: NotificationRow): boolean {
  return /\bblocked\b|needs attention|needs input|couldn['\u2019]t finish|action required/i.test(n.title || '');
}

type Tab = 'needs' | 'notifications';

export function Inbox() {
  const qc = useQueryClient();
  // Deep-link support: /inbox?tab=notifications&select=<id> (used by the
  // Home "Needs you" cards, which are notification-backed — landing them on
  // the default approvals tab showed an empty "all caught up" page).
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  // 'activity' is gone (it duplicated the Tasks board) — legacy links map to notifications.
  const initialTab: Tab = tabParam === 'notifications' || tabParam === 'activity' ? 'notifications' : 'needs';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selected, setSelected] = useState<string | null>(searchParams.get('select'));
  // Multi-select for bulk approve/reject — the "manage in the board" ask: clear
  // several held sends in one click instead of one card at a time. Each still
  // resolves through the same per-row decideApproval (kind routing + resume
  // side effects preserved), so bulk changes nothing about WHAT gets approved.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Re-apply when the deep link changes while the screen stays mounted
  // (e.g. Home card → Inbox already open in the router tree).
  useEffect(() => {
    if (tabParam === 'notifications' || tabParam === 'activity') setTab('notifications');
    else if (tabParam === 'needs') setTab('needs');
    const select = searchParams.get('select');
    if (select) setSelected(select);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const approvals = usePoll(['approvals'], listApprovals, 6000);
  const notifications = usePoll(['notifications'], listNotifications, 8000);
  const trustProposals = usePoll(['trust-proposals'], listTrustProposals, 8000);

  const approvalRows = approvals.data?.approvals ?? [];
  const notifRows = notifications.data?.notifications ?? [];
  const trustRows = trustProposals.data?.proposals ?? [];
  // Unread needs-attention notifications are DECISIONS → they live on "Needs you"
  // beside approvals (and leave once read); everything else stays in Notifications.
  const attentionRows = notifRows.filter((n) => !n.read && needsAttentionNotif(n));
  const attentionIds = new Set(attentionRows.map((n) => n.id));
  const plainNotifRows = notifRows.filter((n) => !attentionIds.has(n.id));
  const needsCount = approvalRows.length + attentionRows.length + trustRows.length;
  // Count only checked IDs that still exist in the live list — resolved cards
  // drop out on the next poll and must not keep inflating the bulk-action count.
  const checkedCount = approvalRows.reduce((n, a) => (checked.has(a.approvalId) ? n + 1 : n), 0);
  const hasRows = (tab === 'needs' ? needsCount : plainNotifRows.length) > 0;
  const unread = plainNotifRows.filter((n) => !n.read).length;

  const invalidate = (...keys: string[]) => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

  const onDecide = async (id: string, decision: 'approve' | 'reject') => {
    const row = approvalRows.find((a) => a.approvalId === id);
    try { await decideApproval(id, decision, { kind: row?.kind }); } finally { invalidate('approvals', 'approvals-count', 'command-center'); }
  };
  const toggleChecked = (id: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const onBulkDecide = async (decision: 'approve' | 'reject') => {
    // Snapshot the target rows before any await — approvalRows re-polls and the
    // resolved cards drop out from under us mid-loop otherwise.
    const targets = approvalRows.filter((a) => checked.has(a.approvalId));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      // Sequential, not Promise.all: a rejected send that resumes a run must not
      // race a sibling on the same session; one-at-a-time matches the single-card
      // path exactly and keeps the resume/queue state machine deterministic.
      for (const row of targets) {
        try { await decideApproval(row.approvalId, decision, { kind: row.kind }); } catch { /* skip the failures, resolve the rest */ }
      }
    } finally {
      setChecked(new Set());
      setBulkBusy(false);
      invalidate('approvals', 'approvals-count', 'command-center');
    }
  };
  const onCancelStale = async () => {
    try { await cancelStaleApprovals(); } finally { invalidate('approvals', 'approvals-count'); }
  };
  const onDecideTrust = async (id: string, decision: 'approve' | 'decline') => {
    try { await decideTrustProposal(id, decision); } finally { invalidate('trust-proposals', 'approvals-count', 'command-center'); }
  };
  const onRead = async (id: string) => { try { await markNotificationRead(id); } finally { invalidate('notifications'); } };
  const onRetry = async (id: string) => { try { await retryNotification(id); } finally { invalidate('notifications'); } };

  const tabs: { key: Tab; label: string; icon: typeof Mail; count: number }[] = [
    { key: 'needs', label: 'Needs you', icon: Mail, count: needsCount },
    { key: 'notifications', label: 'Notifications', icon: BellRing, count: unread },
  ];

  const selApproval = approvalRows.find((a) => a.approvalId === selected);
  const selNotif = notifRows.find((n) => n.id === selected);

  const loading =
    (tab === 'needs' && (approvals.isLoading || notifications.isLoading || trustProposals.isLoading)) ||
    (tab === 'notifications' && notifications.isLoading);

  return (
    <Page
      title="Inbox"
      subtitle="Decisions waiting on you, and updates from finished work"
      actions={tab === 'needs' && approvalRows.length > 0
        ? <Button variant="secondary" size="sm" onClick={onCancelStale}><RefreshCw className="h-4 w-4" aria-hidden /> Clear stale</Button>
        : undefined}
    >
      <div className="mb-4 flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); setSelected(null); }}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-body font-medium transition-colors cursor-pointer -mb-px',
                active ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
              {t.count > 0 && (
                <span className={cn('rounded-full px-1.5 text-caption font-bold', active ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted')}>
                  {t.count > 99 ? '99+' : t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Hide the reading pane when the current tab has nothing to select — an
          empty list beside an empty "select an item" box reads as a broken page. */}
      <div className={cn('grid gap-4', hasRows && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]')}>
        {/* List */}
        <div className="space-y-2">
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}

          {!loading && tab === 'needs' && (needsCount === 0
            ? <EmptyState title="You're all caught up" description="Nothing needs a decision from you right now." />
            : (
              <>
                {approvalRows.length > 1 && (
                  <div className="flex items-center gap-3 rounded-md border border-border bg-subtle px-3.5 py-2">
                    <input type="checkbox" aria-label="Select all approvals"
                      className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                      checked={checkedCount === approvalRows.length}
                      ref={(el) => { if (el) el.indeterminate = checkedCount > 0 && checkedCount < approvalRows.length; }}
                      onChange={() => setChecked(checkedCount === approvalRows.length ? new Set() : new Set(approvalRows.map((a) => a.approvalId)))} />
                    {checkedCount > 0 ? (
                      <>
                        <span className="text-body text-fg">{checkedCount} selected</span>
                        <div className="ml-auto flex gap-2">
                          <Button size="sm" disabled={bulkBusy} onClick={() => onBulkDecide('approve')}>
                            <Check className="h-4 w-4" aria-hidden /> Approve {checkedCount}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => onBulkDecide('reject')}>
                            <X className="h-4 w-4" aria-hidden /> Reject {checkedCount}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <span className="text-body text-muted">Select to approve or reject in bulk</span>
                    )}
                  </div>
                )}
                {approvalRows.map((a) => (
                  <ApprovalCard key={a.approvalId} row={a} selected={selected === a.approvalId}
                    checked={checked.has(a.approvalId)}
                    onToggleCheck={() => toggleChecked(a.approvalId)}
                    onSelect={() => setSelected(a.approvalId)}
                    onApprove={() => onDecide(a.approvalId, 'approve')}
                    onReject={() => onDecide(a.approvalId, 'reject')} />
                ))}
                {trustRows.map((p) => (
                  <TrustProposalCard key={p.id} row={p}
                    onApprove={() => onDecideTrust(p.id, 'approve')}
                    onDecline={() => onDecideTrust(p.id, 'decline')} />
                ))}
                {attentionRows.map((n) => (
                  <ListRow key={n.id} selected={selected === n.id} onSelect={() => setSelected(n.id)}
                    title={n.title || n.body || 'Needs attention'} meta={relativeTime(n.createdAt)}
                    tone={{ tone: 'warning', label: 'Needs attention' }} />
                ))}
              </>
            ))}

          {!loading && tab === 'notifications' && (plainNotifRows.length === 0
            ? <EmptyState title="No notifications" description="Updates from completed work will appear here." />
            : plainNotifRows.map((n) => (
              <ListRow key={n.id} selected={selected === n.id} onSelect={() => setSelected(n.id)}
                title={n.title || n.body || 'Notification'} meta={relativeTime(n.createdAt)}
                tone={notifTone(n)} dim={n.read} />
            )))}
        </div>

        {/* Reading pane — only rendered when the tab has selectable rows. */}
        {hasRows && (
          <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
            {selApproval && <ApprovalDetail row={selApproval} onApprove={() => onDecide(selApproval.approvalId, 'approve')} onReject={() => onDecide(selApproval.approvalId, 'reject')} />}
            {selNotif && <NotifDetail row={selNotif} onRead={() => onRead(selNotif.id)} onRetry={() => onRetry(selNotif.id)} />}
            {!selApproval && !selNotif && (
              <div className="flex h-full min-h-48 items-center justify-center text-center text-body text-faint">
                Select an item to see the details
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

function ListRow({ title, meta, tone, selected, onSelect, dim }: {
  title: string; meta: string; tone: { tone: Parameters<typeof StatusPill>[0]['tone']; label: string };
  selected: boolean; onSelect: () => void; dim?: boolean;
}) {
  return (
    <button type="button" onClick={onSelect}
      className={cn('flex w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors cursor-pointer',
        selected ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:bg-hover', dim && 'opacity-60')}>
      <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
      <span className="min-w-0 flex-1 truncate text-body text-fg">{title}</span>
      {meta && <span className="shrink-0 text-caption text-faint">{meta}</span>}
    </button>
  );
}

function ApprovalCard({ row, selected, checked, onToggleCheck, onSelect, onApprove, onReject }: {
  row: ApprovalRow; selected: boolean; checked: boolean; onToggleCheck: () => void;
  onSelect: () => void; onApprove: () => void; onReject: () => void;
}) {
  const queued = row.pendingAction;
  return (
    <div className={cn('rounded-md border px-3.5 py-3 transition-colors',
      selected ? 'border-primary bg-primary-tint' : 'border-warning/40 bg-warning-tint')}>
      <div className="flex w-full items-start gap-3">
        <input type="checkbox" aria-label="Select for bulk action"
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          checked={checked} onChange={onToggleCheck} onClick={(e) => e.stopPropagation()} />
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-start gap-3 text-left cursor-pointer">
          <StatusPill tone="warning">{queued ? 'Ready' : 'Approve'}</StatusPill>
          <span className="min-w-0 flex-1 text-body text-fg">{queued ? queued.title : row.subject}</span>
          <span className="shrink-0 text-caption text-faint">{relativeTime(row.requestedAt)}</span>
        </button>
      </div>
      {queued && (
        <div className="mt-1 truncate text-caption text-muted">
          {queued.toolName} · {queued.targetSummary || queued.kind} · hash {queued.payloadHash}
        </div>
      )}
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={onApprove}>
          {queued ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          {queued ? 'Execute' : 'Approve'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onReject}><X className="h-4 w-4" aria-hidden /> Reject</Button>
      </div>
    </div>
  );
}

function TrustProposalCard({ row, onApprove, onDecline }: {
  row: TrustProposalRow; onApprove: () => void; onDecline: () => void;
}) {
  const scope = [
    ...row.recipients,
    ...(row.domains ?? []).map((d) => `anyone @${d}`),
  ].join(', ');
  return (
    <div className="rounded-md border border-primary/40 bg-primary-tint/40 px-3.5 py-3">
      <div className="flex w-full items-start gap-3">
        <StatusPill tone="live">Suggestion</StatusPill>
        <span className="min-w-0 flex-1 text-body text-fg">Send-trust: {scope}</span>
        <span className="shrink-0 text-caption text-faint">{relativeTime(row.createdAt)}</span>
      </div>
      <div className="mt-1 text-caption text-muted">{row.rationale}</div>
      <div className="mt-1 text-caption text-faint">
        {row.evidence.cleanSendCount} clean sends over {row.evidence.distinctDays} days · via {row.toolkits.join(', ')}
      </div>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
        <Button size="sm" variant="secondary" onClick={onDecline}><X className="h-4 w-4" aria-hidden /> Decline</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-label text-faint">{label}</div>
      <div className="text-body text-fg">{children}</div>
    </div>
  );
}

function Mono({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return <span className="text-faint">—</span>;
  return <pre className="max-h-72 overflow-auto rounded-md bg-subtle p-3 font-mono text-caption text-muted">{text}</pre>;
}

function ApprovalDetail({ row, onApprove, onReject }: { row: ApprovalRow; onApprove: () => void; onReject: () => void }) {
  const queued = row.pendingAction;
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{queued ? `Ready to execute: ${queued.title}` : row.subject}</h3>
      {queued && <PendingActionDetail action={queued} />}
      <Field label="Tool">{row.tool || '—'}</Field>
      {row.sessionId && <Field label="From session">{row.sessionId}</Field>}
      <Field label="Requested">{relativeTime(row.requestedAt) || '—'}</Field>
      <Field label="Details"><Mono value={row.args} /></Field>
      <div className="mt-4 flex gap-2">
        <Button onClick={onApprove}>
          {queued ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          {queued ? 'Execute queued action' : 'Approve'}
        </Button>
        <Button variant="secondary" onClick={onReject}><X className="h-4 w-4" aria-hidden /> Reject</Button>
      </div>
    </div>
  );
}

function PendingActionDetail({ action }: { action: NonNullable<ApprovalRow['pendingAction']> }) {
  return (
    <div className="mb-4 border-y border-border py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StatusPill tone="warning">{action.status}</StatusPill>
        <span className="text-caption text-faint">{action.kind}</span>
        <span className="text-caption text-faint">hash <span className="font-mono">{action.payloadHash}</span></span>
      </div>
      {action.summary && <Field label="Summary">{action.summary}</Field>}
      <Field label="Execution tool"><span className="font-mono">{action.toolName}</span></Field>
      {action.targetSummary && <Field label="Target">{action.targetSummary}</Field>}
      {action.preview && <Field label="Preview"><span className="whitespace-pre-wrap">{action.preview}</span></Field>}
      {action.risk && <Field label="Risk">{action.risk}</Field>}
      {action.rollback && <Field label="Rollback">{action.rollback}</Field>}
      <Field label="Exact queued payload"><Mono value={action.payload} /></Field>
      {action.idempotencyKey && <Field label="Idempotency key"><span className="font-mono">{action.idempotencyKey}</span></Field>}
    </div>
  );
}


function NotifDetail({ row, onRead, onRetry }: { row: NotificationRow; onRead: () => void; onRetry: () => void }) {
  const failed = notifFailed(row);
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{row.title || 'Notification'}</h3>
      <Field label="When">{relativeTime(row.createdAt) || '—'}</Field>
      <Field label="Message"><span className="whitespace-pre-wrap">{row.body ? linkify(row.body) : '—'}</span></Field>
      {row.deliveryError && <Field label="Delivery error"><span className="text-danger">{row.deliveryError}</span></Field>}
      <div className="mt-4 flex gap-2">
        {!row.read && <Button variant="secondary" size="sm" onClick={onRead}>Mark as read</Button>}
        {failed && <Button size="sm" onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>}
      </div>
    </div>
  );
}
