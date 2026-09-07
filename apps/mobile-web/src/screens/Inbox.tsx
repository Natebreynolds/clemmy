import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  answerInboxQuestion,
  cancelWorkflowRunById,
  getInboxNotification,
  listApprovals,
  listInboxNotifications,
  listInboxQuestions,
  listInboxTrustProposals,
  listPlanProposals,
  listWorkingNow,
  listWorkspaceDestinationChoosers,
  markInboxNotificationRead,
  markInboxNotificationsRead,
  resolveInboxTrustProposal,
  resolveInboxWorkflowCapability,
  type ApprovalRow,
  type InboxNotification,
  type InboxQuestion,
  type InboxTrustProposal,
  type PlanProposalRow,
  type WorkspaceDestinationChooser,
  type WorkflowCapabilityAccountChoice,
  type WorkflowCapabilityInboxGate,
} from '../lib/api';
import { Decisions, relativeTime } from '../components/Approvals';
import { ScreenNotice, type ScreenNote } from '../components/ScreenNotice';
import { haptic, reportNativeNotificationHandled } from '../lib/native-bridge';
import {
  applyLocalReads,
  clearReceipt,
  collapseAttentionNotifications,
  notificationIsRepresentedByApprovals,
  notificationLabel,
  notificationRunTarget,
  trustScopeSummary,
  updatesClearScope,
} from '../lib/inbox-presentation';
import { inboxNeedsCountKnown, mergeInboxLastGood, type InboxLastGood } from '../lib/inbox-last-good';
import { stoppableWorkflowRunIds } from '../lib/running-tasks';
import { useScreenData } from '../lib/use-screen-data';

type InboxTab = 'needs' | 'updates';

interface InboxData {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  workspaceChoosers: WorkspaceDestinationChooser[];
  questions: InboxQuestion[];
  trustProposals: InboxTrustProposal[];
  notifications: InboxNotification[];
  unavailable: string[];
  requestedNotificationMissing: boolean;
  requestedNotificationPending: boolean;
  /** True only after every Needs-you source has returned at least once. */
  needsCountKnown: boolean;
  /** The Updates feed has its own truth boundary; other source failures do
   * not make a successful empty notification response unknown. */
  updatesKnown: boolean;
  /**
   * The workflow runs the daemon says are still going, so the phone can offer
   * "End this run" only where it would actually end something. `null` means
   * the source has never answered — an unknown liveness offers nothing, which
   * is the honest direction: hiding a control asserts nothing, while showing
   * one asserts the run is live.
   */
  stoppableRunIds: string[] | null;
}

type InboxPart<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function loadInboxPart<T>(work: Promise<T>): Promise<InboxPart<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
}

interface AnswerReceipt {
  id: string;
  title: string;
  text: string;
}

/** A decision made on this phone in this session — the "Decided earlier
 * today" list is built from these exact receipts, never inferred. */
interface DecidedEntry {
  id: string;
  text: string;
  at: number;
}

interface Props {
  initialNotificationId?: string | null;
  onCount: (count: number) => void;
  onReply: (sessionId: string | null, draft: string) => void;
  onOpenSettings: () => void;
  onOpenWorkflows: () => void;
  /** A row that names a run opens that run. The card is a paragraph ABOUT the
   *  work; the run screen is the work — what it changed, what it produced. */
  onOpenRun: (sessionId: string) => void;
}

