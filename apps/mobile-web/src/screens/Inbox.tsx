import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  answerInboxQuestion,
  getInboxNotification,
  listApprovals,
  listInboxNotifications,
  listInboxQuestions,
  listInboxTrustProposals,
  listPlanProposals,
  listWorkspaceDestinationChoosers,
  markInboxNotificationRead,
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
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic, reportNativeNotificationHandled } from '../lib/native-bridge';
import {
  collapseAttentionNotifications,
  notificationIsRepresentedByApprovals,
  notificationLabel,
  trustScopeSummary,
} from '../lib/inbox-presentation';
import { inboxNeedsCountKnown, mergeInboxLastGood, type InboxLastGood } from '../lib/inbox-last-good';
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

interface Props {
  initialNotificationId?: string | null;
  onCount: (count: number) => void;
  onReply: (sessionId: string | null, draft: string) => void;
  onOpenSettings: () => void;
  onOpenWorkflows: () => void;
}

export function Inbox({ initialNotificationId, onCount, onReply, onOpenSettings, onOpenWorkflows }: Props) {
  // Partial endpoint failures keep the last successful value for that exact
  // source. `undefined` means “never known”; an empty array means a successful
  // authoritative zero. This distinction prevents a transport miss from
  // erasing the shell badge or manufacturing “all caught up.”
  const lastGood = useRef<InboxLastGood>({});
  const load = useCallback(async (): Promise<InboxData> => {
    const exactNotification = initialNotificationId
      ? getInboxNotification(initialNotificationId)
      : Promise.resolve(null);
    const [approvals, plans, choosers, questions, trusts, notifications, exact] = await Promise.all([
      loadInboxPart(listApprovals()),
      loadInboxPart(listPlanProposals()),
      loadInboxPart(listWorkspaceDestinationChoosers()),
      loadInboxPart(listInboxQuestions()),
      loadInboxPart(listInboxTrustProposals()),
      loadInboxPart(listInboxNotifications(200)),
      loadInboxPart(exactNotification),
    ]);
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
        requestedNotificationPending ? 'selected update' : '',
      ].filter(Boolean),
      requestedNotificationMissing,
      requestedNotificationPending,
      needsCountKnown: inboxNeedsCountKnown(lastGood.current),
      updatesKnown: lastGood.current.notifications !== undefined,
    };
  }, [initialNotificationId]);
  const { data, loading, refreshing, error, offline, refresh } = useScreenData(load, { intervalMs: 6_000 });
  const [tab, setTab] = useState<InboxTab>('needs');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<AnswerReceipt[]>([]);
  const handledDeepLink = useRef<string | null>(null);
  const readingLock = useRef(false);

  const approvals = data?.approvals ?? [];
  const plans = data?.plans ?? [];
  const workspaceChoosers = data?.workspaceChoosers ?? [];
  const questions = data?.questions ?? [];
  const trustProposals = data?.trustProposals ?? [];
  const notifications = data?.notifications ?? [];
  const questionIds = useMemo(() => new Set(questions.map((row) => row.id)), [questions]);
  const approvalIds = useMemo(() => new Set(approvals.map((row) => row.approvalId)), [approvals]);
  const planIds = useMemo(() => new Set(plans.map((row) => row.id)), [plans]);
  const trustIds = useMemo(() => new Set(trustProposals.map((row) => row.id)), [trustProposals]);

  const notificationNeeds = useMemo(() => collapseAttentionNotifications(
    notifications.filter((row) => {
      if (row.read || !row.needsAttention) return false;
      if (row.context.actionItemId && questionIds.has(row.context.actionItemId)) return false;
      if (row.context.approvalId && approvalIds.has(row.context.approvalId)) return false;
      if (notificationIsRepresentedByApprovals(row, approvalIds)) return false;
      if (row.context.planProposalId && planIds.has(row.context.planProposalId)) return false;
      if (row.context.trustProposalId && trustIds.has(row.context.trustProposalId)) return false;
      return true;
    }),
  ), [approvalIds, notifications, planIds, questionIds, trustIds]);

  const needsCount = questions.length + approvals.length + plans.length + workspaceChoosers.length + trustProposals.length + notificationNeeds.length;
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

  useEffect(() => {
    // The app shell independently retains its last authoritative summary.
    // Publish only a complete count; a guessed zero would erase that truth.
    if (data?.needsCountKnown) onCount(needsCount);
  }, [data?.needsCountKnown, needsCount, onCount]);

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

  const resolved = (text: string, tone: 'success' | 'error' = 'success') => {
    setNotice({ tone, text });
    void refresh();
    window.requestAnimationFrame(() => document.getElementById('inbox-action-receipt')?.focus());
  };

  const answered = (question: InboxQuestion, receipt: Omit<AnswerReceipt, 'id'>) => {
    setReceipts((current) => [
      { id: question.id, ...receipt },
      ...current.filter((row) => row.id !== question.id),
    ].slice(0, 3));
    setNotice(null);
    void refresh();
    window.requestAnimationFrame(() => {
      document.getElementById(`inbox-receipt-${question.id}`)?.focus();
    });
  };

  const selectTab = (next: InboxTab) => {
    setTab(next);
    window.requestAnimationFrame(() => document.getElementById(`inbox-tab-${next}`)?.focus());
  };

  const markRead = async (row: InboxNotification) => {
    if (readingLock.current) return;
    readingLock.current = true;
    setReading(row.id);
    setNotice(null);
    try {
      await markInboxNotificationRead(row.id);
      haptic('light');
      setNotice({
        tone: 'success',
        text: row.needsAttention ? 'Update dismissed. The underlying work remains visible.' : 'Marked as read.',
      });
      await refresh();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Could not update that item.' });
    } finally {
      readingLock.current = false;
      setReading(null);
    }
  };

  return (
    <div class="inbox-screen" aria-busy={refreshing}>
      <header class="inbox-intro">
        <img src="/m/clemmy.png" width="44" height="44" alt="" />
        <div>
          <h2>{needsCount > 0
            ? 'Clem needs you'
            : data?.needsCountKnown ? 'You’re all caught up' : 'Checking your Inbox'}</h2>
          <p>{needsCount > 0
            ? 'Questions and decisions I need before I can keep going.'
            : data?.needsCountKnown
              ? 'I’ll bring questions and finished work back here.'
              : 'Some sources have not returned yet; your last known badge is unchanged.'}</p>
        </div>
      </header>

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

      {notice ? (
        <div
          id={notice.tone === 'success' ? 'inbox-action-receipt' : undefined}
          class={`inbox-notice inbox-notice-${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          tabIndex={notice.tone === 'success' ? -1 : undefined}
        >
          {notice.text}
        </div>
      ) : null}

      {data?.unavailable.length ? (
        <div class="inbox-notice inbox-notice-error" role="status">
          Some items could not refresh: {data.unavailable.join(', ')}. Everything else is still available.
        </div>
      ) : null}

      {data?.requestedNotificationMissing ? (
        <div id="inbox-missing-notification" class="inbox-notice" role="status" tabIndex={-1}>
          That update is no longer available. Your current Inbox is shown instead.
        </div>
      ) : null}

      <ScreenNotice
        error={error}
        offline={offline}
        onRetry={() => void refresh()}
        hasData={Boolean(data)}
      />

      {loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div> : null}

      {!loading && tab === 'needs' ? (
        <div id="inbox-panel-needs" class="inbox-stack" role="tabpanel" aria-labelledby="inbox-tab-needs">
          {receipts.map((receipt) => (
            <article
              key={receipt.id}
              id={`inbox-receipt-${receipt.id}`}
              class="inbox-receipt"
              role="status"
              tabIndex={-1}
            >
              <span aria-hidden="true">✓</span>
              <div><strong>{receipt.title}</strong><p>{receipt.text}</p></div>
            </article>
          ))}
          {data?.needsCountKnown && needsCount === 0 ? (
            <div class="inbox-clear">
              <span aria-hidden="true">✓</span>
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

          {notificationNeeds.map(({ row, earlier }) => (
            row.workflowCapability ? (
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
                <CardMeta label="Clem needs you" at={row.createdAt} urgent />
                <h2>{row.title || 'I need your attention'}</h2>
                {row.body ? <p class="inbox-card-body">{row.body}</p> : null}
                {earlier > 0 ? <p class="inbox-card-fine">+{earlier} earlier update{earlier === 1 ? '' : 's'} like this</p> : null}
                <div class="inbox-card-actions">
                  {row.context.sessionId ? (
                    <button
                      type="button"
                      class="btn-reply"
                      disabled={reading !== null}
                      onClick={() => onReply(row.context.sessionId, `About “${row.title}”: `)}
                    >
                      Reply to Clem
                    </button>
                  ) : null}
                  <button type="button" class="btn-reject" disabled={reading !== null} onClick={() => void markRead(row)}>
                    {reading === row.id ? 'Saving…' : 'Dismiss update'}
                  </button>
                </div>
              </article>
            )
          ))}
        </div>
      ) : null}

      {!loading && tab === 'updates' ? (
        <div id="inbox-panel-updates" class="inbox-stack" role="tabpanel" aria-labelledby="inbox-tab-updates">
          {data?.updatesKnown && updates.length === 0 ? (
            <div class="inbox-clear">
              <span aria-hidden="true">✓</span>
              <h2>No updates yet</h2>
              <p>Finished work and proactive messages will stay here.</p>
            </div>
          ) : !data?.updatesKnown ? (
            <div class="inbox-clear">
              <h2>Checking updates</h2>
              <p>Your last known update count is unchanged until this source responds.</p>
            </div>
          ) : updates.map((row) => (
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
              {!row.read ? (
                <div class="inbox-card-actions">
                  <button type="button" class="btn-reply" disabled={reading !== null} onClick={() => void markRead(row)}>
                    {reading === row.id ? 'Saving…' : 'Mark as read'}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </div>
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
      <CardMeta label="Workflow needs you" at={row.createdAt} urgent />
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
      <CardMeta label="Standing permission" at={proposal.createdAt} />
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
        label={question.agentLabel && question.agentLabel !== 'Clem' ? `${question.agentLabel} asked` : 'Clem needs you'}
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
