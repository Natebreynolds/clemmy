import { APPROVAL_ANSWER_WORDS } from '@clem/chat-engine';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, RefreshCw, Mail, BellRing, Send, MoreHorizontal } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { setWorkflowEnabled } from '@/lib/automate';
import { usePoll } from '@/lib/poll';
import { ProjectLabelTag } from '@/components/projects/ProjectLabelTag';
import { useProjectLabels, type SessionProjectLabel } from '@/lib/project-labels';
import { applyTidy, describeTidy } from '@/lib/tidy';
import { cn } from '@/lib/cn';
import { plainText } from '@/components/home/home-model';
import { linkify } from '@/lib/linkify';
import { useMediaQuery } from '@/lib/use-media-query';
import { attentionDestination, buildNeedsYouItems, isIdentifierLike, needsYouRowView, type NeedsYouItem, type NeedsYouRowView } from '@/lib/needs-you-list';
import { DecisionFrame, DecisionRow, Disclosure } from '@/components/inbox/DecisionList';
import {
  listApprovals, decideApproval, cancelStaleApprovals,
  listWorkspaceDestinationChoosers, resolveWorkspaceDestinationChooser,
  listNotifications, markNotificationRead, retryNotification,
  listTrustProposals, decideTrustProposal,
  listPlanProposals, decidePlanProposal,
  listInboxQuestions, answerInboxQuestion,
  resolveWorkflowCapability,
  relativeTime,
  approvalDecisionSuccessText, collapseAttentionRows, getNeedsYouSummary, notifTone, notifFailed,
  summarizeApprovalDecisionBatch,
  type ApprovalRow, type NotificationRow, type TrustProposalRow, type PlanProposalRow, type InboxQuestionRow,
  type WorkspaceDestinationChooser, type WorkflowCapabilityAccountChoice, type WorkflowCapabilityInboxGate,
} from '@/lib/inbox';

/** Decisions and blocks belong on "Needs you" beside approvals. The server
 *  decides which those are (runtime/notifications.ts) and says so on every
 *  row; a second rule here read titles and disagreed with it — "paused" and
 *  "needs you" in a title counted on the desktop and nowhere else. */