export function Inbox({ initialNotificationId, onCount, onReply, onOpenSettings, onOpenWorkflows, onOpenRun }: Props) {
  // Partial endpoint failures keep the last successful value for that exact
  // source. `undefined` means “never known”; an empty array means a successful
  // authoritative zero. This distinction prevents a transport miss from
  // erasing the shell badge or manufacturing “all caught up.”
  const lastGood = useRef<InboxLastGood>({});
  // Liveness is not part of the Inbox's last-good bundle on purpose: it is the
  // one fact where a remembered value would be the defect. It keeps its own
  // slot so a stale snapshot can never leak into the decision sets above.
  const lastStoppableRunIds = useRef<string[] | null>(null);
  const load = useCallback(async (): Promise<InboxData> => {
    const exactNotification = initialNotificationId
      ? getInboxNotification(initialNotificationId)
      : Promise.resolve(null);
    const [approvals, plans, choosers, questions, trusts, notifications, exact, workingNow] = await Promise.all([
      loadInboxPart(listApprovals()),
      loadInboxPart(listPlanProposals()),
      loadInboxPart(listWorkspaceDestinationChoosers()),
      loadInboxPart(listInboxQuestions()),
      loadInboxPart(listInboxTrustProposals()),
      loadInboxPart(listInboxNotifications(200)),
      loadInboxPart(exactNotification),
      // Which runs are STILL GOING. The notification feed cannot say — no
      // status crosses the mobile boundary — so the run controls read the
      // daemon's own Working Now projection instead of a flag stamped when
      // the notification was written.
      loadInboxPart(listWorkingNow()),
    ]);
    if (workingNow.ok) {
      lastStoppableRunIds.current = [...stoppableWorkflowRunIds(workingNow.value.entries)];
    }
    const parts = [approvals, plans, choosers, questions, trusts, notifications];
    if (parts.every((part) => !part.ok)) {
      throw (parts[0] as { ok: false; error: unknown }).error;
    }
    lastGood.current = mergeInboxLastGood(lastGood.current, {
      ...(approvals.ok ? { approvals: approvals.value.approvals.filter((row) => row.status === 'pending') } : {}),
      ...(plans.ok ? { plans: plans.value.proposals.filter((row) => row.status === 'pending') } : {}),
      ...(choosers.ok ? { workspaceChoosers: choosers.value.choosers } : {}),
      ...(questions.ok ? { questions: questions.value.questions } : {}),
      ...(trusts.ok ? { trustProposals: trusts.value.proposals } : {}),
      ...(notifications.ok ? { notifications: [...notifications.value.notifications] } : {}),
    });

    let notificationRows = [...(lastGood.current.notifications ?? [])];
    // Put the addressed row first even when it was already in the feed. The
    // attention collapse keeps the first representative, so this guarantees
    // that an older exact tap cannot be hidden behind a newer lookalike.
    if (exact.ok && exact.value) {
      notificationRows = [
        exact.value.notification,
        ...notificationRows.filter((row) => row.id !== exact.value?.notification.id),
      ];
    }
    const exactStatus = exact.ok ? null : (exact.error as { status?: number }).status;
    const exactInRows = Boolean(
      initialNotificationId && notificationRows.some((row) => row.id === initialNotificationId),
    );
    const requestedNotificationMissing = Boolean(
      initialNotificationId && !exactInRows && !exact.ok && exactStatus === 404,
    );
    const requestedNotificationPending = Boolean(
      initialNotificationId && !exactInRows && !exact.ok && exactStatus !== 404,
    );
    return {
      approvals: lastGood.current.approvals ?? [],
      plans: lastGood.current.plans ?? [],
      workspaceChoosers: lastGood.current.workspaceChoosers ?? [],
      questions: lastGood.current.questions ?? [],
      trustProposals: lastGood.current.trustProposals ?? [],
      notifications: notificationRows,
      unavailable: [
        !approvals.ok ? 'approvals' : '',
        !plans.ok ? 'plans' : '',
        !choosers.ok ? 'workspace choices' : '',
        !questions.ok ? 'questions' : '',
        !trusts.ok ? 'trust requests' : '',
        !notifications.ok ? 'updates' : '',
        // Say it out loud the first time, because the consequence is a missing
        // control: with no liveness the phone will not offer to end a run.
        !workingNow.ok && lastStoppableRunIds.current === null ? 'run controls' : '',
        requestedNotificationPending ? 'selected update' : '',
      ].filter(Boolean),
      requestedNotificationMissing,
      requestedNotificationPending,
      needsCountKnown: inboxNeedsCountKnown(lastGood.current),
      updatesKnown: lastGood.current.notifications !== undefined,
      stoppableRunIds: lastStoppableRunIds.current,
    };
  }, [initialNotificationId]);
  const { data, loading, refreshing, error, offline, refresh } = useScreenData(load, { intervalMs: 6_000 });
  const [tab, setTab] = useState<InboxTab>('needs');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  // A SET, not one id: per-row clearing is concurrent now that it no longer
  // freezes the screen, and a single slot would let the last tap take the
  // "Saving…" label off every earlier row that is still in flight.
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set());
  const [decided, setDecided] = useState<DecidedEntry[]>([]);
  // Rows this phone has just cleared. Optimistic because marking read is
  // presentation only and therefore reversible: if the daemon refuses, the id
  // leaves this set and the row comes straight back where it was.
  const [locallyRead, setLocallyRead] = useState<ReadonlySet<string>>(() => new Set());
  const [clearing, setClearing] = useState(false);
  // A bulk clear asks once, in place, naming its own size. No modal.
  const [confirmClear, setConfirmClear] = useState(false);
  const handledDeepLink = useRef<string | null>(null);
  const clearingLock = useRef(false);

  const forgetLocalReads = useCallback((ids: readonly string[]) => {
    setLocallyRead((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const approvals = data?.approvals ?? [];
  const plans = data?.plans ?? [];
  const workspaceChoosers = data?.workspaceChoosers ?? [];
  const questions = data?.questions ?? [];
  const trustProposals = data?.trustProposals ?? [];
  const notifications = useMemo(
    () => applyLocalReads(data?.notifications ?? [], locallyRead),
    [data?.notifications, locallyRead],
  );
  const questionIds = useMemo(() => new Set(questions.map((row) => row.id)), [questions]);
  const approvalIds = useMemo(() => new Set(approvals.map((row) => row.approvalId)), [approvals]);
  const planIds = useMemo(() => new Set(plans.map((row) => row.id)), [plans]);
  const trustIds = useMemo(() => new Set(trustProposals.map((row) => row.id)), [trustProposals]);

  const stillNeedsUser = useCallback((row: InboxNotification) => {
    if (row.read || !row.needsAttention) return false;
    if (row.context.actionItemId && questionIds.has(row.context.actionItemId)) return false;
    if (row.context.approvalId && approvalIds.has(row.context.approvalId)) return false;
    if (notificationIsRepresentedByApprovals(row, approvalIds)) return false;
    if (row.context.planProposalId && planIds.has(row.context.planProposalId)) return false;
    if (row.context.trustProposalId && trustIds.has(row.context.trustProposalId)) return false;
    return true;
  }, [approvalIds, planIds, questionIds, trustIds]);

  const notificationNeeds = useMemo(
    () => collapseAttentionNotifications(notifications.filter(stillNeedsUser)),
    [notifications, stillNeedsUser],
  );

  // The count ON THIS SCREEN counts the rows on this screen — including the
  // ones this phone just dismissed, which are gone from the list. A tab badge
  // that outran its own rows would be a count exceeding what its screen shows.
  const needsCount = questions.length + approvals.length + plans.length + workspaceChoosers.length + trustProposals.length + notificationNeeds.length;

  // The count PUBLISHED TO THE SHELL is a different claim, so it is a different
  // number: the shell keeps it as its last authoritative summary and shows it
  // on every other screen and on the app icon. An optimistic dismissal is not
  // authoritative until the daemon has agreed, so the badge counts only rows
  // the daemon has confirmed — no local guess reaches the icon. It catches up
  // on the very next poll, and a refused clear never has to walk it back.
  const confirmedNotificationNeeds = useMemo(
    () => collapseAttentionNotifications((data?.notifications ?? []).filter(stillNeedsUser)).length,
    [data?.notifications, stillNeedsUser],
  );
  const confirmedNeedsCount = questions.length + approvals.length + plans.length + workspaceChoosers.length + trustProposals.length + confirmedNotificationNeeds;
  const resolvedQuestionItems = new Set(
    notifications
      .filter((row) => !row.needsAttention && row.context.actionItemId?.match(/^(checkin|task|workflow):/))
      .map((row) => row.context.actionItemId as string),
  );
  const updates = notifications.filter((row) => {
    if (row.context.actionItemId && questionIds.has(row.context.actionItemId)) return false;
    if (row.context.approvalId && approvalIds.has(row.context.approvalId)) return false;
    if (notificationIsRepresentedByApprovals(row, approvalIds)) return false;
    if (row.context.planProposalId && planIds.has(row.context.planProposalId)) return false;
    if (row.context.trustProposalId && trustIds.has(row.context.trustProposalId)) return false;
    // An exact push destination remains renderable even when a newer durable
    // receipt makes its ordinary timeline copy redundant. Native cannot clear
    // the parked tap until this addressed row genuinely receives focus.
    if (row.id === initialNotificationId) return row.read || !row.needsAttention;
    // Once a durable answer receipt exists, the older “question asked”
    // carrier adds no history—it repeats the same prompt directly below the
    // answer. Keep the receipt as the canonical timeline row.
    if (row.needsAttention && row.context.actionItemId && resolvedQuestionItems.has(row.context.actionItemId)) return false;
    return row.read || !row.needsAttention;
  });
  const unreadUpdates = updates.filter((row) => !row.read).length;
  // The exact ids the bulk button will clear — taken from the rows on screen,
  // so the button can name its own size and can never widen past them.
  const clearScope = updatesClearScope(updates);
  // The runs an "End this run" button could actually end. `null` until the
  // daemon has answered once, and a run that is not in it gets no button.
  const stoppableRunIds = useMemo(
    () => (data?.stoppableRunIds ? new Set(data.stoppableRunIds) : null),
    [data?.stoppableRunIds],
  );

  useEffect(() => {
    // The app shell independently retains its last authoritative summary.
    // Publish only a complete count; a guessed zero would erase that truth.
    if (data?.needsCountKnown) onCount(confirmedNeedsCount);
  }, [confirmedNeedsCount, data?.needsCountKnown, onCount]);

  // A pending "are you sure" belongs to the scope it was asked about. Leave
  // the tab, or clear the scope, and the question is gone — it must never
  // reappear later attached to a different set of rows.
  useEffect(() => {
    if (confirmClear && (tab !== 'updates' || clearScope.count === 0)) setConfirmClear(false);
  }, [clearScope.count, confirmClear, tab]);

  // Once the daemon reports a row read, this phone's optimistic overlay has
  // nothing left to say about it. Dropping it keeps the overlay the size of
  // what is genuinely in flight rather than a session-long ledger.
  useEffect(() => {
    const rows = data?.notifications;
    if (!rows || locallyRead.size === 0) return;
    const known = new Set(rows.map((row) => row.id));
    const settled = [...locallyRead].filter((id) => !known.has(id) || rows.some((row) => row.id === id && row.read));
    if (settled.length > 0) forgetLocalReads(settled);
  }, [data?.notifications, forgetLocalReads, locallyRead]);

  // A push addresses the durable notification. If that notification points at
  // a typed question/approval, focus the richer response card instead of its
  // generic delivery copy. Otherwise open the update itself.
  useEffect(() => {
    if (!initialNotificationId || !data || handledDeepLink.current === initialNotificationId) return;
    if (data.requestedNotificationMissing) {
      handledDeepLink.current = initialNotificationId;
      setTab('updates');
      window.requestAnimationFrame(() => {
        document.getElementById('inbox-missing-notification')?.focus();
        reportNativeNotificationHandled(initialNotificationId, 'unavailable');
      });
      return;
    }
    if (data.requestedNotificationPending) return;
    const notification = notifications.find((row) => row.id === initialNotificationId);
    if (!notification) return;
    const representedApprovalId = (notification.context.relatedApprovalIds ?? [])
      .find((id) => approvalIds.has(id));
    const actionTarget = notification.context.actionItemId
      ?? (representedApprovalId ? `approval:${representedApprovalId}` : null);
    const targetIsOpen = Boolean(
      actionTarget && (
        (actionTarget.startsWith('checkin:') || actionTarget.startsWith('task:') || actionTarget.startsWith('workflow:')) && questionIds.has(actionTarget)
        || actionTarget.startsWith('approval:') && approvalIds.has(actionTarget.slice('approval:'.length))
        || actionTarget.startsWith('plan:') && planIds.has(actionTarget.slice('plan:'.length))
        || actionTarget.startsWith('trust:') && trustIds.has(actionTarget.slice('trust:'.length))
      ),
    );
    const fallbackNotification = updates.find((row) => row.id === initialNotificationId)
      ?? notificationNeeds.find(({ row }) => row.id === initialNotificationId)?.row
      ?? (actionTarget ? updates.find((row) => row.context.actionItemId === actionTarget) : undefined)
      ?? (actionTarget ? notificationNeeds.find(({ row }) => row.context.actionItemId === actionTarget)?.row : undefined);
    const target = targetIsOpen && actionTarget
      ? actionTarget
      : `notification:${fallbackNotification?.id ?? initialNotificationId}`;
    const belongsInNeeds = targetIsOpen || Boolean(
      fallbackNotification && notificationNeeds.some(({ row }) => row.id === fallbackNotification.id),
    );
    setTab(belongsInNeeds ? 'needs' : 'updates');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const element = document.getElementById(`inbox-${target}`);
        if (!element) return;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        element.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        element.focus({ preventScroll: true });
        handledDeepLink.current = initialNotificationId;
        reportNativeNotificationHandled(initialNotificationId, 'presented');
      });
    });
  }, [approvalIds, data, initialNotificationId, notificationNeeds, notifications, planIds, questionIds, trustIds, updates]);

  const recordDecision = (id: string, text: string) => {
    setDecided((current) => [
      { id, text, at: Date.now() },
      ...current.filter((row) => row.id !== id),
    ].slice(0, 12));
  };

  const resolved = (text: string, tone: 'success' | 'error' = 'success') => {
    setNotice({ tone, text });
    if (tone === 'success') recordDecision(`decision-${Date.now().toString(36)}`, text);
    void refresh();
    window.requestAnimationFrame(() => document.getElementById('inbox-action-receipt')?.focus());
  };

  const answered = (question: InboxQuestion, receipt: Omit<AnswerReceipt, 'id'>) => {
    recordDecision(question.id, receipt.text ? `${receipt.title} · ${receipt.text}` : receipt.title);
    setNotice(null);
    void refresh();
    window.requestAnimationFrame(() => {
      document.getElementById(`inbox-receipt-${question.id}`)?.focus();
    });
  };

  // ONE line for the screen's own state. The transport truth (offline, a
  // failed load) outranks it inside ScreenNotice; among the rest, what the
  // user just did outranks what the app could not refresh.
  const note: ScreenNote | null = notice
    ? { tone: notice.tone, text: notice.text, id: notice.tone === 'success' ? 'inbox-action-receipt' : undefined }
    : data?.requestedNotificationMissing
      ? { tone: 'info', text: 'That update is no longer available. Your current Inbox is shown instead.', id: 'inbox-missing-notification' }
      : data?.unavailable.length
        ? { tone: 'error', text: `Some items could not refresh: ${data.unavailable.join(', ')}. Everything else is still available.` }
        : null;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const decidedToday = decided.filter((entry) => entry.at >= startOfToday);

  const selectTab = (next: InboxTab) => {
    setTab(next);
    window.requestAnimationFrame(() => document.getElementById(`inbox-tab-${next}`)?.focus());
  };

  // Clear ONE row, from the row, without leaving the screen. The row leaves
  // immediately and comes back if the daemon refuses — one tap in flight must
  // not freeze every other button on the screen, which is what awaiting the
  // round trip used to do.
  const markRead = async (row: InboxNotification) => {
    if (locallyRead.has(row.id)) return;
    setLocallyRead((current) => new Set(current).add(row.id));
    setReading((current) => new Set(current).add(row.id));
    setNotice(null);
    haptic('light');
    try {
      await markInboxNotificationRead(row.id);
      setNotice({
        tone: 'success',
        text: row.needsAttention ? 'Dismissed. Nothing was decided — the work itself is untouched.' : 'Marked as read.',
      });
      await refresh();
    } catch (err) {
      forgetLocalReads([row.id]);
      haptic('error');
      const status = (err as { status?: number }).status;
      setNotice({
        tone: 'error',
        text: status === 409
          ? 'That one is a gate Clem is still parked on — open it and choose, and it clears itself.'
          : err instanceof Error ? err.message : 'Could not update that item. It is still here.',
      });
    } finally {
      setReading((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
    }
  };

  // Clear a whole group at once — the honest bulk action. 176 history items
  // will never be read one by one, and pretending otherwise IS the problem.
  // The scope is the exact ids on screen, the button says how many, and the
  // daemon holds back anything still awaiting an answer.
  const clearUpdates = async (ids: readonly string[]) => {
    if (clearingLock.current || ids.length === 0) return;
    clearingLock.current = true;
    setClearing(true);
    setConfirmClear(false);
    setNotice(null);
    setLocallyRead((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    haptic('light');
    try {
      const result = await markInboxNotificationsRead(ids);
      const held = result.held ?? [];
      if (held.length > 0) forgetLocalReads(held.map((row) => row.id));
      setNotice({ tone: 'success', text: clearReceipt(result) });
      await refresh();
    } catch (err) {
      forgetLocalReads(ids);
      haptic('error');
      setNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not clear those updates. They are all still here.',
      });
    } finally {
      clearingLock.current = false;
      setClearing(false);
    }
  };

  return (
    <div class="inbox-screen" aria-busy={refreshing}>
      <div class="inbox-tabs" role="tablist" aria-label="Inbox views">
        <button
          id="inbox-tab-needs"
          type="button"
          role="tab"
          aria-controls="inbox-panel-needs"
          aria-selected={tab === 'needs'}
          tabIndex={tab === 'needs' ? 0 : -1}
          class={tab === 'needs' ? 'active' : ''}
          onClick={() => setTab('needs')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault();
              selectTab('updates');
            }
          }}
        >
          Needs you {needsCount > 0 ? <span>{needsCount > 99 ? '99+' : needsCount}</span> : null}
        </button>
        <button
          id="inbox-tab-updates"
          type="button"
          role="tab"
          aria-controls="inbox-panel-updates"
          aria-selected={tab === 'updates'}
          tabIndex={tab === 'updates' ? 0 : -1}
          class={tab === 'updates' ? 'active' : ''}
          onClick={() => setTab('updates')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault();
              selectTab('needs');
            }
          }}
        >
          Updates {unreadUpdates > 0 ? <span>{unreadUpdates > 99 ? '99+' : unreadUpdates}</span> : null}
        </button>
      </div>

      <ScreenNotice
        error={error}
        offline={offline}
        onRetry={() => void refresh()}
        hasData={Boolean(data)}
        note={note}
      />

      {loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div> : null}

      {!loading && tab === 'needs' ? (
        <div id="inbox-panel-needs" class="inbox-stack" role="tabpanel" aria-labelledby="inbox-tab-needs">
          {data?.needsCountKnown && needsCount === 0 ? (
            <div class="inbox-clear">
              <span aria-hidden="true"><CheckGlyph /></span>
              <h2>Nothing is waiting on you</h2>
              <p>New questions will stay here until you answer them.</p>
            </div>
          ) : null}

          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              onAnswered={(receipt) => answered(question, receipt)}
              onReply={onReply}
            />
          ))}

          {trustProposals.map((proposal) => (
            <TrustProposalCard key={proposal.id} proposal={proposal} onResolved={resolved} />
          ))}

          <Decisions
            approvals={approvals}
            plans={plans}
            workspaceChoosers={workspaceChoosers}
            onResolved={resolved}
            onReply={(sessionId, draft) => onReply(sessionId || null, draft)}
          />

          {notificationNeeds.map(({ row, earlier }) => {
            // The run this row is ABOUT (see notificationRunTarget) — the same
            // destination the push for this same notification lands on.
            const runTarget = notificationRunTarget(row);
            return row.workflowCapability ? (
              <WorkflowCapabilityCard
                key={row.id}
                row={row}
                gate={row.workflowCapability}
                onResolved={resolved}
                onOpenSettings={onOpenSettings}
                onOpenWorkflows={onOpenWorkflows}
              />
            ) : (
              <article
                key={row.id}
                id={`inbox-notification:${row.id}`}
                class="inbox-card inbox-attention-card"
                tabIndex={-1}
              >
                <CardMeta label="Update · needs you" at={row.createdAt} urgent />
                <h2>{row.title || 'I need your attention'}</h2>
                {row.body ? <p class="inbox-card-body">{row.body}</p> : null}
                {earlier > 0 ? <p class="inbox-card-fine">+{earlier} earlier update{earlier === 1 ? '' : 's'} like this</p> : null}
                <div class="inbox-card-actions">
                  {row.context.sessionId ? (
                    <button
                      type="button"
                      class="btn-reply"
                      disabled={reading.has(row.id)}
                      onClick={() => onReply(row.context.sessionId, `About “${row.title}”: `)}
                    >
                      Reply to Clem
                    </button>
                  ) : null}
                  {/* The run this is ABOUT — not the chat that started it.
                      notificationRunTarget is the same choice the push makes. */}
                  {runTarget ? (
                    <button
                      type="button"
                      class="btn-reply"
                      disabled={reading.has(row.id)}
                      onClick={() => onOpenRun(runTarget)}
                    >
                      Open run
                    </button>
                  ) : null}
                  {/* Dismissing the MESSAGE leaves the run exactly where it
                      is — which is how a run reaches eleven hours of
                      "Running" with nobody able to stop it from the phone.

                      AN ACTION BUTTON IS A LIVENESS CLAIM, so it is gated on
                      liveness and not on "this row names a run". The row's own
                      runId is a fact from the moment the notification was
                      written; stoppableRunIds is the daemon's Working Now set,
                      read this poll. Measured on the owner's store: gating on
                      the row alone offered this on 54 notifications, 48 of
                      which name runs the cancel route already calls terminal
                      — 48 buttons whose only possible answer was "that run had
                      already ended". */}
                  {row.context.runId && row.context.workflow && stoppableRunIds?.has(row.context.runId) ? (
                    <EndRunButton
                      runId={row.context.runId}
                      workflow={row.context.workflow}
                      onResolved={resolved}
                    />
                  ) : null}
                  <button type="button" class="btn-reject" disabled={reading.has(row.id)} onClick={() => void markRead(row)}>
                    {reading.has(row.id) ? 'Saving…' : 'Dismiss update'}
                  </button>
                </div>
              </article>
            );
          })}

          {decidedToday.length > 0 ? (
            <section class="inbox-decided" aria-labelledby="inbox-decided-head">
              <h3 id="inbox-decided-head" class="pane-head">Decided earlier today</h3>
              <div class="inbox-decided-list" role="list">
                {decidedToday.map((entry) => (
                  <div key={entry.id} id={`inbox-receipt-${entry.id}`} class="inbox-decided-row" role="listitem" tabIndex={-1}>
                    <CheckGlyph />
                    <span class="inbox-decided-text">{entry.text}</span>
                    <time class="inbox-decided-time" dateTime={new Date(entry.at).toISOString()}>
                      {new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </time>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {!loading && tab === 'updates' ? (
        <div id="inbox-panel-updates" class="inbox-stack" role="tabpanel" aria-labelledby="inbox-tab-updates">
          {/* THE HONEST BULK ACTION. Nobody reads 176 history rows one at a
              time, so the phone has to offer the verb that matches the size.
              It names its scope, asks once in place, and clears NOTHING that
              is waiting on an answer — those live on the Needs you tab and the
              daemon refuses them even if asked.

              THE COPY IS PART OF THE ACTION. It used to call this set "reports
              of work already done"; measured on the owner's store that was
              false for 111 of the 118 rows it clears — 111 restart
              interruptions, i.e. work that did NOT get done. What is true of
              every row in the scope is the thing the scope is built from:
              updatesClearScope takes only rows that are unread, not flagged for
              the user, and not a capability gate. So the sentence says that,
              and nothing about how the work turned out. */}
          {clearScope.count > 1 ? (
            <section class="inbox-card" aria-labelledby="inbox-clear-head">
              <h2 id="inbox-clear-head">
                {confirmClear ? `${clearScope.label}?` : `${clearScope.count} unread update${clearScope.count === 1 ? '' : 's'}`}
              </h2>
              <p class="inbox-card-fine">
                {confirmClear
                  ? 'They stay in your history. Nothing is deleted, approved, or answered.'
                  : 'These are past reports — work that finished, and work that stopped. None of them is waiting on you. Clearing marks them read; it decides nothing.'}
              </p>
              <div class="inbox-card-actions">
                {confirmClear ? (
                  <>
                    <button
                      type="button"
                      class="btn-approve"
                      disabled={clearing}
                      onClick={() => void clearUpdates(clearScope.ids)}
                    >
                      {clearing ? 'Clearing…' : `Yes, clear ${clearScope.count}`}
                    </button>
                    <button type="button" class="btn-reject" disabled={clearing} onClick={() => setConfirmClear(false)}>
                      Keep them
                    </button>
                  </>
                ) : (
                  <button type="button" class="btn-reply" disabled={clearing} onClick={() => setConfirmClear(true)}>
                    {clearScope.label}
                  </button>
                )}
              </div>
            </section>
          ) : null}

          {data?.updatesKnown && updates.length === 0 ? (
            <div class="inbox-clear">
              <span aria-hidden="true"><CheckGlyph /></span>
              <h2>No updates yet</h2>
              <p>Finished work and proactive messages will stay here.</p>
            </div>
          ) : !data?.updatesKnown ? (
            <div class="inbox-clear">
              <h2>Checking updates</h2>
              <p>Your last known update count is unchanged until this source responds.</p>
            </div>
          ) : updates.map((row) => {
            const runTarget = notificationRunTarget(row);
            return (
              <article
                key={row.id}
                id={`inbox-notification:${row.id}`}
                class={`inbox-card inbox-update-card${row.read ? ' read' : ''}`}
                tabIndex={-1}
              >
                <CardMeta label={notificationLabel(row)} at={row.createdAt} unread={!row.read} />
                <h2>{row.title || 'Update from Clem'}</h2>
                {row.body ? <p class="inbox-card-body">{row.body}</p> : null}
                {row.deliveryError ? <p class="inbox-delivery-error">Delivery issue: {row.deliveryError}</p> : null}
                {!row.read || runTarget ? (
                  <div class="inbox-card-actions">
                    {!row.read ? (
                      <button type="button" class="btn-reply" disabled={reading.has(row.id)} onClick={() => void markRead(row)}>
                        {reading.has(row.id) ? 'Saving…' : 'Mark as read'}
                      </button>
                    ) : null}
                    {/* An update about finished work is a summary of a run that
                        already has its own screen — go to the work itself, which
                        for a background task is NOT the chat that started it. */}
                    {runTarget ? (
                      <button type="button" class="btn-reply" disabled={reading.has(row.id)} onClick={() => onOpenRun(runTarget)}>
                        Open run
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * END IT, don't just look at it.
 *
 * A Needs-you row says Clem stopped on a run. The phone's verbs were "reply",
 * "look", and "dismiss the message" — and dismissing the message left the run
 * exactly where it was. That is how a workflow reaches "Running · 273h 48m":
 * nothing on this device could end it.
 *
 * OFFERING IT IS ITSELF A CLAIM THAT THE RUN IS LIVE. An earlier version of
 * this comment said the opposite — that the copy asserts nothing and the 409
 * tells the truth afterwards — and that was wrong twice over: the honesty
 * arrived only after the tap, and on the owner's store 48 of the 54 rows that
 * got this button named runs the cancel route already calls terminal. So the
 * caller gates it on the daemon's live run set and this component is rendered
 * only where it can act. The 409 path stays for the race between the poll and
 * the tap, which is the only staleness left.
 */
function EndRunButton({ runId, workflow, onResolved }: {
  runId: string;
  workflow: string;
  onResolved: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const actionLock = useRef(false);
  const end = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      await cancelWorkflowRunById(runId);
      haptic('success');
      onResolved(`Stopped ${workflow}. Whatever it had already finished is kept.`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const body = (err as { body?: { error?: string; status?: string } }).body;
      if (status === 409 && body?.error === 'ALREADY_FINISHED') {
        onResolved(
          `That run had already ended${body.status ? ` (${body.status})` : ''}. Nothing changed.`,
          'error',
        );
      } else if (status === 404) {
        onResolved('That run is no longer on your Mac, so there was nothing to stop.', 'error');
      } else {
        haptic('error');
        onResolved(err instanceof Error ? err.message : 'I could not stop that run.', 'error');
      }
    } finally {
      actionLock.current = false;
      setBusy(false);
      setConfirming(false);
    }
  };
  if (!confirming) {
    return (
      <button type="button" class="btn-reply" disabled={busy} onClick={() => setConfirming(true)}>
        End this run
      </button>
    );
  }
  return (
    <>
      <button type="button" class="btn-approve" disabled={busy} onClick={() => void end()}>
        {busy ? 'Stopping…' : 'Yes, end it'}
      </button>
      <button type="button" class="btn-reject" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </>
  );
}

function WorkflowCapabilityCard({ row, gate, onResolved, onOpenSettings, onOpenWorkflows }: {
  row: InboxNotification;
  gate: WorkflowCapabilityInboxGate;
  onResolved: (message: string, tone?: 'success' | 'error') => void;
  onOpenSettings: () => void;
  onOpenWorkflows: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const resolve = async (choice?: WorkflowCapabilityAccountChoice) => {
    if (actionLock.current || gate.resolution.kind === 'review_run') return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await resolveInboxWorkflowCapability(gate, choice);
      haptic('success');
      onResolved(
        result.status === 'already_selected' || result.status === 'already_resumed'
          ? 'That exact gate was already handled. This run remains on its one-time resume path.'
          : choice
            ? `Account ${choice.label} (${choice.accountId}) saved. Clem is resuming this same run once.`
            : 'Clem is retrying the exact gate and resuming this same run once.',
      );
    } catch (err) {
      haptic('error');
      const status = (err as { status?: number }).status;
      if (status === 409 || status === 404) {
        onResolved('That gate changed or was already handled. Nothing was dispatched; I refreshed the exact Inbox state.', 'error');
      } else {
        setError(err instanceof Error ? err.message : 'I could not resolve that workflow gate.');
      }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const resolution = gate.resolution;
  return (
    <article id={`inbox-notification:${row.id}`} class="inbox-card inbox-attention-card" tabIndex={-1} aria-busy={busy}>
      <CardMeta label={`Workflow · ${gateNeedLabel(gate)}`} at={row.createdAt} urgent />
      <h2>{row.title || `${gate.workflow} needs you`}</h2>
      {row.body ? <p class="inbox-card-body">{row.body}</p> : null}
      <p class="inbox-card-fine">No {gate.tool} dispatch occurred. Completed work is preserved.</p>
      {resolution.kind === 'choose_account' ? (
        <div class="inbox-option-grid" aria-label={`Exact ${gate.toolkit} account choices`}>
          {resolution.candidates.map((candidate) => (
            <button
              key={`${candidate.capabilityId}\u0000${candidate.accountId}`}
              type="button"
              disabled={busy}
              onClick={() => void resolve(candidate)}
            >
              <strong>{candidate.label}</strong>
              <span>account {candidate.accountId}</span>
              <span>capability {candidate.capabilityId}</span>
            </button>
          ))}
          {resolution.choicesTruncated ? <p class="inbox-card-fine">Showing {resolution.candidates.length} of {resolution.choiceTotal} exact choices.</p> : null}
        </div>
      ) : resolution.kind === 'connect_and_retry' ? (
        <div class="inbox-card-actions">
          <button type="button" class="btn-reply" disabled={busy} onClick={onOpenSettings}>View connection status</button>
          <button type="button" class="btn-approve" disabled={busy} onClick={() => void resolve()}>
            {busy ? 'Resuming…' : 'I connected it on my Mac — resume'}
          </button>
        </div>
      ) : resolution.kind === 'retry_exact_metadata' ? (
        <div class="inbox-card-actions">
          <button type="button" class="btn-approve" disabled={busy} onClick={() => void resolve()}>
            {busy ? 'Retrying…' : 'Retry exact metadata now'}
          </button>
        </div>
      ) : (
        <div>
          <p class="trust-consequence">{resolution.reason}</p>
          <div class="inbox-card-actions"><button type="button" class="btn-reply" onClick={onOpenWorkflows}>Review preserved run</button></div>
        </div>
      )}
      {error ? <p class="inbox-inline-error" role="alert">{error}</p> : null}
    </article>
  );
}

function TrustProposalCard({ proposal, onResolved }: {
  proposal: InboxTrustProposal;
  onResolved: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const decide = async (decision: 'approve' | 'decline') => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(decision);
    setError(null);
    try {
      const result = await resolveInboxTrustProposal(proposal, decision);
      haptic(decision === 'approve' ? 'success' : 'light');
      onResolved(result.message);
    } catch (err) {
      const apiError = err as { status?: number; body?: { error?: string } };
      if (apiError.status === 409 && apiError.body?.error === 'TRUST_PROPOSAL_SCOPE_MISMATCH') {
        onResolved('Nothing was granted. That permission scope changed before your decision, so I refreshed it for review.', 'error');
      } else if (apiError.status === 409 && apiError.body?.error === 'TRUST_PROPOSAL_EXPIRED') {
        onResolved('Nothing was granted. That permission request expired, so Clem will ask again if it is still needed.', 'error');
      } else if (apiError.status === 409) {
        onResolved('That trust request was already handled. I refreshed its status.');
      } else {
        haptic('error');
        setError(err instanceof Error ? err.message : 'I could not save that decision.');
      }
    } finally {
      actionLock.current = false;
      setBusy(null);
    }
  };
  const toolkitLabel = proposal.toolkits.map((value) => value.replace(/[_-]+/g, ' ')).join(', ');
  const scope = trustScopeSummary(proposal);
  return (
    <article id={`inbox-trust:${proposal.id}`} class="inbox-card inbox-trust-card" tabIndex={-1} aria-busy={Boolean(busy)}>
      <CardMeta label="Permission · standing" at={proposal.createdAt} />
      <h2>Should I stop asking before future sends to this exact scope?</h2>
      <p class="inbox-card-body">{proposal.rationale}</p>
      <dl class="trust-scope">
        {proposal.recipients.length > 0 ? (
          <div><dt>Exact recipients</dt><dd>{proposal.recipients.join(', ')}</dd></div>
        ) : null}
        {proposal.domains.length > 0 ? (
          <div><dt>Allowed domains</dt><dd>{proposal.domains.map((domain) => `Anyone at ${domain}`).join(', ')}</dd></div>
        ) : null}
        {proposal.recipients.length === 0 && proposal.domains.length === 0 ? (
          <div><dt>Scope</dt><dd>No recipient scope supplied</dd></div>
        ) : null}
        <div><dt>Send with</dt><dd>{toolkitLabel || 'Configured send tools'}</dd></div>
        <div><dt>Per send</dt><dd>Up to {proposal.maxRecipients} recipient{proposal.maxRecipients === 1 ? '' : 's'}</dd></div>
        <div><dt>Evidence</dt><dd>{proposal.evidence.cleanSendCount} approved sends across {proposal.evidence.distinctDays} day{proposal.evidence.distinctDays === 1 ? '' : 's'}</dd></div>
      </dl>
      <p class="trust-consequence">
        Allowing this changes standing authority only for the exact scope above. You can revoke it later from the desktop.
      </p>
      <div class="inbox-card-actions">
        <button
          type="button"
          class="btn-approve"
          disabled={Boolean(busy)}
          aria-label={`Allow future sends to ${scope}`}
          onClick={() => void decide('approve')}
        >
          {busy === 'approve' ? 'Allowing…' : 'Allow exact scope'}
        </button>
        <button
          type="button"
          class="btn-reject"
          disabled={Boolean(busy)}
          aria-label={`Keep asking before sends to ${scope}`}
          onClick={() => void decide('decline')}
        >
          {busy === 'decline' ? 'Saving…' : 'Keep asking'}
        </button>
      </div>
      {error ? <p class="inbox-inline-error" role="alert">{error}</p> : null}
    </article>
  );
}

function QuestionCard({ question, onAnswered, onReply }: {
  question: InboxQuestion;
  onAnswered: (receipt: Omit<AnswerReceipt, 'id'>) => void;
  onReply: Props['onReply'];
}) {
  const draftKey = `clem-inbox-draft:${question.id}`;
  const [answer, setAnswer] = useState(() => {
    try { return window.sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionLock = useRef(false);
  const errorId = `answer-error-${question.id}`;

  const updateAnswer = (value: string) => {
    setAnswer(value);
    try {
      if (value) window.sessionStorage.setItem(draftKey, value);
      else window.sessionStorage.removeItem(draftKey);
    } catch { /* an ephemeral draft is still usable */ }
  };

  const submit = async (value = answer) => {
    // Mirror the route's accepted payload exactly. Suggested options do not
    // pass through the textarea's maxLength, so bound them here too; the
    // receipt below can then quote precisely what the server claimed.
    const text = value.trim().slice(0, 4_000);
    if (!question.answerable || !text || actionLock.current) return;
    // State updates are asynchronous. The ref closes the same-tick window in
    // which two option taps could otherwise dispatch competing answers.
    actionLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await answerInboxQuestion(question.id, text);
      try { window.sessionStorage.removeItem(draftKey); } catch { /* no-op */ }
      haptic('success');
      onAnswered({ title: 'Answer sent', text: `“${text}”` });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        try { window.sessionStorage.removeItem(draftKey); } catch { /* no-op */ }
        onAnswered({
          title: 'Already handled',
          text: 'That question was resolved somewhere else. Your answer was not sent again.',
        });
      } else {
        setError(err instanceof Error ? err.message : 'I could not save that answer.');
      }
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };

  return (
    <article id={`inbox-${question.id}`} class="inbox-card inbox-question-card" tabIndex={-1} aria-busy={busy}>
      <CardMeta
        label={`Question · ${questionSourceLabel(question)}`}
        at={question.askedAt}
        urgent={question.urgency === 'high'}
      />
      <h2>{question.question}</h2>
      {question.context && question.context.trim() !== question.question.trim() ? (
        <details class="inbox-context">
          <summary>Why I’m asking</summary>
          <p>{question.context}</p>
        </details>
      ) : null}
      {question.options.length > 0 ? (
        <div class="inbox-option-grid" aria-label="Suggested responses">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy || !question.answerable}
              onClick={() => void submit(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {question.answerable ? (
        <form class="inbox-reply" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label for={`answer-${question.id}`}>How do you want me to proceed?</label>
          <textarea
            id={`answer-${question.id}`}
            rows={2}
            maxLength={4000}
            disabled={busy}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            value={answer}
            placeholder="Tell Clem what to do…"
            onInput={(event) => updateAnswer(event.currentTarget.value)}
          />
          <div class="inbox-card-actions">
            <button class="btn-approve" type="submit" disabled={busy || !answer.trim()}>
              {busy ? 'Sending…' : 'Send response'}
            </button>
            {question.sessionId ? (
              <button
                type="button"
                class="btn-reply"
                disabled={busy}
                onClick={() => onReply(question.sessionId, `About “${question.question}”: `)}
              >
                Open conversation
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <p class="trust-consequence">
          {question.unavailableReason
            ?? 'This question has no safe reply context on the phone yet. Open its run on the desktop to answer without risking the wrong work.'}
        </p>
      )}
      {error ? <p id={errorId} class="inbox-inline-error" role="alert">{error}</p> : null}
    </article>
  );
}

/** The kind label's second half: what this gate is waiting on, from the
 * typed resolution — never from the notification prose. */
function gateNeedLabel(gate: WorkflowCapabilityInboxGate): string {
  switch (gate.resolution.kind) {
    case 'choose_account': return 'needs one input';
    case 'connect_and_retry': return 'needs a connection';
    case 'retry_exact_metadata': return 'needs a retry';
    default: return 'needs review';
  }
}

/** Who or what is asking, from typed fields: the workflow's name, a named
 * agent, or the source kind. */
function questionSourceLabel(question: InboxQuestion): string {
  if (question.workflowName) return question.workflowName;
  if (question.agentLabel && question.agentLabel !== 'Clem') return question.agentLabel;
  if (question.source === 'workflow') return 'workflow';
  if (question.source === 'background_task') return 'task';
  return 'check-in';
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CardMeta({ label, at, urgent, unread }: {
  label: string;
  at: string | number;
  urgent?: boolean;
  unread?: boolean;
}) {
  const date = new Date(at);
  const valid = Number.isFinite(date.getTime());
  const full = valid ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '';
  return (
    <div class="inbox-card-meta">
      <span class={urgent ? 'urgent' : ''}>
        {unread ? <><i aria-hidden="true" /><span class="sr-only">Unread. </span></> : null}
        {urgent ? <span class="sr-only">Urgent. </span> : null}
        {label}
      </span>
      <time dateTime={valid ? date.toISOString() : undefined} title={full}>{relativeTime(at)}</time>
    </div>
  );
}
