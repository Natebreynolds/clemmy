import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, RefreshCw, Mail, BellRing, Send } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import {
  listApprovals, decideApproval, cancelStaleApprovals,
  listWorkspaceDestinationChoosers, resolveWorkspaceDestinationChooser,
  listNotifications, markNotificationRead, retryNotification,
  listTrustProposals, decideTrustProposal,
  listPlanProposals, decidePlanProposal,
  listInboxQuestions, answerInboxQuestion,
  resolveWorkflowCapability,
  relativeTime,
  approvalDecisionSuccessText, collapseAttentionRows, notifTone, notifFailed,
  summarizeApprovalDecisionBatch,
  type ApprovalRow, type NotificationRow, type TrustProposalRow, type PlanProposalRow, type InboxQuestionRow,
  type WorkspaceDestinationChooser, type WorkflowCapabilityAccountChoice, type WorkflowCapabilityInboxGate,
} from '@/lib/inbox';

/** Client mirror of the backend's needs-attention rule (runtime/notifications.ts)
 *  — these are DECISIONS/blocks for the user, so they belong on the "Needs you"
 *  tab beside approvals, not buried under general notifications. */
function needsAttentionNotif(n: NotificationRow): boolean {
  return n.needsAttention === true
    || /\bblocked\b|needs attention|needs input|needs you|paused|couldn['\u2019]t finish|action required/i.test(n.title || '');
}

type Tab = 'needs' | 'notifications';
type DecisionNotice = { tone: 'success' | 'error'; text: string };
type RowDecisionState = {
  busy: boolean;
  intent?: 'approve' | 'reject';
  notice?: DecisionNotice;
};

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

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
  const [decisionStates, setDecisionStates] = useState<Record<string, RowDecisionState>>({});
  const [chooserBusy, setChooserBusy] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState<string | null>(null);
  const [questionBusy, setQuestionBusy] = useState<string | null>(null);
  const [capabilityBusy, setCapabilityBusy] = useState<string | null>(null);
  const questionLockRef = useRef<string | null>(null);
  const capabilityLockRef = useRef<string | null>(null);
  const [trustBusy, setTrustBusy] = useState<string | null>(null);
  const trustLockRef = useRef<string | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [decisionNotice, setDecisionNotice] = useState<DecisionNotice | null>(null);
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
  const workspaceChoosers = usePoll(
    ['workspace-choosers'],
    listWorkspaceDestinationChoosers,
    6000,
  );
  const notifications = usePoll(['notifications'], listNotifications, 8000);
  const trustProposals = usePoll(['trust-proposals'], listTrustProposals, 8000);
  const planProposals = usePoll(['plan-proposals'], listPlanProposals, 6000);
  const questions = usePoll(['inbox-questions'], listInboxQuestions, 5000);

  const approvalRows = approvals.data?.approvals ?? [];
  const workspaceChooserRows = workspaceChoosers.data?.choosers ?? [];
  // Server sorts urgent-first; aged cards (48h+ unanswered, nothing parked on
  // them) render below a divider and stop counting toward "needs you".
  const urgentApprovalRows = approvalRows.filter((a) => !a.stale);
  const agedApprovalRows = approvalRows.filter((a) => a.stale);
  const notifRows = notifications.data?.notifications ?? [];
  const trustRows = trustProposals.data?.proposals ?? [];
  const planRows = planProposals.data?.proposals ?? [];
  const questionRows = questions.data?.questions ?? [];
  // Unread needs-attention notifications are DECISIONS → they live on "Needs you"
  // beside approvals (and leave once read); everything else stays in Notifications.
  const attentionRows = notifRows.filter((n) => !n.read && needsAttentionNotif(n));
  const attentionIds = new Set(attentionRows.map((n) => n.id));
  const plainNotifRows = notifRows.filter((n) => !attentionIds.has(n.id));
  // A burst of blocked runs from one workflow is ONE decision, not ten rows —
  // collapse duplicates to the newest and badge the earlier ones.
  const collapsedAttention = collapseAttentionRows(attentionRows);
  const needsCount = workspaceChooserRows.length + urgentApprovalRows.length + collapsedAttention.length + trustRows.length + planRows.length + questionRows.length;
  const anyDecisionRows = workspaceChooserRows.length + approvalRows.length + collapsedAttention.length + trustRows.length + planRows.length + questionRows.length;
  // Count only checked IDs that still exist in the live list — resolved cards
  // drop out on the next poll and must not keep inflating the bulk-action count.
  const checkedCount = approvalRows.reduce((n, a) => (checked.has(a.approvalId) ? n + 1 : n), 0);
  const queryUnavailable = tab === 'needs'
    ? approvals.isError || workspaceChoosers.isError || notifications.isError || trustProposals.isError || planProposals.isError || questions.isError
    : notifications.isError;
  const hasRows = !queryUnavailable && (tab === 'needs' ? needsCount : plainNotifRows.length) > 0;
  const unread = plainNotifRows.filter((n) => !n.read).length;

  const invalidate = (...keys: string[]) => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

  const onDecide = async (id: string, decision: 'approve' | 'reject') => {
    const row = approvalRows.find((a) => a.approvalId === id);
    if (!row || decisionStates[id]?.busy || bulkBusy) return;
    setDecisionStates((prev) => ({ ...prev, [id]: { busy: true, intent: decision } }));
    setDecisionNotice(null);
    try {
      const result = await decideApproval(id, decision, { kind: row.kind });
      const notice: DecisionNotice = {
        tone: 'success',
        text: approvalDecisionSuccessText(row, decision, result),
      };
      setDecisionStates((prev) => ({ ...prev, [id]: { busy: false, notice } }));
      setDecisionNotice(notice);
      setChecked((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error) {
      const notice: DecisionNotice = {
        tone: 'error',
        text: actionError(error, `Could not ${decision} this approval.`),
      };
      setDecisionStates((prev) => ({ ...prev, [id]: { busy: false, notice } }));
      setDecisionNotice(notice);
    } finally {
      invalidate('approvals', 'approvals-count', 'working-now-badge', 'command-center', 'command-center');
    }
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
    setDecisionNotice(null);
    setDecisionStates((prev) => {
      const next = { ...prev };
      for (const row of targets) next[row.approvalId] = { busy: true, intent: decision };
      return next;
    });
    const failedIds = new Set<string>();
    const errors: string[] = [];
    let succeeded = 0;
    try {
      // Sequential, not Promise.all: a rejected send that resumes a run must not
      // race a sibling on the same session; one-at-a-time matches the single-card
      // path exactly and keeps the resume/queue state machine deterministic.
      for (const row of targets) {
        try {
          const result = await decideApproval(row.approvalId, decision, { kind: row.kind });
          succeeded += 1;
          setDecisionStates((prev) => ({
            ...prev,
            [row.approvalId]: {
              busy: false,
              notice: { tone: 'success', text: approvalDecisionSuccessText(row, decision, result) },
            },
          }));
        } catch (error) {
          failedIds.add(row.approvalId);
          const message = actionError(error, `Could not ${decision} this approval.`);
          errors.push(message);
          setDecisionStates((prev) => ({
            ...prev,
            [row.approvalId]: { busy: false, notice: { tone: 'error', text: message } },
          }));
        }
      }
    } finally {
      setChecked(new Set(failedIds));
      setDecisionNotice({
        tone: failedIds.size > 0 ? 'error' : 'success',
        text: summarizeApprovalDecisionBatch({
          decision,
          total: targets.length,
          succeeded,
          errors,
        }),
      });
      setBulkBusy(false);
      invalidate('approvals', 'approvals-count', 'working-now-badge', 'command-center', 'command-center');
    }
  };
  const onCancelStale = async () => {
    setDecisionNotice(null);
    try {
      await cancelStaleApprovals();
      setDecisionNotice({ tone: 'success', text: 'Stale approval cards were cleared.' });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not clear stale approvals.') });
    } finally {
      invalidate('approvals', 'approvals-count', 'working-now-badge', 'command-center');
    }
  };
  const onChooseWorkspace = async (chooser: WorkspaceDestinationChooser, choiceId: string) => {
    if (chooserBusy) return;
    setChooserBusy(chooser.chooserId);
    setDecisionNotice(null);
    try {
      await resolveWorkspaceDestinationChooser(chooser, choiceId);
      setDecisionNotice({
        tone: 'success',
        text: 'Workspace destination recorded. Clem is continuing the pilot automatically.',
      });
    } catch (error) {
      setDecisionNotice({
        tone: 'error',
        text: actionError(error, 'Could not record that Workspace destination.'),
      });
    } finally {
      setChooserBusy(null);
      invalidate('workspace-choosers', 'approvals', 'approvals-count', 'working-now-badge', 'command-center', 'command-center');
    }
  };
  const onDecideTrust = async (row: TrustProposalRow, decision: 'approve' | 'decline') => {
    if (trustLockRef.current) return;
    trustLockRef.current = row.id;
    setTrustBusy(row.id);
    setDecisionNotice(null);
    try {
      const result = await decideTrustProposal(row, decision);
      const expectedReason = decision === 'approve' ? 'approved' : 'declined';
      if (!result.ok || result.reason !== expectedReason) {
        throw new Error(`The trust decision was not committed (${result.reason || 'unknown outcome'}).`);
      }
      const receipt = result.scopeReceipt;
      if (!receipt) throw new Error('The server did not return the exact durable trust-scope receipt. Nothing is being reported as granted.');
      const scope = [
        receipt.recipients.length ? `exact recipients ${receipt.recipients.join(', ')}` : '',
        receipt.domains.length ? `entire domains ${receipt.domains.map((domain) => `@${domain}`).join(', ')}` : '',
        receipt.toolkits.length ? `send tools ${receipt.toolkits.join(', ')}` : '',
        `up to ${receipt.maxRecipients} recipients`,
      ].filter(Boolean).join(' · ');
      setDecisionNotice({
        tone: 'success',
        text: decision === 'approve'
          ? `Standing trust saved for ${scope}.`
          : `Standing-trust suggestion declined for ${scope}. Nothing was granted.`,
      });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not update that trust decision.') });
    } finally {
      trustLockRef.current = null;
      setTrustBusy(null);
      invalidate('trust-proposals', 'approvals-count', 'working-now-badge', 'command-center', 'command-center');
    }
  };
  const onDecidePlan = async (id: string, decision: 'approve' | 'reject') => {
    if (planBusy) return;
    setPlanBusy(id);
    setDecisionNotice(null);
    try {
      await decidePlanProposal(id, decision);
      setDecisionNotice({
        tone: 'success',
        text: decision === 'approve'
          ? 'Plan approved. The exact proposal was queued and Clem is continuing it.'
          : 'Plan rejected. Nothing from that proposal was queued.',
      });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, `Could not ${decision} that plan.`) });
    } finally {
      setPlanBusy(null);
      invalidate('plan-proposals', 'approvals-count', 'working-now-badge', 'command-center', 'command-center');
    }
  };
  const onAnswerQuestion = async (row: InboxQuestionRow, option?: string) => {
    if (questionLockRef.current || !row.answerable) return;
    const answer = (option ?? questionAnswers[row.id] ?? '').trim();
    if (!answer) return;
    questionLockRef.current = row.id;
    setQuestionBusy(row.id);
    setDecisionNotice(null);
    try {
      const result = await answerInboxQuestion(row.id, answer);
      setDecisionNotice({
        tone: 'success',
        text: result.status === 'resuming'
          ? `Answer recorded: “${answer.slice(0, 180)}”. Clem is resuming the same ${row.source === 'workflow' ? 'workflow run' : 'task'}.`
          : `Answer recorded: “${answer.slice(0, 180)}”.`,
      });
      setQuestionAnswers((previous) => ({ ...previous, [row.id]: '' }));
    } catch (error) {
      setDecisionNotice({
        tone: 'error',
        text: actionError(error, 'That question changed or was already answered. Refreshing the exact Inbox state.'),
      });
    } finally {
      questionLockRef.current = null;
      setQuestionBusy(null);
      invalidate('inbox-questions', 'notifications', 'command-center');
    }
  };
  const onResolveCapability = async (
    gate: WorkflowCapabilityInboxGate,
    choice?: WorkflowCapabilityAccountChoice,
  ) => {
    if (capabilityLockRef.current || gate.resolution.kind === 'review_run') return;
    capabilityLockRef.current = gate.notificationId;
    setCapabilityBusy(gate.notificationId);
    setDecisionNotice(null);
    try {
      const result = await resolveWorkflowCapability(gate, choice);
      setDecisionNotice({
        tone: 'success',
        text: result.status === 'already_selected' || result.status === 'already_resumed'
          ? 'That exact gate was already handled. The same run remains on its one-time resume path.'
          : choice
            ? `Account ${choice.label} (${choice.accountId}) saved. Clem is resuming the same run once.`
            : 'The exact gate was reopened. Clem is resuming the same run once.',
      });
    } catch (error) {
      setDecisionNotice({
        tone: 'error',
        text: actionError(error, 'That workflow gate changed. Nothing was dispatched; refreshing its exact state.'),
      });
    } finally {
      capabilityLockRef.current = null;
      setCapabilityBusy(null);
      invalidate('notifications', 'command-center');
    }
  };
  const onRead = async (id: string) => {
    try {
      await markNotificationRead(id);
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not mark that notification as read.') });
    } finally {
      invalidate('notifications');
    }
  };
  const onRetry = async (id: string) => {
    setDecisionNotice(null);
    try {
      await retryNotification(id);
      setDecisionNotice({ tone: 'success', text: 'Notification delivery retry was queued.' });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not retry notification delivery.') });
    } finally {
      invalidate('notifications');
    }
  };

  const tabs: { key: Tab; label: string; icon: typeof Mail; count: number }[] = [
    { key: 'needs', label: 'Needs you', icon: Mail, count: needsCount },
    { key: 'notifications', label: 'Notifications', icon: BellRing, count: unread },
  ];

  const selApproval = approvalRows.find((a) => a.approvalId === selected);
  const selPlan = planRows.find((p) => p.id === selected);
  const selNotif = notifRows.find((n) => n.id === selected);

  const loading =
    (tab === 'needs' && (approvals.isLoading || workspaceChoosers.isLoading || notifications.isLoading || trustProposals.isLoading || planProposals.isLoading || questions.isLoading)) ||
    (tab === 'notifications' && notifications.isLoading);
  const retryCurrentTab = () => {
    if (tab === 'needs') {
      void approvals.refetch();
      void workspaceChoosers.refetch();
      void trustProposals.refetch();
      void planProposals.refetch();
      void questions.refetch();
    }
    void notifications.refetch();
  };

  return (
    <Page
      title="Needs you"
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
                'inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-body font-medium cursor-pointer -mb-px',
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

      {decisionNotice && (
        <div
          role={decisionNotice.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={cn(
            'mb-4 rounded-md border px-3.5 py-2.5 text-small',
            decisionNotice.tone === 'error'
              ? 'border-danger/35 bg-danger-tint text-danger'
              : 'border-success/35 bg-success-tint text-success',
          )}
        >
          {decisionNotice.text}
        </div>
      )}

      {/* Hide the reading pane when the current tab has nothing to select — an
          empty list beside an empty "select an item" box reads as a broken page. */}
      <div className={cn('grid gap-4', hasRows && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]')}>
        {/* List */}
        <div className="space-y-2">
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}

          {!loading && queryUnavailable && (
            <QueryUnavailable
              title="Inbox is unavailable"
              description="Clementine couldn’t verify what needs your attention. This is not an all-caught-up state."
              onRetry={retryCurrentTab}
              className="py-10"
            />
          )}

          {!loading && !queryUnavailable && tab === 'needs' && (anyDecisionRows === 0
            ? <EmptyState title="You're all caught up" description="Nothing needs a decision from you right now." />
            : (
              <>
                {workspaceChooserRows.map((chooser) => (
                  <WorkspaceChooserCard
                    key={chooser.chooserId}
                    chooser={chooser}
                    busy={chooserBusy === chooser.chooserId}
                    onChoose={(choiceId) => onChooseWorkspace(chooser, choiceId)}
                  />
                ))}
                {questionRows.map((question) => (
                  <InboxQuestionCard
                    key={question.id}
                    row={question}
                    selected={selected === question.id}
                    answer={questionAnswers[question.id] ?? ''}
                    busy={questionBusy === question.id}
                    globallyBusy={questionBusy !== null}
                    onSelect={() => setSelected(question.id)}
                    onAnswerChange={(answer) => setQuestionAnswers((previous) => ({ ...previous, [question.id]: answer }))}
                    onSubmit={(option) => { void onAnswerQuestion(question, option); }}
                  />
                ))}
                {planRows.map((plan) => (
                  <PlanProposalCard
                    key={plan.id}
                    row={plan}
                    selected={selected === plan.id}
                    busy={planBusy === plan.id}
                    onSelect={() => setSelected(plan.id)}
                    onApprove={() => onDecidePlan(plan.id, 'approve')}
                    onReject={() => onDecidePlan(plan.id, 'reject')}
                  />
                ))}
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
                {urgentApprovalRows.map((a) => (
                  <ApprovalCard key={a.approvalId} row={a} selected={selected === a.approvalId}
                    checked={checked.has(a.approvalId)}
                    decisionState={decisionStates[a.approvalId]}
                    disabled={bulkBusy}
                    onToggleCheck={() => toggleChecked(a.approvalId)}
                    onSelect={() => setSelected(a.approvalId)}
                    onApprove={() => onDecide(a.approvalId, 'approve')}
                    onReject={() => onDecide(a.approvalId, 'reject')} />
                ))}
                {agedApprovalRows.length > 0 && (
                  <div className="flex items-center gap-2 pt-2 text-caption text-muted">
                    <span className="h-px flex-1 bg-border" aria-hidden />
                    Older approvals — waiting 2+ days, still approvable
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  </div>
                )}
                {agedApprovalRows.map((a) => (
                  <ApprovalCard key={a.approvalId} row={a} selected={selected === a.approvalId}
                    checked={checked.has(a.approvalId)}
                    decisionState={decisionStates[a.approvalId]}
                    disabled={bulkBusy}
                    onToggleCheck={() => toggleChecked(a.approvalId)}
                    onSelect={() => setSelected(a.approvalId)}
                    onApprove={() => onDecide(a.approvalId, 'approve')}
                    onReject={() => onDecide(a.approvalId, 'reject')} />
                ))}
                {trustRows.map((p) => (
                  <TrustProposalCard key={p.id} row={p}
                    busy={trustBusy === p.id}
                    globallyBusy={trustBusy !== null}
                    onApprove={() => onDecideTrust(p, 'approve')}
                    onDecline={() => onDecideTrust(p, 'decline')} />
                ))}
                {collapsedAttention.map(({ row: n, collapsedCount }) => (
                  n.workflowCapability ? (
                    <WorkflowCapabilityCard
                      key={n.id}
                      gate={n.workflowCapability}
                      title={n.title}
                      body={n.body}
                      createdAt={n.createdAt}
                      busy={capabilityBusy === n.id}
                      globallyBusy={capabilityBusy !== null}
                      onResolve={(choice) => { void onResolveCapability(n.workflowCapability as WorkflowCapabilityInboxGate, choice); }}
                    />
                  ) : (
                    <ListRow key={n.id} selected={selected === n.id} onSelect={() => setSelected(n.id)}
                      title={n.title || n.body || 'Needs attention'}
                      meta={`${relativeTime(n.createdAt)}${collapsedCount > 0 ? ` · +${collapsedCount} earlier` : ''}`}
                      tone={{ tone: 'warning', label: 'Needs attention' }} />
                  )
                ))}
              </>
            ))}

          {!loading && !queryUnavailable && tab === 'notifications' && (plainNotifRows.length === 0
            ? <EmptyState title="No notifications" description="Updates from completed work will appear here." />
            : plainNotifRows.map((n) => (
              <ListRow key={n.id} selected={selected === n.id} onSelect={() => setSelected(n.id)}
                title={n.title || n.body || 'Notification'} meta={relativeTime(n.createdAt)}
                tone={notifTone(n)} dim={n.read} />
            )))}
        </div>

        {/* Reading pane — only rendered when the tab has selectable rows. */}
        {hasRows && (
          <div className="rounded-lg border border-border-raised bg-raised p-5">
            {selApproval && (
              <ApprovalDetail
                row={selApproval}
                decisionState={decisionStates[selApproval.approvalId]}
                disabled={bulkBusy}
                onApprove={() => onDecide(selApproval.approvalId, 'approve')}
                onReject={() => onDecide(selApproval.approvalId, 'reject')}
              />
            )}
            {selPlan && (
              <PlanProposalDetail
                row={selPlan}
                busy={planBusy === selPlan.id}
                onApprove={() => onDecidePlan(selPlan.id, 'approve')}
                onReject={() => onDecidePlan(selPlan.id, 'reject')}
              />
            )}
            {selNotif?.workflowCapability ? (
              <WorkflowCapabilityCard
                gate={selNotif.workflowCapability}
                title={selNotif.title}
                body={selNotif.body}
                createdAt={selNotif.createdAt}
                busy={capabilityBusy === selNotif.id}
                globallyBusy={capabilityBusy !== null}
                onResolve={(choice) => { void onResolveCapability(selNotif.workflowCapability as WorkflowCapabilityInboxGate, choice); }}
              />
            ) : selNotif ? (
              <NotifDetail row={selNotif} onRead={() => onRead(selNotif.id)} onRetry={() => onRetry(selNotif.id)} />
            ) : null}
            {!selApproval && !selPlan && !selNotif && (
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

function WorkspaceChooserCard({ chooser, busy, onChoose }: {
  chooser: WorkspaceDestinationChooser;
  busy: boolean;
  onChoose: (choiceId: string) => void;
}) {
  return (
    <div className="rounded-md border border-primary/40 bg-primary-tint/40 px-3.5 py-3">
      <div className="flex w-full items-start gap-3">
        <StatusPill tone="live">Workspace</StatusPill>
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">Where should these records live?</div>
          <div className="mt-1 text-caption text-muted">
            Choose an exact existing Workspace, or have Clem stage a separate new-Workspace approval.
          </div>
        </div>
        <span className="shrink-0 text-caption text-faint">{relativeTime(chooser.createdAt)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {chooser.choices.map((choice) => (
          <Button
            key={choice.choiceId}
            size="sm"
            {...(choice.kind === 'create_new' ? { variant: 'secondary' as const } : {})}
            disabled={busy}
            onClick={() => onChoose(choice.choiceId)}
          >
            {busy
              ? 'Saving…'
              : choice.kind === 'existing' ? `${choice.label} (${choice.workspaceId})` : choice.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function InboxQuestionCard({ row, selected, answer, busy, globallyBusy, onSelect, onAnswerChange, onSubmit }: {
  row: InboxQuestionRow;
  selected: boolean;
  answer: string;
  busy: boolean;
  globallyBusy: boolean;
  onSelect: () => void;
  onAnswerChange: (answer: string) => void;
  onSubmit: (option?: string) => void;
}) {
  const disabled = globallyBusy || !row.answerable;
  return (
    <div id={`inbox-${row.id}`} className={cn('rounded-md border bg-warning-tint px-3.5 py-3', selected ? 'border-primary' : 'border-warning/40')}>
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left cursor-pointer">
        <StatusPill tone="warning">Question</StatusPill>
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">{row.question}</div>
          <div className="mt-1 text-caption text-muted">
            {row.agentLabel} · {row.source === 'workflow' ? 'workflow' : row.source === 'background_task' ? 'task' : 'check-in'} · {relativeTime(row.askedAt)}
          </div>
        </div>
      </button>
      {row.context && <p className="mt-2 whitespace-pre-wrap text-small text-muted">{row.context}</p>}
      {row.unavailableReason && <p role="status" className="mt-2 text-small text-warning">{row.unavailableReason}</p>}
      {row.options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {row.options.map((option) => (
            <Button key={option} size="sm" variant="secondary" disabled={disabled} onClick={() => onSubmit(option)}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Answer {row.question}</span>
          <textarea
            rows={2}
            value={answer}
            disabled={disabled}
            onChange={(event) => onAnswerChange(event.target.value)}
            placeholder={row.answerable ? 'Type the answer Clem needs…' : 'Open the authorized origin to answer'}
            className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
          />
        </label>
        <Button disabled={disabled || !answer.trim()} onClick={() => onSubmit()}>
          {busy ? 'Sending…' : 'Answer & resume'}
        </Button>
      </div>
    </div>
  );
}

function PlanProposalCard({ row, selected, busy, onSelect, onApprove, onReject }: {
  row: PlanProposalRow;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const questions = (row.plan.needsUserInput ?? []).filter((question) => typeof question === 'string' && question.trim());
  const needsInput = questions.length > 0;
  return (
    <div className={cn('rounded-md border px-3.5 py-3', selected ? 'border-primary bg-primary-tint' : 'border-warning/40 bg-warning-tint')}>
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left cursor-pointer">
        <StatusPill tone="warning">Plan</StatusPill>
        <span className="min-w-0 flex-1 text-body text-fg">{row.plan.objective || row.originatingRequest}</span>
        <span className="shrink-0 text-caption text-faint">{relativeTime(row.proposedAt)}</span>
      </button>
      <p className="mt-1 line-clamp-2 text-caption text-muted">{row.originatingRequest}</p>
      {needsInput && (
        <div className="mt-2 text-small text-muted">
          <p className="font-medium text-fg">Clem needs these answers before this plan can be approved:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{questions.map((question) => <li key={question}>{question}</li>)}</ul>
          {row.sessionId ? (
            <Link className="mt-2 inline-block font-medium text-primary hover:underline" to={`/chat/${encodeURIComponent(row.sessionId)}`}>
              Answer in the exact conversation
            </Link>
          ) : (
            <p role="status" className="mt-2 text-warning">This proposal has no linked conversation. Reject it and ask Clem to draft a new plan with your answers.</p>
          )}
        </div>
      )}
      <div className="mt-2.5 flex gap-2">
        {!needsInput && (
          <Button size="sm" disabled={busy} onClick={onApprove}>
            <Check className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Approve exact plan'}
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} onClick={onReject}>
          <X className="h-4 w-4" aria-hidden /> Reject
        </Button>
      </div>
    </div>
  );
}

function PlanProposalDetail({ row, busy, onApprove, onReject }: {
  row: PlanProposalRow;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const questions = (row.plan.needsUserInput ?? []).filter((question) => typeof question === 'string' && question.trim());
  const needsInput = questions.length > 0;
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{row.plan.objective || 'Proposed plan'}</h3>
      <Field label="Original request"><span className="whitespace-pre-wrap">{row.originatingRequest}</span></Field>
      {row.context && <Field label="Context"><span className="whitespace-pre-wrap">{row.context}</span></Field>}
      {row.sessionId && <Field label="Exact conversation"><span className="font-mono">{row.sessionId}</span></Field>}
      <Field label="Proposed">{relativeTime(row.proposedAt) || row.proposedAt}</Field>
      <Field label="Plan"><Mono value={row.plan} /></Field>
      {needsInput && (
        <Field label="Answers needed">
          <ul className="list-disc space-y-1 pl-5">{questions.map((question) => <li key={question}>{question}</li>)}</ul>
          {row.sessionId ? (
            <Link className="mt-2 inline-block font-medium text-primary hover:underline" to={`/chat/${encodeURIComponent(row.sessionId)}`}>
              Answer in the exact conversation
            </Link>
          ) : (
            <p className="mt-2 text-warning">No linked conversation is available. Reject this proposal and ask Clem for a new plan after supplying the answers.</p>
          )}
        </Field>
      )}
      <div className="mt-4 flex gap-2">
        {!needsInput && <Button disabled={busy} onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Approve & continue'}</Button>}
        <Button variant="secondary" disabled={busy} onClick={onReject}><X className="h-4 w-4" aria-hidden /> Reject</Button>
      </div>
    </div>
  );
}

function WorkflowCapabilityCard({ gate, title, body, createdAt, busy, globallyBusy, onResolve }: {
  gate: WorkflowCapabilityInboxGate;
  title?: string;
  body?: string;
  createdAt?: string;
  busy: boolean;
  globallyBusy: boolean;
  onResolve: (choice?: WorkflowCapabilityAccountChoice) => void;
}) {
  const resolution = gate.resolution;
  return (
    <div id={`inbox-${gate.notificationId}`} className="rounded-md border border-warning/40 bg-warning-tint px-3.5 py-3" aria-busy={busy}>
      <div className="flex items-start gap-3">
        <StatusPill tone="warning">Workflow</StatusPill>
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">{title || `${gate.workflow} needs you`}</div>
          <div className="mt-1 text-caption text-muted">{gate.workflow} · step {gate.stepId} · {relativeTime(createdAt)}</div>
        </div>
      </div>
      {body && <p className="mt-2 whitespace-pre-wrap text-small text-muted">{body}</p>}
      <p className="mt-2 text-caption text-muted">No {gate.tool} dispatch occurred. Completed work is preserved.</p>
      {resolution.kind === 'choose_account' ? (
        <div className="mt-3 space-y-2" aria-label={`Exact ${gate.toolkit} account choices`}>
          {resolution.candidates.map((candidate) => (
            <div key={`${candidate.capabilityId}\u0000${candidate.accountId}`} className="rounded border border-border bg-surface p-2.5">
              <div className="text-small font-medium text-fg">{candidate.label}</div>
              <div className="break-all font-mono text-caption text-faint">account {candidate.accountId}</div>
              <div className="break-all font-mono text-caption text-faint">capability {candidate.capabilityId}</div>
              <Button className="mt-2" size="sm" disabled={globallyBusy} onClick={() => onResolve(candidate)}>
                {busy ? 'Saving…' : `Use ${candidate.label}`}
              </Button>
            </div>
          ))}
          {resolution.choicesTruncated && <p className="text-caption text-warning">Showing {resolution.candidates.length} of {resolution.choiceTotal} exact choices. Connect fewer accounts or choose one shown here.</p>}
        </div>
      ) : resolution.kind === 'connect_and_retry' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link to="/connect" className="rounded-md border border-border bg-surface px-3 py-1.5 text-small font-medium text-primary hover:bg-hover">Open Connections</Link>
          <Button size="sm" disabled={globallyBusy} onClick={() => onResolve()}>{busy ? 'Resuming…' : 'I connected it — resume this run'}</Button>
        </div>
      ) : resolution.kind === 'retry_exact_metadata' ? (
        <div className="mt-3"><Button size="sm" disabled={globallyBusy} onClick={() => onResolve()}>{busy ? 'Retrying…' : 'Retry exact metadata now'}</Button></div>
      ) : (
        <div className="mt-3">
          <p role="status" className="text-small text-warning">{resolution.reason}</p>
          <Link to="/automate" className="mt-2 inline-block font-medium text-primary hover:underline">Review the preserved run</Link>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  row,
  selected,
  checked,
  decisionState,
  disabled,
  onToggleCheck,
  onSelect,
  onApprove,
  onReject,
}: {
  row: ApprovalRow; selected: boolean; checked: boolean; onToggleCheck: () => void;
  decisionState?: RowDecisionState; disabled?: boolean;
  onSelect: () => void; onApprove: () => void; onReject: () => void;
}) {
  const queued = row.pendingAction;
  const busy = disabled || decisionState?.busy === true;
  return (
    <div className={cn('rounded-md border px-3.5 py-3 transition-colors',
      selected ? 'border-primary bg-primary-tint' : 'border-warning/40 bg-warning-tint')}>
      <div className="flex w-full items-start gap-3">
        <input type="checkbox" aria-label="Select for bulk action"
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          disabled={busy}
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
        <Button size="sm" disabled={busy} onClick={onApprove}>
          {queued ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          {decisionState?.busy && decisionState.intent === 'approve'
            ? 'Approving…'
            : queued ? 'Approve & continue' : 'Approve'}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onReject}>
          <X className="h-4 w-4" aria-hidden />
          {decisionState?.busy && decisionState.intent === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
      {decisionState?.notice && (
        <p
          role={decisionState.notice.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'mt-2 text-caption',
            decisionState.notice.tone === 'error' ? 'text-danger' : 'text-success',
          )}
        >
          {decisionState.notice.text}
        </p>
      )}
    </div>
  );
}

function TrustProposalCard({ row, busy, globallyBusy, onApprove, onDecline }: {
  row: TrustProposalRow; busy: boolean; globallyBusy: boolean; onApprove: () => void; onDecline: () => void;
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
        <Button size="sm" disabled={globallyBusy} onClick={onApprove}>
          <Check className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Approve'}
        </Button>
        <Button size="sm" variant="secondary" disabled={globallyBusy} onClick={onDecline}>
          <X className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Decline'}
        </Button>
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

function ApprovalDetail({
  row,
  decisionState,
  disabled,
  onApprove,
  onReject,
}: {
  row: ApprovalRow;
  decisionState?: RowDecisionState;
  disabled?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const queued = row.pendingAction;
  const busy = disabled || decisionState?.busy === true;
  return (
    <div>
      <h3 className="mb-3 text-h3 text-fg">{queued ? `Ready for approval: ${queued.title}` : row.subject}</h3>
      {queued && <PendingActionDetail action={queued} />}
      <Field label="Tool">{row.tool || '—'}</Field>
      {row.sessionId && <Field label="From session">{row.sessionId}</Field>}
      <Field label="Requested">{relativeTime(row.requestedAt) || '—'}</Field>
      <Field label="Details"><Mono value={row.args} /></Field>
      <div className="mt-4 flex gap-2">
        <Button disabled={busy} onClick={onApprove}>
          {queued ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          {decisionState?.busy && decisionState.intent === 'approve'
            ? 'Approving…'
            : queued ? 'Approve & continue' : 'Approve'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onReject}>
          <X className="h-4 w-4" aria-hidden />
          {decisionState?.busy && decisionState.intent === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
      {decisionState?.notice && (
        <p
          role={decisionState.notice.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'mt-2 text-small',
            decisionState.notice.tone === 'error' ? 'text-danger' : 'text-success',
          )}
        >
          {decisionState.notice.text}
        </p>
      )}
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
