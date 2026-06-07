import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, RefreshCw, Mail, Activity as ActivityIcon, BellRing } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  listApprovals, decideApproval, cancelStaleApprovals,
  listRuns, listNotifications, markNotificationRead, retryNotification,
  relativeTime, statusTone, notifTone, notifFailed,
  type ApprovalRow, type RunRow, type NotificationRow,
} from '@/lib/inbox';

type Tab = 'needs' | 'activity' | 'notifications';

export function Inbox() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('needs');
  const [selected, setSelected] = useState<string | null>(null);

  const approvals = usePoll(['approvals'], listApprovals, 6000);
  const runs = usePoll(['runs'], () => listRuns(40), 4000);
  const notifications = usePoll(['notifications'], listNotifications, 8000);

  const approvalRows = approvals.data?.approvals ?? [];
  const runRows = runs.data?.runs ?? [];
  const notifRows = notifications.data?.notifications ?? [];
  const unread = notifRows.filter((n) => !n.read).length;

  const invalidate = (...keys: string[]) => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

  const onDecide = async (id: string, decision: 'approve' | 'reject') => {
    const row = approvalRows.find((a) => a.approvalId === id);
    try { await decideApproval(id, decision, { kind: row?.kind }); } finally { invalidate('approvals', 'approvals-count', 'command-center'); }
  };
  const onCancelStale = async () => {
    try { await cancelStaleApprovals(); } finally { invalidate('approvals', 'approvals-count'); }
  };
  const onRead = async (id: string) => { try { await markNotificationRead(id); } finally { invalidate('notifications'); } };
  const onRetry = async (id: string) => { try { await retryNotification(id); } finally { invalidate('notifications'); } };

  const tabs: { key: Tab; label: string; icon: typeof Mail; count: number }[] = [
    { key: 'needs', label: 'Needs approval', icon: Mail, count: approvalRows.length },
    { key: 'activity', label: 'Activity', icon: ActivityIcon, count: runRows.length },
    { key: 'notifications', label: 'Notifications', icon: BellRing, count: unread },
  ];

  const selApproval = approvalRows.find((a) => a.approvalId === selected);
  const selRun = runRows.find((r) => r.id === selected);
  const selNotif = notifRows.find((n) => n.id === selected);

  const loading =
    (tab === 'needs' && approvals.isLoading) ||
    (tab === 'activity' && runs.isLoading) ||
    (tab === 'notifications' && notifications.isLoading);

  return (
    <Page
      title="Inbox"
      subtitle="Approvals, activity, and notifications — in one place"
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
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* List */}
        <div className="space-y-2">
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}

          {!loading && tab === 'needs' && (approvalRows.length === 0
            ? <EmptyState title="You're all caught up" description="Nothing needs your approval right now." />
            : approvalRows.map((a) => (
              <ApprovalCard key={a.approvalId} row={a} selected={selected === a.approvalId}
                onSelect={() => setSelected(a.approvalId)}
                onApprove={() => onDecide(a.approvalId, 'approve')}
                onReject={() => onDecide(a.approvalId, 'reject')} />
            )))}

          {!loading && tab === 'activity' && (runRows.length === 0
            ? <EmptyState title="Nothing here yet" description="Things Clementine does will show up here." />
            : runRows.map((r) => (
              <ListRow key={r.id} selected={selected === r.id} onSelect={() => setSelected(r.id)}
                title={r.title || r.input || 'Untitled'} meta={[r.kind, relativeTime(r.updatedAt || r.createdAt)].filter(Boolean).join(' · ')}
                tone={statusTone(r.status)} />
            )))}

          {!loading && tab === 'notifications' && (notifRows.length === 0
            ? <EmptyState title="No notifications" description="Updates from completed work will appear here." />
            : notifRows.map((n) => (
              <ListRow key={n.id} selected={selected === n.id} onSelect={() => setSelected(n.id)}
                title={n.title || n.body || 'Notification'} meta={relativeTime(n.createdAt)}
                tone={notifTone(n)} dim={n.read} />
            )))}
        </div>

        {/* Reading pane */}
        <div className="rounded-lg border border-border bg-surface p-5 shadow-sm">
          {selApproval && <ApprovalDetail row={selApproval} onApprove={() => onDecide(selApproval.approvalId, 'approve')} onReject={() => onDecide(selApproval.approvalId, 'reject')} />}
          {selRun && <RunDetail row={selRun} />}
          {selNotif && <NotifDetail row={selNotif} onRead={() => onRead(selNotif.id)} onRetry={() => onRetry(selNotif.id)} />}
          {!selApproval && !selRun && !selNotif && (
            <div className="flex h-full min-h-48 items-center justify-center text-center text-body text-faint">
              Select an item to see the details
            </div>
          )}
        </div>
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

function ApprovalCard({ row, selected, onSelect, onApprove, onReject }: {
  row: ApprovalRow; selected: boolean; onSelect: () => void; onApprove: () => void; onReject: () => void;
}) {
  return (
    <div className={cn('rounded-md border px-3.5 py-3 transition-colors',
      selected ? 'border-primary bg-primary-tint' : 'border-warning/40 bg-warning-tint')}>
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left cursor-pointer">
        <StatusPill tone="warning">Approve</StatusPill>
        <span className="min-w-0 flex-1 text-body text-fg">{row.subject}</span>
        <span className="shrink-0 text-caption text-faint">{relativeTime(row.requestedAt)}</span>
      </button>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
        <Button size="sm" variant="secondary" onClick={onReject}><X className="h-4 w-4" aria-hidden /> Reject</Button>
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
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{row.subject}</h3>
      <Field label="Tool">{row.tool || '—'}</Field>
      {row.sessionId && <Field label="From session">{row.sessionId}</Field>}
      <Field label="Requested">{relativeTime(row.requestedAt) || '—'}</Field>
      <Field label="Details"><Mono value={row.args} /></Field>
      <div className="mt-4 flex gap-2">
        <Button onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> Approve</Button>
        <Button variant="secondary" onClick={onReject}><X className="h-4 w-4" aria-hidden /> Reject</Button>
      </div>
    </div>
  );
}

function RunDetail({ row }: { row: RunRow }) {
  const tone = statusTone(row.status);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
        <span className="text-caption text-faint">{relativeTime(row.updatedAt || row.createdAt)}</span>
      </div>
      <h3 className="mb-3 text-h3 text-fg">{row.title || 'Run'}</h3>
      {row.input && <Field label="Asked"><span className="whitespace-pre-wrap">{row.input}</span></Field>}
      {row.outputPreview && <Field label="Result"><span className="whitespace-pre-wrap">{row.outputPreview}</span></Field>}
      {row.error && <Field label="Error"><span className="text-danger">{row.error}</span></Field>}
      {row.kind && <Field label="Kind">{row.kind}</Field>}
    </div>
  );
}

function NotifDetail({ row, onRead, onRetry }: { row: NotificationRow; onRead: () => void; onRetry: () => void }) {
  const failed = notifFailed(row);
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{row.title || 'Notification'}</h3>
      <Field label="When">{relativeTime(row.createdAt) || '—'}</Field>
      <Field label="Message"><span className="whitespace-pre-wrap">{row.body || '—'}</span></Field>
      {row.deliveryError && <Field label="Delivery error"><span className="text-danger">{row.deliveryError}</span></Field>}
      <div className="mt-4 flex gap-2">
        {!row.read && <Button variant="secondary" size="sm" onClick={onRead}>Mark as read</Button>}
        {failed && <Button size="sm" onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden /> Retry</Button>}
      </div>
    </div>
  );
}