function needsAttentionNotif(n: NotificationRow): boolean {
  return n.needsAttention === true;
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
  const userPicked = useRef(false);
  // Wide: list beside one detail. Narrow: the list, or one decision with Back.
  const wide = useMediaQuery('(min-width: 1024px)');
  const [opened, setOpened] = useState(Boolean(searchParams.get('select')));
  const pick = (id: string | null) => { userPicked.current = id !== null; setSelected(id); setOpened(id !== null); };
  // What the auto-select effect may open, refreshed every render.
  const needsViewsRef = useRef<NeedsYouRowView[]>([]);
  const plainNotifIdsRef = useRef<string[]>([]);
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
  // The one count (dashboard/needs-you.ts): the same total the sidebar and the
  // phone show, plus rows no other feed carries.
  const needsSummary = usePoll(['needs-you-summary'], getNeedsYouSummary, 8000);

  const approvalRows = approvals.data?.approvals ?? [];
  const workspaceChooserRows = workspaceChoosers.data?.choosers ?? [];
  // Server sorts urgent-first; aged cards (48h+ unanswered, nothing parked on
  // them) render below a divider and stop counting toward "needs you".
  const urgentApprovalRows = approvalRows.filter((a) => !a.stale);
  const notifRows = notifications.data?.notifications ?? [];
  const trustRows = trustProposals.data?.proposals ?? [];
  const planRows = planProposals.data?.proposals ?? [];
  const questionRows = questions.data?.questions ?? [];
  // Which project each waiting item belongs to, by the session that asked.
  const projectOf = useProjectLabels([...approvalRows, ...planRows, ...questionRows]);
  // The detail pane never sits empty next to a list: the first decision opens
  // itself until the person picks another ("Pick something on the left" was
  // a blank slab beside fifty-one buttons, live 09-26).
  // On a wide screen the detail opens the first decision of any kind, so it
  // is never an empty pane beside the list. A narrow screen waits for a tap.
  useEffect(() => {
    if (!wide || userPicked.current) return;
    const ids = tab === 'needs' ? needsViewsRef.current.filter((view) => !view.href).map((view) => view.id) : plainNotifIdsRef.current;
    if (selected && ids.includes(selected)) return;
    const first = ids[0] ?? null;
    if (first !== selected) setSelected(first);
  });
  // Unread needs-attention notifications are DECISIONS → they live on "Needs you"
  // beside approvals (and leave once read); everything else stays in Notifications.
  // A carrier for a decision already on this list as a card is that decision.
  const listedDecisionKeys = new Set([
    ...approvalRows.map((row) => `approval:${row.approvalId}`),
    ...planRows.map((row) => `plan:${row.id}`),
    ...trustRows.map((row) => `trust:${row.id}`),
    ...questionRows.map((row) => row.id),
  ]);
  const attentionRows = notifRows.filter((n) => !n.read && needsAttentionNotif(n)
    && !(n.needsYouKey && listedDecisionKeys.has(n.needsYouKey)));
  const attentionIds = new Set(attentionRows.map((n) => n.id));
  const plainNotifRows = notifRows.filter((n) => !attentionIds.has(n.id));
  plainNotifIdsRef.current = plainNotifRows.map((n) => n.id);
  // A burst of blocked runs from one workflow is ONE decision, not ten rows —
  // collapse duplicates to the newest and badge the earlier ones.
  const collapsedAttention = collapseAttentionRows(attentionRows);
  const unlistedRows = needsSummary.data?.unlisted ?? [];
  // One list for every kind of decision; how each row reads is decided once.
  const needsItems = useMemo(() => buildNeedsYouItems({
    workspaceChoosers: workspaceChooserRows,
    questions: questionRows,
    plans: planRows,
    approvals: approvalRows,
    trust: trustRows,
    attention: collapsedAttention,
    unlisted: unlistedRows,
  }), [workspaceChooserRows, questionRows, planRows, approvalRows, trustRows, collapsedAttention, unlistedRows]);
  const needsViews = useMemo(() => needsItems.map(needsYouRowView), [needsItems]);
  needsViewsRef.current = needsViews;
  // The badge is the server's total whenever it has answered: the sidebar and
  // the phone show that same number. The local sum is only the fallback.
  const needsCount = needsSummary.data?.total
    ?? (workspaceChooserRows.length + urgentApprovalRows.length + collapsedAttention.length + trustRows.length + planRows.length + questionRows.length + unlistedRows.length);
  const anyDecisionRows = workspaceChooserRows.length + approvalRows.length + collapsedAttention.length + trustRows.length + planRows.length + questionRows.length + unlistedRows.length;
  // Count only checked IDs that still exist in the live list — resolved cards
  // drop out on the next poll and must not keep inflating the bulk-action count.
  const checkedCount = approvalRows.reduce((n, a) => (checked.has(a.approvalId) ? n + 1 : n), 0);
  const queryUnavailable = tab === 'needs'
    ? approvals.isError || workspaceChoosers.isError || notifications.isError || trustProposals.isError || planProposals.isError || questions.isError
    : notifications.isError;
  // Gate the reading pane on the SAME denominator the list renders from.
  // `needsCount` excludes stale approvals; `anyDecisionRows` does not — so with
  // only aged approvals pending, every card still drew and stayed clickable
  // while the pane that shows tool, session, requested-at and the full args
  // never mounted. The click went nowhere, on the one screen whose whole job
  // is to let a decision land.
  const hasRows = !queryUnavailable && (tab === 'needs' ? anyDecisionRows : plainNotifRows.length) > 0;
  const unread = plainNotifRows.filter((n) => !n.read).length;

  // Every decision moves the one count too, so the badge never lags the list.
  const invalidate = (...keys: string[]) => [...keys, 'needs-you-summary'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));

  const onDecide = async (id: string, decision: 'approve' | 'reject', note?: string) => {
    const row = approvalRows.find((a) => a.approvalId === id);
    if (!row || decisionStates[id]?.busy || bulkBusy) return;
    setDecisionStates((prev) => ({ ...prev, [id]: { busy: true, intent: decision } }));
    setDecisionNotice(null);
    try {
      const result = await decideApproval(id, decision, { kind: row.kind, ...(note ? { note } : {}) });
      const notice: DecisionNotice = {
        tone: 'success',
        text: approvalDecisionSuccessText(row, decision, result, note),
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
  // "Clear all" on Needs you goes through tidy with the all scope: every
  // approval card, plan and trust proposal and check-in is settled as
  // declined. It asks once, because it decides things.
  const [confirmClearAsks, setConfirmClearAsks] = useState(false);
  const onClearAsks = async () => {
    setConfirmClearAsks(false);
    setDecisionNotice(null);
    try {
      const { result } = await applyTidy(['staleAsks'], 'all');
      setDecisionNotice({ tone: 'success', text: describeTidy(result) });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not clear the asks.') });
    } finally {
      invalidate('approvals', 'approvals-count', 'plan-proposals', 'trust-proposals', 'inbox-questions', 'working-now-badge', 'command-center');
    }
  };
  // "Clear all" on Updates goes through tidy: every unread update that is
  // not still a question is marked read, in one call, with the same live
  // guards the phone uses. Nothing is deleted.
  const onClearUpdates = async () => {
    setDecisionNotice(null);
    try {
      const { result } = await applyTidy(['updates']);
      setDecisionNotice({ tone: 'success', text: describeTidy(result) });
    } catch (error) {
      setDecisionNotice({ tone: 'error', text: actionError(error, 'Could not clear the updates.') });
    } finally {
      invalidate('notifications', 'command-center');
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

  const selItem = tab === 'needs' ? needsItems.find((item) => item.id === selected) : undefined;
  const selView = selItem ? needsViews.find((view) => view.id === selItem.id) : undefined;
  const selNotif = tab === 'notifications' ? plainNotifRows.find((n) => n.id === selected) : undefined;
  // Narrow screens show one surface at a time: the list, or the opened decision.
  const showList = wide || !opened || (!selItem && !selNotif);
  const showDetail = hasRows && (wide || (opened && Boolean(selItem || selNotif)));
  const back = wide ? undefined : () => { setOpened(false); userPicked.current = false; };

  const firstAgedIndex = needsViews.findIndex((view) => view.aged);
  const cleanupMenu = tab === 'needs' && anyDecisionRows > 0 ? (
    confirmClearAsks ? (
      <span className="inline-flex flex-wrap items-center gap-2 text-small text-muted">
        Decline all {needsCount} pending decisions? Nothing is sent or approved.
        <Button variant="danger" size="sm" onClick={onClearAsks}>Decline all</Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmClearAsks(false)}>Keep them</Button>
      </span>
    ) : (
      <details className="relative">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-small text-muted hover:bg-hover hover:text-fg">
          <MoreHorizontal className="h-4 w-4" aria-hidden /> Clean up
        </summary>
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-border-raised bg-raised p-1.5 shadow-lg">
          {approvalRows.length > 0 && (
            <button type="button" onClick={onCancelStale} className="block w-full rounded px-3 py-2 text-left hover:bg-hover">
              <span className="block text-small font-medium text-fg">Cancel approvals waiting over an hour</span>
              <span className="block text-caption text-muted">Each request is cancelled; nothing is sent.</span>
            </button>
          )}
          <button type="button" onClick={() => setConfirmClearAsks(true)} className="block w-full rounded px-3 py-2 text-left hover:bg-hover">
            <span className="block text-small font-medium text-danger">Decline all {needsCount} decisions…</span>
            <span className="block text-caption text-muted">Approvals, plans, suggestions and check-ins are declined.</span>
          </button>
        </div>
      </details>
    )
  ) : tab === 'notifications' && unread > 0
    ? <Button variant="secondary" size="sm" onClick={onClearUpdates}><Check className="h-4 w-4" aria-hidden /> Mark all {unread} read</Button>
    : undefined;

  return (
    <Page
      title="Needs you"
      subtitle="Decisions waiting on you, and updates from finished work"
      actions={cleanupMenu}
    >
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); userPicked.current = false; setSelected(null); setOpened(false); }}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-body font-medium cursor-pointer -mb-px',
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

      <div className={cn('grid gap-4', hasRows && wide && 'grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]')}>
        {showList && (
          <div className="min-w-0 space-y-2">
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
                  {checkedCount > 0 && (
                    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-subtle px-3.5 py-2">
                      <span className="text-body text-fg">{checkedCount} approval{checkedCount === 1 ? '' : 's'} selected</span>
                      <div className="ml-auto flex gap-2">
                        <Button size="sm" disabled={bulkBusy} onClick={() => onBulkDecide('approve')}>
                          <Check className="h-4 w-4" aria-hidden /> Approve {checkedCount}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => onBulkDecide('reject')}>
                          <X className="h-4 w-4" aria-hidden /> Decline {checkedCount}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setChecked(new Set())}>Clear selection</Button>
                      </div>
                    </div>
                  )}
                  <ul className="overflow-hidden rounded-lg border border-border bg-surface divide-y divide-border" aria-label="Decisions waiting on you">
                    {needsViews.map((view, index) => (
                      <li key={view.id}>
                        {index === firstAgedIndex && (
                          <div className="bg-subtle px-3.5 py-1.5 text-caption text-muted">Older approvals — waiting 2+ days, still approvable</div>
                        )}
                        <DecisionRow
                          view={view}
                          selected={selected === view.id}
                          checked={checked.has(view.id)}
                          disabled={bulkBusy || decisionStates[view.id]?.busy === true}
                          onToggleCheck={() => toggleChecked(view.id)}
                          onSelect={() => pick(view.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ))}

            {!loading && !queryUnavailable && tab === 'notifications' && (plainNotifRows.length === 0
              ? <EmptyState title="No notifications" description="Updates from completed work will appear here." />
              : (
                <ul className="overflow-hidden rounded-lg border border-border bg-surface divide-y divide-border" aria-label="Notifications">
                  {plainNotifRows.map((n) => (
                    <li key={n.id}>
                      <ListRow selected={selected === n.id} onSelect={() => pick(n.id)}
                        title={n.title || n.body || 'Notification'} meta={relativeTime(n.createdAt)}
                        tone={notifTone(n)} dim={n.read} />
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        )}

        {/* The one place a selected item is read and decided. Sized to what it
            shows, kept in view while the list scrolls, actions in its footer. */}
        {showDetail && (
          <div className={cn(
            'flex min-w-0 flex-col self-start rounded-lg border border-border-raised bg-raised p-5',
            wide && 'sticky top-4 max-h-[calc(100vh-8rem)]',
          )}>
            {selItem && selView ? (
              <NeedsYouDetail
                key={selItem.id}
                item={selItem}
                view={selView}
                project={'row' in selItem && (selItem.kind === 'question' || selItem.kind === 'plan' || selItem.kind === 'approval') ? projectOf(selItem.row) : undefined}
                onBack={back}
                approval={{ decisionState: selItem.kind === 'approval' ? decisionStates[selItem.id] : undefined, disabled: bulkBusy,
                  onApprove: () => onDecide(selItem.id, 'approve'), onReject: (note?: string) => onDecide(selItem.id, 'reject', note) }}
                plan={{ busy: planBusy === selItem.id, onApprove: () => onDecidePlan(selItem.id, 'approve'), onReject: () => onDecidePlan(selItem.id, 'reject') }}
                question={{ answer: questionAnswers[selItem.id] ?? '', busy: questionBusy === selItem.id, globallyBusy: questionBusy !== null,
                  onAnswerChange: (answer: string) => setQuestionAnswers((previous) => ({ ...previous, [selItem.id]: answer })),
                  onSubmit: (option?: string) => { if (selItem.kind === 'question') void onAnswerQuestion(selItem.row, option); } }}
                workspace={{ busy: selItem.kind === 'workspace' && chooserBusy === selItem.id,
                  onChoose: (choiceId: string) => { if (selItem.kind === 'workspace') void onChooseWorkspace(selItem.row, choiceId); } }}
                trust={{ busy: trustBusy === selItem.id, globallyBusy: trustBusy !== null,
                  onApprove: () => { if (selItem.kind === 'trust') void onDecideTrust(selItem.row, 'approve'); },
                  onDecline: () => { if (selItem.kind === 'trust') void onDecideTrust(selItem.row, 'decline'); } }}
                capability={{ busy: capabilityBusy === selItem.id, globallyBusy: capabilityBusy !== null,
                  onResolve: (choice?: WorkflowCapabilityAccountChoice) => {
                    if (selItem.kind === 'attention' && selItem.row.workflowCapability) void onResolveCapability(selItem.row.workflowCapability, choice);
                  } }}
                notification={{ onRead: () => onRead(selItem.id), onRetry: () => onRetry(selItem.id) }}
              />
            ) : selNotif ? (
              <NotifDetail key={selNotif.id} row={selNotif} onRead={() => onRead(selNotif.id)} onRetry={() => onRetry(selNotif.id)} onBack={back} />
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center gap-1 text-center">
                <p className="text-body font-medium text-fg">Pick something on the left</p>
                <p className="text-small text-muted">You’ll see the details and what happens when you decide.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

/** A notification row: the same quiet one-line shape as a decision row. */
function ListRow({ title, meta, tone, selected, onSelect, dim }: {
  title: string; meta: string; tone: { tone: Parameters<typeof StatusPill>[0]['tone']; label: string };
  selected: boolean; onSelect: () => void; dim?: boolean;
}) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={cn('flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors cursor-pointer',
        selected ? 'bg-primary-tint' : 'hover:bg-hover', dim && 'opacity-60')}>
      <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
      <span className="min-w-0 flex-1 truncate text-body text-fg">{plainText(title, 200)}</span>
      {meta && <span className="shrink-0 text-caption text-faint">{meta}</span>}
    </button>
  );
}

type ApprovalHandlers = { decisionState?: RowDecisionState; disabled: boolean; onApprove: () => void; onReject: (note?: string) => void };
type PlanHandlers = { busy: boolean; onApprove: () => void; onReject: () => void };
type QuestionHandlers = { answer: string; busy: boolean; globallyBusy: boolean; onAnswerChange: (answer: string) => void; onSubmit: (option?: string) => void };
type WorkspaceHandlers = { busy: boolean; onChoose: (choiceId: string) => void };
type TrustHandlers = { busy: boolean; globallyBusy: boolean; onApprove: () => void; onDecline: () => void };
type CapabilityHandlers = { busy: boolean; globallyBusy: boolean; onResolve: (choice?: WorkflowCapabilityAccountChoice) => void };
type NotificationHandlers = { onRead: () => void; onRetry: () => void };

/** The selected decision, whatever its kind, in the one detail shape. */
function NeedsYouDetail({ item, view, project, onBack, approval, plan, question, workspace, trust, capability, notification }: {
  item: NeedsYouItem;
  view: NeedsYouRowView;
  project?: SessionProjectLabel;
  onBack?: () => void;
  approval: ApprovalHandlers;
  plan: PlanHandlers;
  question: QuestionHandlers;
  workspace: WorkspaceHandlers;
  trust: TrustHandlers;
  capability: CapabilityHandlers;
  notification: NotificationHandlers;
}) {
  switch (item.kind) {
    case 'approval': return <ApprovalDetail row={item.row} view={view} project={project} onBack={onBack} {...approval} />;
    case 'plan': return <PlanDetail row={item.row} view={view} project={project} onBack={onBack} {...plan} />;
    case 'question': return <QuestionDetail row={item.row} view={view} project={project} onBack={onBack} {...question} />;
    case 'workspace': return <WorkspaceDetail chooser={item.row} view={view} onBack={onBack} {...workspace} />;
    case 'trust': return <TrustDetail row={item.row} view={view} onBack={onBack} {...trust} />;
    case 'attention': return item.row.workflowCapability
      ? <CapabilityDetail gate={item.row.workflowCapability} row={item.row} view={view} onBack={onBack} {...capability} />
      : <NotifDetail row={item.row} view={view} onBack={onBack} destination={attentionDestination(item.row.needsYouKey)} {...notification} />;
    case 'unlisted': return (
      <DecisionFrame view={view} title={item.row.title} onBack={onBack}
        actions={view.href ? <Link to={view.href} className="text-small font-medium text-primary hover:underline">Open</Link> : undefined}>
        {item.row.detail && <p className="whitespace-pre-wrap">{item.row.detail}</p>}
      </DecisionFrame>
    );
  }
}

/** The name alone; the identifier is a caption, never part of the title. */
function workspaceChoiceTitle(choice: { label: string; workspaceId: string }): string {
  const label = choice.label.trim();
  const suffix = ` (${choice.workspaceId})`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length).trim() : label;
}

/** Up to three Workspaces are buttons; more is a picker with one "Use" button
 *  (fifty-one buttons was a wall, live 09-26). "Prepare a new one" is always its own. */
function WorkspaceChoices({ chooser, busy, onChoose }: {
  chooser: WorkspaceDestinationChooser;
  busy: boolean;
  onChoose: (choiceId: string) => void;
}) {
  const existing = chooser.choices.filter((choice) => choice.kind === 'existing');
  const createNew = chooser.choices.find((choice) => choice.kind === 'create_new');
  const [picked, setPicked] = useState(existing[0]?.choiceId ?? '');
  const pickedChoice = existing.find((choice) => choice.choiceId === picked) ?? existing[0];
  if (existing.length > 3) {
    return (
      <>
        <select
          aria-label="Existing Workspaces"
          className="min-w-[16rem] max-w-full rounded-md border border-border bg-canvas px-2.5 py-1.5 text-small text-fg"
          value={pickedChoice?.choiceId ?? ''}
          disabled={busy}
          onChange={(e) => setPicked(e.target.value)}
        >
          {existing.map((choice) => <option key={choice.choiceId} value={choice.choiceId}>{workspaceChoiceTitle(choice)}</option>)}
        </select>
        <Button size="sm" disabled={busy || !pickedChoice} onClick={() => { if (pickedChoice) onChoose(pickedChoice.choiceId); }}>
          {busy ? 'Saving…' : `Use ${pickedChoice ? workspaceChoiceTitle(pickedChoice) : 'this'}`}
        </Button>
        {createNew ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose(createNew.choiceId)}>Prepare a new one</Button> : null}
      </>
    );
  }
  return (
    <>
      {chooser.choices.map((choice) => (
        <Button
          key={choice.choiceId}
          size="sm"
          {...(choice.kind === 'create_new' ? { variant: 'secondary' as const } : {})}
          disabled={busy}
          onClick={() => onChoose(choice.choiceId)}
          title={choice.kind === 'existing' ? choice.workspaceId : undefined}
        >
          {busy ? 'Saving…' : choice.kind === 'existing' ? workspaceChoiceTitle(choice) : choice.label}
        </Button>
      ))}
    </>
  );
}

function WorkspaceDetail({ chooser, view, busy, onChoose, onBack }: WorkspaceHandlers & {
  chooser: WorkspaceDestinationChooser; view: NeedsYouRowView; onBack?: () => void;
}) {
  const existing = chooser.choices.filter((choice) => choice.kind === 'existing');
  return (
    <DecisionFrame view={view} title="Where should these records live?" onBack={onBack}
      actions={<WorkspaceChoices chooser={chooser} busy={busy} onChoose={onChoose} />}>
      <p className="text-muted">Choose an existing Workspace, or have Clem prepare a new one. A new Workspace is its own approval.</p>
      {existing.length > 0 && (
        <Disclosure summary={`Workspace identifiers (${existing.length})`}>
          <ul className="space-y-1">
            {existing.map((choice) => (
              <li key={choice.choiceId}>{workspaceChoiceTitle(choice)} <span className="font-mono text-caption text-faint">{choice.workspaceId}</span></li>
            ))}
          </ul>
        </Disclosure>
      )}
    </DecisionFrame>
  );
}

function QuestionDetail({ row, view, project, answer, busy, globallyBusy, onAnswerChange, onSubmit, onBack }: QuestionHandlers & {
  row: InboxQuestionRow; view: NeedsYouRowView; project?: SessionProjectLabel; onBack?: () => void;
}) {
  const disabled = globallyBusy || !row.answerable;
  return (
    <DecisionFrame view={view} title={row.question} onBack={onBack}
      aside={project ? <ProjectLabelTag label={project} link /> : undefined}
      actions={(
        <>
          {row.options.map((option) => (
            <Button key={option} size="sm" variant="secondary" disabled={disabled} onClick={() => onSubmit(option)}>{option}</Button>
          ))}
          <form className="flex basis-full items-end gap-2" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
            <label className="min-w-0 flex-1">
              <span className="sr-only">Answer {row.question}</span>
              <textarea
                rows={2}
                value={answer}
                disabled={disabled}
                onChange={(event) => onAnswerChange(event.target.value)}
                placeholder={row.answerable ? (row.options.length > 0 ? 'Or type your own answer…' : 'Type your answer…') : 'Answer where this was asked'}
                className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
              />
            </label>
            <Button type="submit" disabled={disabled || !answer.trim()}>{busy ? 'Sending…' : 'Answer'}</Button>
          </form>
        </>
      )}>
      {row.context && (isIdentifierLike(row.context)
        ? <Disclosure summary="Reference"><span className="break-all font-mono text-caption text-muted">{row.context}</span></Disclosure>
        : <p className="whitespace-pre-wrap text-muted">{linkify(row.context)}</p>)}
      {row.unavailableReason && <p role="status" className="text-small text-muted">{row.unavailableReason}</p>}
      {row.sessionId && (
        <Link className="inline-block text-small font-medium text-primary hover:underline" to={`/chat/${encodeURIComponent(row.sessionId)}`}>
          Open the conversation
        </Link>
      )}
    </DecisionFrame>
  );
}

function PlanDetail({ row, view, project, busy, onApprove, onReject, onBack }: PlanHandlers & {
  row: PlanProposalRow; view: NeedsYouRowView; project?: SessionProjectLabel; onBack?: () => void;
}) {
  const questions = (row.plan.needsUserInput ?? []).filter((question) => typeof question === 'string' && question.trim());
  const needsInput = questions.length > 0;
  const steps = (row.plan.steps ?? []).filter((step) => (step.action || step.description)?.trim());
  const conversation = row.sessionId ? `/chat/${encodeURIComponent(row.sessionId)}` : null;
  return (
    <DecisionFrame view={view} title={row.plan.objective || 'Proposed plan'} onBack={onBack}
      aside={project ? <ProjectLabelTag label={project} link /> : undefined}
      actions={(
        <>
          {needsInput
            ? conversation && <Link to={conversation} className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-body font-medium text-primary-fg hover:bg-primary-hover active:bg-primary-press">Answer in the conversation</Link>
            : <Button disabled={busy} onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Approve & continue'}</Button>}
          <Button variant="secondary" disabled={busy} onClick={onReject}><X className="h-4 w-4" aria-hidden /> Decline</Button>
        </>
      )}>
      <Field label="You asked"><span className="whitespace-pre-wrap">{row.originatingRequest}</span></Field>
      {needsInput && (
        <Field label="Answers needed first">
          <ul className="list-disc space-y-1 pl-5">{questions.map((question) => <li key={question}>{question}</li>)}</ul>
          {!conversation && <p className="mt-2 text-small text-muted">This plan has no linked conversation. Decline it and ask Clem for a new plan with your answers.</p>}
        </Field>
      )}
      {steps.length > 0 && (
        <Field label="Steps">
          <ol className="list-decimal space-y-1.5 pl-5">
            {steps.map((step, index) => <li key={step.id ?? index}>{step.action || step.description}</li>)}
          </ol>
        </Field>
      )}
      {row.context && <Disclosure summary="Why this plan"><span className="whitespace-pre-wrap">{row.context}</span></Disclosure>}
      <Disclosure summary="Technical details"><Mono value={row.plan} /></Disclosure>
      {conversation && !needsInput && (
        <Link className="inline-block text-small font-medium text-primary hover:underline" to={conversation}>Open the conversation</Link>
      )}
    </DecisionFrame>
  );
}

function CapabilityDetail({ gate, row, view, busy, globallyBusy, onResolve, onBack }: CapabilityHandlers & {
  gate: WorkflowCapabilityInboxGate; row: NotificationRow; view: NeedsYouRowView; onBack?: () => void;
}) {
  const resolution = gate.resolution;
  const [picked, setPicked] = useState(0);
  const candidates = resolution.kind === 'choose_account' ? resolution.candidates : [];
  const choice = candidates[picked] ?? candidates[0];
  return (
    <DecisionFrame view={view} title={row.title || `${gate.workflow} needs you`} onBack={onBack}
      actions={resolution.kind === 'choose_account' ? (
        <Button disabled={globallyBusy || !choice} onClick={() => { if (choice) onResolve(choice); }}>
          {busy ? 'Saving…' : `Use ${choice?.label ?? 'this account'} and resume`}
        </Button>
      ) : resolution.kind === 'connect_and_retry' ? (
        <>
          <Link to="/connect" className="rounded-md border border-border bg-surface px-3 py-1.5 text-small font-medium text-primary hover:bg-hover">Open Connections</Link>
          <Button disabled={globallyBusy} onClick={() => onResolve()}>{busy ? 'Resuming…' : 'I connected it — resume'}</Button>
        </>
      ) : resolution.kind === 'retry_exact_metadata' ? (
        <Button disabled={globallyBusy} onClick={() => onResolve()}>{busy ? 'Retrying…' : 'Retry now'}</Button>
      ) : (
        <Link to="/automate" className="text-small font-medium text-primary hover:underline">Review the run</Link>
      )}>
      {row.body && <p className="whitespace-pre-wrap">{linkify(row.body)}</p>}
      <p className="text-small text-muted">Nothing was sent through {gate.tool}. Steps that finished are kept, and the run resumes once.</p>
      {resolution.kind === 'choose_account' && (
        <fieldset className="space-y-1.5" aria-label={`${gate.toolkit} accounts`}>
          <legend className="mb-1 text-label text-faint">Which {gate.toolkit} account?</legend>
          {candidates.map((candidate, index) => (
            <label key={`${candidate.capabilityId}\u0000${candidate.accountId}`}
              className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2', index === picked ? 'border-primary bg-primary-tint' : 'border-border hover:bg-hover')}>
              <input type="radio" name={`account-${gate.notificationId}`} className="accent-primary" checked={index === picked} disabled={globallyBusy} onChange={() => setPicked(index)} />
              <span className="text-small text-fg">{candidate.label}</span>
            </label>
          ))}
          {resolution.choicesTruncated && <p className="text-caption text-muted">Showing {candidates.length} of {resolution.choiceTotal} accounts.</p>}
        </fieldset>
      )}
      {resolution.kind === 'review_run' && <p role="status" className="text-small text-muted">{resolution.reason}</p>}
      <Disclosure summary="Technical details">
        <div className="space-y-1 break-all font-mono text-caption text-muted">
          <div>workflow {gate.workflow} · run {gate.runId} · step {gate.stepId}</div>
          <div>tool {gate.tool} · {gate.reason}</div>
          {candidates.map((candidate) => (
            <div key={`${candidate.capabilityId}\u0000${candidate.accountId}`}>{candidate.label}: account {candidate.accountId} · capability {candidate.capabilityId}</div>
          ))}
        </div>
      </Disclosure>
    </DecisionFrame>
  );
}

function TrustDetail({ row, view, busy, globallyBusy, onApprove, onDecline, onBack }: TrustHandlers & {
  row: TrustProposalRow; view: NeedsYouRowView; onBack?: () => void;
}) {
  return (
    <DecisionFrame view={view} title={view.title} onBack={onBack}
      actions={(
        <>
          <Button disabled={globallyBusy} onClick={onApprove}><Check className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Approve'}</Button>
          <Button variant="secondary" disabled={globallyBusy} onClick={onDecline}><X className="h-4 w-4" aria-hidden /> {busy ? 'Saving…' : 'Decline'}</Button>
        </>
      )}>
      {row.rationale && <p className="whitespace-pre-wrap">{row.rationale}</p>}
      <p className="text-small text-muted">
        {row.evidence.cleanSendCount} clean sends over {row.evidence.distinctDays} days · via {row.toolkits.join(', ')} · up to {row.maxRecipients} recipients
      </p>
    </DecisionFrame>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
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

/** What is being approved, in full, with the decision in the footer: the
 *  draft and the call in words first; the exact payload behind a disclosure. */
function ApprovalDetail({ row, view, project, decisionState, disabled, onApprove, onReject, onBack }: ApprovalHandlers & {
  row: ApprovalRow; view: NeedsYouRowView; project?: SessionProjectLabel; onBack?: () => void;
}) {
  const queued = row.pendingAction;
  const busy = disabled || decisionState?.busy === true;
  const draft = row.contentPreview?.body?.trim() ?? '';
  const details = row.presentation?.details ?? [];
  // "Request changes": decline THIS draft and say what to change. The note
  // rides with the rejection and reaches the conversation that owns the run.
  const [changing, setChanging] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const isWorkflowGate = row.tool === 'workflow_approval_gate';
  // With Clem's question as the title, her why is the line under it — never
  // the raw tool name the summary falls back to.
  const voiced = !queued && Boolean(row.presentation?.ask);
  const summary = voiced ? row.presentation?.why : queued?.summary || row.summary;
  // Clem's own question when her checker wrote one; never an operation id.
  const title = queued?.title || row.presentation?.ask || row.presentation?.action || row.subject;
  return (
    <DecisionFrame view={view} title={title} onBack={onBack} notice={decisionState?.notice ?? null}
      aside={project ? <ProjectLabelTag label={project} link /> : undefined}
      actions={(
        <>
          <Button disabled={busy} onClick={onApprove}>
            {queued ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
            {decisionState?.busy && decisionState.intent === 'approve' ? 'Approving…' : queued ? 'Approve & continue' : voiced ? APPROVAL_ANSWER_WORDS.approve.replace(/\.$/, '') : 'Approve'}
          </Button>
          {isWorkflowGate && (
            <Button variant="secondary" disabled={busy} aria-expanded={changing} onClick={() => setChanging((open) => !open)}>
              Request changes
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => onReject()}>
            <X className="h-4 w-4" aria-hidden />
            {decisionState?.busy && decisionState.intent === 'reject' ? 'Declining…' : voiced ? APPROVAL_ANSWER_WORDS.reject.replace(/\.$/, '') : 'Decline'}
          </Button>
          {isWorkflowGate && changing && (
            <form
              className="flex basis-full flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!changeNote.trim()) return;
                onReject(changeNote.trim());
                setChanging(false);
              }}
            >
              <textarea
                value={changeNote}
                onChange={(event) => setChangeNote(event.target.value)}
                disabled={busy}
                rows={3}
                aria-label="What should change"
                placeholder="What should change in this draft?"
                className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-small text-fg outline-none placeholder:text-faint focus:border-border-strong disabled:opacity-50"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={busy || !changeNote.trim()}>Send changes</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(false)}>Cancel</Button>
                <span className="text-caption text-faint">The current draft stops and your note goes back to Clem to revise.</span>
              </div>
            </form>
          )}
        </>
      )}>
      {summary && summary !== title && <p className="text-muted">{summary}</p>}
      {draft && (
        <div aria-label="What you are approving">
          <div className="mb-1 text-label text-faint">Draft</div>
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-3 py-2">{draft}</p>
        </div>
      )}
      {queued?.targetSummary && <Field label="Goes to">{queued.targetSummary}</Field>}
      {queued?.preview && !draft && <Field label="Preview"><span className="whitespace-pre-wrap">{queued.preview}</span></Field>}
      {details.length > 0 ? (
        <div className="space-y-3" data-testid="approval-presentation">
          {details.map((line) => (
            line.long
              ? (
                <div key={line.label}>
                  <div className="mb-1 text-label text-faint">{line.label}</div>
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-subtle px-3 py-2">{line.value}</p>
                </div>
              )
              : <Field key={line.label} label={line.label}>{line.value}</Field>
          ))}
        </div>
      ) : !draft && !queued ? (
        <Field label="Details"><Mono value={row.args} /></Field>
      ) : null}
      {queued?.risk && <Field label="Risk">{queued.risk}</Field>}
      {queued?.rollback && <Field label="If it goes wrong">{queued.rollback}</Field>}
      <Disclosure summary="Technical details">
        <div className="mb-2 text-caption text-muted">
          {row.presentation?.app ? `${row.presentation.app}${row.presentation.operation ? ` · ${row.presentation.operation}` : ''} · ` : ''}
          Tool: {queued?.toolName || row.tool || '—'}{row.sessionId ? ` · session ${row.sessionId}` : ''}
        </div>
        {queued && <PendingActionDetail action={queued} />}
        <Mono value={row.args} />
      </Disclosure>
    </DecisionFrame>
  );
}

function PendingActionDetail({ action }: { action: NonNullable<ApprovalRow['pendingAction']> }) {
  return (
    <div className="mb-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-caption text-faint">
        <span>{action.status}</span>
        <span>{action.kind}</span>
        <span>hash <span className="font-mono">{action.payloadHash}</span></span>
        {action.idempotencyKey && <span>key <span className="font-mono">{action.idempotencyKey}</span></span>}
      </div>
      <Field label="Exact queued payload"><Mono value={action.payload} /></Field>
    </div>
  );
}

function NotifDetail({ row, view, destination, onRead, onRetry, onBack }: NotificationHandlers & {
  row: NotificationRow; view?: Pick<NeedsYouRowView, 'state' | 'context' | 'at'>; onBack?: () => void;
  /** Where the item is resolved, when the server's key names a place. */
  destination?: { href: string; label: string };
}) {
  const failed = notifFailed(row);
  // A workflow the system switched off is a decision, and the decision is one
  // switch. It belongs on the card that told the user about it — not in a
  // settings screen they have to go find, and certainly not in a file.
  const enableGate = row.workflowEnableGate ?? null;
  const [enableState, setEnableState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [enableError, setEnableError] = useState<string | null>(null);
  const qc = useQueryClient();
  const onEnable = async () => {
    if (!enableGate) return;
    setEnableState('busy');
    setEnableError(null);
    try {
      await setWorkflowEnabled(enableGate.workflowName, true);
      setEnableState('done');
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      onRead();
    } catch (error) {
      setEnableState('idle');
      setEnableError(actionError(error, 'Could not switch that workflow on.'));
    }
  };
  const frameView = view ?? { state: notifTone(row), at: row.createdAt };
  const actions = enableGate || !row.read || failed || destination ? (
    <>
      {destination && !enableGate && (
        <Link to={destination.href} className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-body font-medium text-primary-fg hover:bg-primary-hover active:bg-primary-press">
          {destination.label}
        </Link>
      )}
      {enableGate && (
        <Button disabled={enableState !== 'idle'} onClick={() => { void onEnable(); }}>
          {enableState === 'busy' ? 'Switching on…' : enableState === 'done' ? 'Switched on' : `Turn on ${enableGate.displayName}`}
        </Button>
      )}
      {failed && <Button variant={enableGate || destination ? 'secondary' : 'primary'} onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden /> Retry delivery</Button>}
      {!row.read && <Button variant="secondary" onClick={onRead}>Mark as read</Button>}
    </>
  ) : undefined;
  return (
    <DecisionFrame view={frameView} title={row.title || 'Notification'} onBack={onBack} actions={actions}
      notice={enableError ? { tone: 'error', text: enableError } : enableState === 'done' ? { tone: 'success', text: 'It runs on its schedule again.' } : null}>
      {row.body ? <p className="whitespace-pre-wrap">{linkify(row.body)}</p> : null}
      {enableGate && <p className="text-small text-muted">{enableGate.reason}</p>}
      {row.deliveryError && <Field label="Delivery error"><span className="text-danger">{row.deliveryError}</span></Field>}
    </DecisionFrame>
  );
}
