import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { decideApproval, decidePlanProposal, dismissInboxItem } from '@/lib/inbox';
import { cn } from '@/lib/cn';
import {
  agoLabel,
  needsYouDecision,
  needsYouKey,
  needsYouTarget,
  type HomeFeedItem,
} from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';
import { plainText } from '@/components/home/home-model';

const MAX_ROWS = 4;

interface RowState {
  busy?: 'approve' | 'reject' | 'dismiss';
  notice?: { tone: 'success' | 'error'; text: string };
}

/**
 * NEEDS YOU — the command center's list, rendered as decisions. Inline
 * Approve / Not now appear only where the Inbox already exposes that exact
 * approve/reject call; every other card opens where the Inbox would.
 */
export function NeedsYouPane({
  items,
  loading,
  error,
  onRetry,
  headingId,
}: {
  items: readonly HomeFeedItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const settle = () => {
    for (const key of ['command-center', 'approvals', 'approvals-count', 'plan-proposals', 'notifications', 'inbox-questions', 'working-now-badge']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const decide = async (key: string, item: HomeFeedItem, decision: 'approve' | 'reject') => {
    const target = needsYouDecision(item);
    if (!target || rows[key]?.busy) return;
    setRows((prev) => ({ ...prev, [key]: { busy: decision } }));
    try {
      if (target.kind === 'approval') await decideApproval(target.id, decision, { kind: target.approvalKind });
      else await decidePlanProposal(target.id, decision);
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'success',
            text: decision === 'approve' ? 'Approved — Clementine is carrying on.' : 'Declined — this won’t run.',
          },
        },
      }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [key]: {
          notice: {
            tone: 'error',
            text: err instanceof Error && err.message.trim() ? err.message : `Couldn’t ${decision} this.`,
          },
        },
      }));
    } finally {
      settle();
    }
  };

  const dismiss = async (key: string, item: HomeFeedItem) => {
    if (!item.dismissKind || !item.dismissId || rows[key]?.busy) return;
    setRows((prev) => ({ ...prev, [key]: { busy: 'dismiss' } }));
    try {
      await dismissInboxItem(item.dismissKind, item.dismissId);
      setRows((prev) => ({ ...prev, [key]: {} }));
    } catch (err) {
      setRows((prev) => ({
        ...prev,
        [key]: { notice: { tone: 'error', text: err instanceof Error && err.message.trim() ? err.message : 'Couldn’t dismiss this.' } },
      }));
    } finally {
      settle();
    }
  };

  const visible = items.slice(0, MAX_ROWS);
  const overflow = items.length - visible.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader id={headingId} label="Needs you" count={items.length} />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={2} tall />
        ) : error ? (
          <LoadFailedLine what="what needs you" onRetry={onRetry} />
        ) : items.length === 0 ? (
          <QuietLine>Nothing needs you right now.</QuietLine>
        ) : (
          <>
            {visible.map((item, index) => {
              const key = needsYouKey(item, index);
              const state = rows[key] ?? {};
              const decision = needsYouDecision(item);
              const href = needsYouTarget(item);
              const when = agoLabel(item.createdAt);
              const canDismiss = Boolean(item.dismissKind && item.dismissId);
              return (
                <PaneRow key={key} className="flex-col items-stretch gap-2">
                  <div className="flex items-start gap-2">
                    <Link
                      to={href}
                      className="min-w-0 flex-1 rounded-sm text-body font-semibold text-fg hover:text-primary"
                    >
                      <span className="line-clamp-2">{plainText(item.title) || 'Pending approval'}</span>
                    </Link>
                    {when && <span className="shrink-0 pt-0.5 text-caption text-faint">{when}</span>}
                    {canDismiss && (
                      <button
                        type="button"
                        aria-label="Dismiss — I don’t need this"
                        title="Dismiss — I don’t need this"
                        disabled={Boolean(state.busy)}
                        onClick={() => void dismiss(key, item)}
                        className="-mr-1 -mt-0.5 shrink-0 rounded-sm p-1 text-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 cursor-pointer"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </div>
                  {item.meta && <p className="text-small text-muted">{plainText(item.meta, 160)}</p>}
                  {state.notice ? (
                    <p
                      role="status"
                      className={cn(
                        'inline-flex items-center gap-1.5 text-small',
                        state.notice.tone === 'success' ? 'text-success' : 'text-danger',
                      )}
                    >
                      {state.notice.tone === 'success'
                        ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                        : <AlertCircle className="h-3.5 w-3.5" aria-hidden />}
                      {state.notice.text}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {decision && (
                        <>
                          <Button
                            size="sm"
                            className="h-8 px-3 text-small"
                            disabled={Boolean(state.busy)}
                            onClick={() => void decide(key, item, 'approve')}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden />
                            {state.busy === 'approve' ? 'Approving…' : 'Approve'}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 px-3 text-small"
                            disabled={Boolean(state.busy)}
                            onClick={() => void decide(key, item, 'reject')}
                          >
                            {state.busy === 'reject' ? 'Declining…' : 'Not now'}
                          </Button>
                        </>
                      )}
                      <Link
                        to={href}
                        className="inline-flex h-8 items-center rounded-md px-3 text-small font-semibold text-muted transition-colors hover:bg-hover hover:text-fg"
                      >
                        {decision ? 'Preview' : 'Open'}
                      </Link>
                    </div>
                  )}
                </PaneRow>
              );
            })}
            {overflow > 0 && (
              <PaneRow className="justify-center">
                <Link to="/inbox?tab=needs" className="text-small font-semibold text-primary hover:underline">
                  See all {items.length} in Inbox
                </Link>
              </PaneRow>
            )}
          </>
        )}
      </PaneCard>
    </section>
  );
}
