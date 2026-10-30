import { ApprovalResult } from './ApprovalResult';
import { ConnectionSetup, type ConnectionResume } from './ConnectionSetup';
import { KeyRequestCard } from './KeyRequestCard';
import { SaveComputerTask } from './SaveComputerTask';
import { isComputerStepLabel } from '@/lib/toolLabels';
import { ApprovalReview } from './ApprovalReview';
import { PlanReview } from './PlanReview';
import type { PlanRevisionRef } from '@/lib/task-mode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { desktopAppLinkNavigation } from '@/lib/app-link-navigation';
import { ArrowUpRight, Check, Send, Square, Volume2, X } from 'lucide-react';
import { replySpeaker } from '@/lib/reply-speaker';
import { steerReceiptLabel, answerDraftStatus, canContinueTerminal, hiddenCardDecision, liveTurnText, renderMarkdown, retainedOutsideChange, terminalNoticeLine, terminalStatusPill, TerminalContinueGate, APPROVAL_ANSWER_WORDS, NOTICE_ACTION_LABEL, editableApprovalField, ApprovalDecisionGate, isIdentifierLike, normalizePendingActionResultRecord, retainPendingActionPresentation } from '@clem/chat-engine';
import type { ApprovalConfirm, ApprovalResolution, TerminalNoticeLine } from '@clem/chat-engine';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { ActivityCard } from '@/components/chat/ActivityCard';
import { TaskDetails } from '@/components/chat/TaskDetails';
import { TaskMemoryStatus } from '@/components/chat/TaskMemoryStatus';
import { taskHandlingSource } from '@/lib/task-handling-source';
import { hasExactMemoryWork } from '@/lib/task-memory-status';
import { useNowTick } from '@/components/chat/ActivityFeed';
import { TaskEvidenceFooter } from '@/components/chat/TaskEvidenceFooter';
import { OutsideWorkCards, TurnReceipt } from '@/components/chat/TurnReceipt';
import { WorkLine } from '@/components/chat/WorkLine';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import {
  approveExecutePendingAction,
  canOfferStandingSendTrust,
  getPendingActionStatus,
  pendingActionPresentationCopy,
  pendingActionRecordPresentation,
  pendingActionTerminalResultUpgrade,
  startPendingActionTerminalResultHydration,
  startQueuedPendingActionPolling,
  reconcilePendingActionExecutionFailure,
  resolvePendingActionExecutionPresentation,
  type PendingActionExecutionPhase,
  type PendingActionExecutionPresentation,
} from '@/lib/pendingActions';
import type { ChatMessage } from '@/lib/useChat';

const QUEUED_RUNNING_NOTE = 'Running the approved action now.';
type DurableActionPresentation = Extract<PendingActionExecutionPresentation, { mode: 'durable' }>;
type ActionExecutionView = { phase: 'idle' | PendingActionExecutionPhase; note?: string; details?: string;
  presentation?: DurableActionPresentation; observedExecution?: boolean; relationKey?: string };
function actionExecutionView(presentation: DurableActionPresentation, observedExecution = false): ActionExecutionView {
  const copy = pendingActionPresentationCopy(presentation);
  const defaultNote: Partial<Record<PendingActionExecutionPhase, string>> = {
    queued: 'Approved. It runs once the current work in this chat ends.',
    running: 'This exact queued action already has an execution claim. No second dispatch was attempted.',
    failed: 'The action failed or its final provider outcome needs review. Check the durable action before retrying.',
    rejected: 'You rejected this action. It was not dispatched.',
    expired: 'This approval expired. The action was not dispatched.',
    cancelled: 'This action was cancelled. It was not dispatched.',
    uncertain: 'The execution outcome is not confirmed. Check the durable action before continuing; do not retry it.',
  };
  return { phase: presentation.phase, note: copy.note?.trim() || defaultNote[presentation.phase],
    ...(copy.details ? { details: copy.details } : {}), presentation, observedExecution };
}
import { snoozeNeedsYou } from '@/lib/inbox';
import { activityTerminalOutcomeForMessageStatus } from '@/lib/activity-presentation';

/** What the pre-send check found in this exact content, before approval.
 *  Advisory: the owner decides either way. */
function ApprovalCheckNote({ check }: {
  check: { status: 'clear' | 'conflicts' | 'unavailable'; conflicts?: string[] };
}) {
  if (check.status === 'conflicts' && check.conflicts?.length) {
    return (
      <div className="mt-2 rounded-md border border-warning bg-warning-tint px-2.5 py-2 text-caption" role="note">
        <p className="font-semibold text-warning">Before you say yes</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg">
          {check.conflicts.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="mt-1 text-muted">Reply below with a change, or say yes as it is.</p>
      </div>
    );
  }
  return (
    <p className="mt-2 text-caption text-muted">
      {check.status === 'clear'
        ? 'Checked against your standing rules — no conflicts.'
        : 'Couldn’t check this against your standing rules.'}
    </p>
  );
}

/** "markdown_text" → "Markdown text": an argument name as a label. */
function approvalFieldLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/**
 * Clem's answer as a page, not a card. The shared renderer escapes every
 * character of the reply before adding markup, so model text can never inject
 * HTML; the phone renders through the same function, so an answer reads the
 * same on both. While the answer is still arriving the last block carries the
 * caret (styles.css `.chat-prose.is-streaming`).
 */
function ReplyProse({ text, streaming, failed }: { text: string; streaming?: boolean; failed?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const html = useMemo(() => renderMarkdown(text, { workspaceLinks: false, appPlaceLinks: 'desktop' }), [text]);
  return (
    <div
      className={cn('chat-prose min-w-0', streaming && 'is-streaming', failed && 'text-danger')}
      // A place Clem links opens inside the app, never as a page load.
      onClick={(event) => {
        const link = (event.target as Element).closest?.('a[data-app-place],a[data-app-item]');
        if (!link) return;
        const destination = desktopAppLinkNavigation({ href: link.getAttribute('href'), place: link.getAttribute('data-app-place'), item: link.getAttribute('data-app-item'), target: link.getAttribute('target'), download: link.hasAttribute('download') }, event, location.pathname);
        if (!destination) return;
        event.preventDefault();
        navigate(destination.href, { state: destination.state });
      }}
      // eslint-disable-next-line react/no-danger -- renderMarkdown escapes all input first
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** A draft stays on the page while it is checked or corrected, at full
 *  strength: only a draft the reviewer sent back dims, since those words will
 *  not stand. A quiet line underneath says where it stands, and only while the
 *  turn is live (a stopped turn keeps no "checking" line). */
function DraftFrame({ draft, live, children }: { draft: ChatMessage['answerDraft']; live: boolean; children: React.ReactNode }) {
  const status = live ? answerDraftStatus(draft) : null;
  const sentBack = draft?.phase === 'withdrawn' && draft.withdrawn === 'review';
  return (
    <>
      <div className={cn('transition-opacity duration-base', live && sentBack && 'opacity-60')} aria-busy={status ? true : undefined}>
        {children}
      </div>
      {status && (
        <p className={cn('flex items-center gap-2 text-caption', sentBack ? 'text-warning' : 'text-faint')} role="status">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {status}
        </p>
      )}
    </>
  );
}

/** Who is speaking, and when. The avatar lives here now rather than in a
 *  gutter beside every reply, so the answer can use the full column. */
/** Read this reply aloud, in the voice voice mode uses; press again to stop. */
function SpeakReplyButton({ replyKey, text }: { replyKey: string; text: string }) {
  const [speaking, setSpeaking] = useState(() => replySpeaker().current === replyKey);
  useEffect(() => replySpeaker().subscribe((key) => setSpeaking(key === replyKey)), [replyKey]);
  return (
    <button
      type="button"
      onClick={() => { replySpeaker().toggle(replyKey, text); }}
      aria-label={speaking ? 'Stop reading this reply' : 'Read this reply aloud'}
      aria-pressed={speaking}
      className={cn('inline-flex h-7 w-7 items-center justify-center self-start rounded-md text-muted transition-opacity hover:bg-surface-2 hover:text-fg',
        speaking ? 'opacity-100 text-primary' : 'opacity-0 group-hover/turn:opacity-100 focus-visible:opacity-100')}
    >
      {speaking ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

function TurnHeader({ at, quiet, speaker, project }: { at?: number; quiet?: boolean; speaker?: string; project?: string }) {
  const time = at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <div className={cn('flex items-center gap-2 text-small', quiet && 'opacity-70')}>
      <DogMark size={20} className="rounded-[5px]" />
      <span className="font-semibold text-fg">{speaker || 'Clem'}</span>
      {/* The project the reply was written in; it stays with the reply
          after the conversation moves on. */}
      {project && <span className="min-w-0 truncate text-caption text-muted">in {project}</span>}
      {time && <time className="font-mono text-caption text-faint" dateTime={new Date(at!).toISOString()}>{time}</time>}
    </div>
  );
}

/** A question's suggested answers as one-tap replies. The tap sends the
 *  option as your reply, exactly as if you had typed it; typing stays open for
 *  anything else. One tap only — the buttons latch so a double click cannot
 *  answer twice. */
function AnswerChoices({ options, onAnswer }: { options: string[]; onAnswer: (text: string) => Promise<void> | void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const choose = (option: string) => {
    if (chosen) return;
    setChosen(option);
    setError('');
    void Promise.resolve(onAnswer(option)).catch((e: unknown) => {
      setChosen(null);
      setError(e instanceof Error && e.message.trim() ? e.message.trim() : 'That answer didn’t send. Try again.');
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => choose(option)}
            disabled={chosen !== null}
            aria-pressed={chosen === option}
            className={cn(
              'rounded-md border px-3.5 py-2 text-left text-small font-semibold transition-colors duration-fast active:scale-press',
              chosen === option
                ? 'border-primary bg-primary-tint text-fg'
                : 'border-border-strong bg-surface text-fg hover:border-primary hover:bg-primary-tint disabled:opacity-50',
            )}
          >
            {option}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-caption text-danger">{error}</p>}
    </div>
  );
}

/** An approval card's answers, in the question card's style: one tap, the
 *  answer latches, and the owner's bubble reads the same words. Writing a
 *  change below stays open. */
function ApprovalAnswers({ chosen, disabled, onAnswer, onLater, confirming }: {
  chosen: 'approve' | 'reject' | null;
  disabled: boolean;
  onAnswer: (decision: 'approve' | 'reject') => void;
  onLater: () => void;
  /** The card's question was asked back: the answers settle THAT question. */
  confirming?: boolean;
}) {
  const answer = (pressed: boolean) => cn(
    'rounded-md border px-3.5 py-2 text-left text-small font-semibold transition-colors duration-fast active:scale-press',
    pressed ? 'border-primary bg-primary-tint text-fg'
      : 'border-border-strong bg-surface text-fg hover:border-primary hover:bg-primary-tint disabled:opacity-50',
  );
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div role="group" aria-label="Your answer" className="flex flex-wrap gap-2">
        <button type="button" className={answer(chosen === 'approve')} aria-pressed={chosen === 'approve'} disabled={disabled} onClick={() => onAnswer('approve')}>
          {APPROVAL_ANSWER_WORDS.approve.replace(/\.$/, '')}
        </button>
        <button type="button" className={answer(chosen === 'reject')} aria-pressed={chosen === 'reject'} disabled={disabled} onClick={() => onAnswer('reject')}>
          {APPROVAL_ANSWER_WORDS.reject.replace(/\.$/, '')}
        </button>
        {!confirming && (
          <button type="button" className={answer(false)} disabled={disabled} onClick={onLater}>
            Not now
          </button>
        )}
      </div>
      <p className="text-caption text-muted">
        {confirming ? 'Or say it another way below. Nothing runs until you answer.' : 'Or reply below to change it.'}
      </p>
    </div>
  );
}

/** Clem asked the card's own question back, ON the card: the owner's words,
 *  her one line, then the same answers (owner-approved design, 2026-10-07).
 *  A new bubble for it read as a new turn and lost the card. */
function ApprovalConfirmStrip({ confirm }: { confirm: ApprovalConfirm }) {
  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-border pt-3">
      {confirm.replyText && (
        <div className="flex items-start gap-2.5 text-small text-muted">
          <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-hover text-[10px] font-bold text-muted">You</span>
          <span>You wrote: <span className="text-fg">“{confirm.replyText}”</span></span>
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-fg">C</span>
        <p className="text-body font-medium text-fg">{confirm.question}</p>
      </div>
    </div>
  );
}

/** The owner changed the earlier card in words; this card is that change.
 *  Their words sit on the card, and the fields they changed show "Was: …". */
function ApprovalRevisionStrip({ changeRequest }: { changeRequest: string }) {
  return (
    <div className="mt-2.5 flex items-start gap-2.5 text-small text-muted">
      <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-hover text-[10px] font-bold text-muted">You</span>
      <span>You wrote: <span className="text-fg">“{changeRequest}”</span></span>
    </div>
  );
}

/** How a card ended, as one pill and nothing else: the ask above it greys,
 *  the follow-up turn says what it meant. */
function ApprovalOutcomePill({ resolution }: { resolution: ApprovalResolution }) {
  const tone = resolution === 'approved' ? 'bg-success-tint text-success'
    : resolution === 'changed' ? 'bg-info-tint text-info'
      : resolution === 'expired' ? 'bg-warning-tint text-warning'
        : 'bg-subtle text-muted';
  const label = resolution === 'approved' ? 'Approved'
    : resolution === 'declined' ? 'Declined'
      : resolution === 'changed' ? 'Changed · the revised version is below'
        : resolution === 'cancelled' ? 'Approval closed'
          : 'Expired · it did not run';
  return (
    <p className="mt-2.5 flex flex-wrap items-center gap-2 text-caption" role="status">
      <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold', tone)}>
        {resolution === 'approved' ? <Check className="h-3 w-3" aria-hidden /> : resolution === 'declined' ? <X className="h-3 w-3" aria-hidden /> : null}
        {label}
      </span>
      {resolution === 'changed' && <span className="text-muted">Nothing was sent from this one.</span>}
    </p>
  );
}

function PayloadPreview({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-caption font-semibold text-muted">Exact queued payload</summary>
      <pre className="mt-1 max-h-44 overflow-auto rounded-md bg-subtle p-2 font-mono text-caption text-muted">{text}</pre>
    </details>
  );
}

const NOTICE_ACTION_CLASS = 'inline-flex items-center rounded-sm border border-border-strong px-2 py-0.5 text-caption font-semibold text-fg transition-colors hover:border-primary hover:bg-primary-tint disabled:opacity-50';

/** A turn no model spoke for, as the app's own status line: what happened,
 *  the provider's words when it gave any (labelled as the provider's), and the
 *  one action that resolves it. Never a reply bubble, never read aloud.
 *  "Try again" sends those words as the owner's next message, and only while
 *  this is the newest turn. */
function NoticeLine({ line, onAnswer }: { line: TerminalNoticeLine; onAnswer?: (text: string) => Promise<void> | void }) {
  const [sent, setSent] = useState(false);
  const action = line.action;
  const tryAgain = () => {
    if (sent || !onAnswer) return;
    setSent(true);
    void Promise.resolve(onAnswer(NOTICE_ACTION_LABEL.try_again)).catch(() => setSent(false));
  };
  return (
    <>
      <StatusPill tone={line.tone}>{line.label}</StatusPill>
      {action === 'change_model' && (
        <Link to="/settings#who-does-what" className={NOTICE_ACTION_CLASS}>{NOTICE_ACTION_LABEL.change_model}</Link>
      )}
      {(action === 'sign_in' || action === 'add_credit') && (
        <Link to="/settings#accounts" className={NOTICE_ACTION_CLASS}>{NOTICE_ACTION_LABEL[action]}</Link>
      )}
      {action === 'try_again' && onAnswer && (
        <button type="button" className={NOTICE_ACTION_CLASS} onClick={tryAgain} disabled={sent}>{NOTICE_ACTION_LABEL.try_again}</button>
      )}
      {line.detail && <p className="basis-full text-caption text-muted">{line.detail}</p>}
    </>
  );
}

/** The parent owns the latest idle reply target. This gate owns only one
 * request from this terminal, never the task's eventual outcome. */
function TerminalContinueButton({ onContinue }: { onContinue: () => Promise<void> }) {
  const gate = useRef(new TerminalContinueGate());
  const [phase, setPhase] = useState(gate.current.phase);
  const [error, setError] = useState(false);
  const request = () => {
    if (gate.current.phase !== 'idle') return;
    setError(false);
    const pending = gate.current.run(onContinue);
    setPhase(gate.current.phase);
    void pending.then(
      () => setPhase(gate.current.phase),
      () => { setPhase(gate.current.phase); setError(true); },
    );
  };
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={phase !== 'idle'} aria-busy={phase === 'sending'} onClick={request}>
        {phase === 'sending' ? 'Continuing…' : phase === 'sent' ? 'Continue requested' : 'Continue'}
      </Button>
      {error && <p className="basis-full text-caption text-danger" role="alert">The request didn’t send. Choose Continue to try again.</p>}
    </div>
  );
}

/** Client-written stand-in when Stop fires before any tokens. The StatusPill
 *  is the record — do not wrap this string in a hollow reply card. */
const STOPPED_PLACEHOLDER = 'Stopped.';

/** A field the owner reads on the card: not a bare id, which stays under Details. */
function plainApprovalField(field: { name: string; value: string }): boolean {
  return !(isIdentifierLike(String(field.value ?? '')) || /\bids?$/i.test(approvalFieldLabel(field.name).trim()));
}

export function ChatBubble({
  message,
  onApprove,
  onReject,
  onApproveWithEdits,
  onBackground,
  traceHref,
  onAnswer,
  onContinue,
  onSendHeld,
  speaker,
  project,
  ownedTaskIds,
  sessionId, retainedHistorySources, executionBusy, onExecutePlan, onPreparePlan, onRevisePlan,
}: {
  message: ChatMessage;
  sessionId?: string;
  /** Exact source triples from normalized server history on a merged chat. */
  retainedHistorySources?: ReadonlySet<string>;
  /** The tasks this conversation delegated. Each has its own card under the
   *  thread (ConversationTasks), so the live strip over one is not drawn. */
  ownedTaskIds?: ReadonlySet<string>;
  /** Who is answering, when the thread works inside an agent. Clem otherwise. */
  speaker?: string;
  /** The project this reply worked in, by name. Absent when it worked in none. */
  project?: string;
  executionBusy?: boolean;
  onExecutePlan?: (ref: PlanRevisionRef) => Promise<void> | void;
  onPreparePlan?: (ref: PlanRevisionRef) => Promise<void> | void;
  onRevisePlan?: () => void;
  /**
   * Absent on a read-only transcript. A surface that cannot carry a decision
   * must not draw the controls for one: the replay thread passed
   * `() => {}` for both, so a historical approval rendered live-looking
   * Approve / Not now buttons that did nothing at all when clicked.
   */
  onApprove?: () => void | Promise<void>;
  onReject?: () => void | Promise<void>;
  /** Approve with the fields the owner retyped on the card. */
  onApproveWithEdits?: (fields: Record<string, string>) => void | Promise<void>;
  /** Detach THIS running turn to a durable background task (shown while thinking). */
  onBackground?: () => void;
  /** Deep link to this session's card/trace on the Tasks board. */
  traceHref?: string;
  /** Send a suggested answer as the reply. Absent on a read-only transcript,
   *  where a question is a record and its choices are not buttons. */
  onAnswer?: (text: string, resume?: ConnectionResume) => Promise<void> | void;
  /** The latest idle continuation target, guarded again by its owner before send. */
  onContinue?: () => Promise<void>;
  /** Send a message that waited for a turn to end, at the owner's tap. */
  onSendHeld?: (messageId: string) => void;
}) {
  const isUser = message.role === 'user';
  // Approve/Reject fire a follow-up turn but never patch THIS bubble's status, so
  // without a local latch the buttons stay live forever. Latch on first click.
  const [resolvedDecision, setResolvedDecision] = useState<'approve' | 'reject' | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decisionGate = useRef(new ApprovalDecisionGate());
  // "Not now" sets the decision aside — it stays pending in Needs you. It
  // used to decline it for good; declining is its own button now.
  const [setAside, setSetAside] = useState(false);
  const resolved = resolvedDecision !== null;
  // Execute-button truth (U3): a pending-action card's Execute fires the exact
  // stored call server-side and shows the DURABLE outcome — never a client-side
  // "Submitted" that outruns whether the send actually happened.
  const [storedExec, setStoredExec] = useState<ActionExecutionView>({ phase: 'idle' });
  // Grant-at-card (C, v2.3.0): opting in stores a NARROW standing send-trust
  // grant (exactly this card's recipients on this toolkit) so the next
  // identical send skips the card. trustNote reports the server's truth —
  // "stored" vs "couldn't scope it" — never an optimistic claim.
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  // EDIT BY HAND: the owner retypes the one field that carries the content
  // (the longest), then "Yes, send this one" sends exactly that, checked the
  // same way (owner-approved design, 2026-10-07).
  const [editing, setEditing] = useState(false);
  const [editedValue, setEditedValue] = useState('');
  const editableField = editableApprovalField(message.approval?.preview);
  const [trustNote, setTrustNote] = useState<string | null>(null);
  const pendingAction = message.approval?.pendingAction;
  const pendingActionId = pendingAction?.id ?? message.approval?.pendingActionId ?? message.approval?.resultRecord?.id;
  const pendingApprovalId = message.approval?.approvalId ?? message.approval?.pendingAction?.approvalId ?? null;
  const pendingPayloadHash = pendingAction?.payloadHash ?? message.approval?.payloadHash ?? message.approval?.resultRecord?.payloadHash;
  const pendingRevision = pendingAction?.updatedAt ?? message.approval?.recordUpdatedAt ?? message.approval?.resultRecord?.updatedAt;
  const actionRelationKey = JSON.stringify([pendingActionId, pendingApprovalId, pendingPayloadHash]);
  const currentActionRelation = useRef(actionRelationKey); currentActionRelation.current = actionRelationKey;
  const exec: ActionExecutionView = storedExec.relationKey === actionRelationKey ? storedExec : { phase: 'idle' };
  const setExec = (value: ActionExecutionView | ((current: ActionExecutionView) => ActionExecutionView)) => {
    setStoredExec(current => {
      if (currentActionRelation.current !== actionRelationKey) return current;
      const own = current.relationKey === actionRelationKey ? current : { phase: 'idle' as const };
      return { ...(typeof value === 'function' ? value(own) : value), relationKey: actionRelationKey };
    });
  };
  const queuedCardKey = JSON.stringify([pendingActionId, pendingApprovalId, pendingPayloadHash, pendingRevision]);
  const currentQueuedCard = useRef(queuedCardKey);
  currentQueuedCard.current = queuedCardKey;
  const showDurablePresentation = (presentation: PendingActionExecutionPresentation) => {
    if (presentation.mode !== 'durable') return false;
    setExec(actionExecutionView(presentation, true));
    return true;
  };
  const propResultKey = useMemo(() => JSON.stringify([pendingAction?.status, pendingAction?.resultSummary, pendingAction?.publicResult]),
    [pendingAction?.status, pendingAction?.resultSummary, pendingAction?.publicResult]);
  const hydrationCardKey = useMemo(() => JSON.stringify([queuedCardKey, propResultKey]), [queuedCardKey, propResultKey]);
  const currentHydrationCard = useRef(hydrationCardKey);
  currentHydrationCard.current = hydrationCardKey;
  useEffect(() => {
    if (!pendingAction || pendingAction.approvalId !== pendingApprovalId) return;
    const presentation = pendingActionRecordPresentation(pendingAction);
    if (presentation?.mode !== 'durable') return;
    setExec((current) => {
      const known = current.phase === 'idle' ? undefined : current.presentation
        ?? { mode: 'durable' as const, phase: current.phase, ...(current.note ? { note: current.note } : {}) };
      const retained = retainPendingActionPresentation(known, presentation);
      return retained?.mode === 'durable' ? actionExecutionView(retained, current.observedExecution) : current;
    });
  }, [pendingActionId, pendingApprovalId, pendingPayloadHash, pendingRevision, propResultKey]);
  const terminalResultKey = useMemo(() => JSON.stringify(exec.presentation), [exec.presentation]);
  useEffect(() => {
    const settled = exec.presentation;
    const result = settled?.publicResult;
    if (!settled || !result || result.pendingActionId !== pendingActionId || result.approvalId !== pendingApprovalId
      || result.payloadHash !== pendingPayloadHash || Date.parse(pendingRevision ?? '') > Date.parse(result.recordUpdatedAt)) return;
    const propTerminal = pendingAction && pendingActionRecordPresentation(pendingAction);
    if (propTerminal?.mode === 'durable' && (pendingRevision !== result.recordUpdatedAt
      || propTerminal.phase !== settled.phase || pendingAction?.resultSummary !== settled.recordResultSummary)) return;
    return startPendingActionTerminalResultHydration(settled,
      () => getPendingActionStatus(result.pendingActionId), (presentation) => {
        if (currentHydrationCard.current !== hydrationCardKey) return;
        setExec((current) => {
          const enriched = pendingActionTerminalResultUpgrade(current.presentation, presentation);
          return enriched?.mode === 'durable' ? actionExecutionView(enriched) : current;
        });
      }, { observedExecution: exec.observedExecution });
  }, [hydrationCardKey, terminalResultKey, exec.observedExecution]);
  // A queued card follows its durable record until the resume picks it up,
  // so the label moves from "Up next" to the real outcome by itself.
  const followingQueued = exec.observedExecution === true && (exec.phase === 'queued' || (exec.phase === 'running' && exec.note === QUEUED_RUNNING_NOTE));
  useEffect(() => {
    if (!pendingActionId || !followingQueued) return;
    return startQueuedPendingActionPolling({
      id: pendingActionId, approvalId: pendingApprovalId, payloadHash: pendingPayloadHash ?? '', updatedAt: pendingRevision ?? '',
    }, () => getPendingActionStatus(pendingActionId), (progress) => {
      // Props can change before the previous effect's cleanup runs. Never
      // attach that card's late response to a replacement/revised card.
      if (currentQueuedCard.current !== queuedCardKey || progress.mode !== 'durable') return;
      if (progress.phase === 'running') setExec({ phase: 'running', note: QUEUED_RUNNING_NOTE, observedExecution: true });
      else showDurablePresentation(progress);
    });
  }, [pendingActionId, pendingApprovalId, pendingPayloadHash, pendingRevision, queuedCardKey, followingQueued]);
  const runExecute = async () => {
    if (!pendingActionId || resolved || decisionBusy || editing || message.approval?.resolution || exec.phase !== 'idle') return;
    await decisionGate.current.run(async () => {
      setDecisionBusy('approve');
      setResolvedDecision('approve');
      setExec({ phase: 'running' });
      try {
        const result = await approveExecutePendingAction(pendingActionId, message.approval?.approvalId ?? undefined, alwaysAllow);
        if (alwaysAllow) {
          setTrustNote(result.trustGranted
            ? 'Standing trust saved — identical sends to these recipients won’t ask again. Revoke anytime in Settings.'
            : 'Couldn’t save standing trust for this one (no verifiable recipients) — it will still ask next time.');
        }
        const presentation = await resolvePendingActionExecutionPresentation(
          result,
          () => getPendingActionStatus(pendingActionId),
          { card: { id: pendingActionId, approvalId: pendingApprovalId, payloadHash: pendingPayloadHash ?? '', updatedAt: pendingRevision ?? '' } },
        );
        if (!showDurablePresentation(presentation)) {
          // A genuinely queued/non-executable legacy card still belongs to the
          // conversational approval path. EXECUTING / EXECUTED / FAILED skips
          // are handled above from durable truth and can never reach this call.
          setExec({ phase: 'idle' });
          await onApprove?.();
        }
      } catch {
        // A lost POST response cannot prove the provider did not act. Reconcile
        // the record; bounded failure becomes explicit do-not-retry uncertainty.
        const presentation = await reconcilePendingActionExecutionFailure(
          () => getPendingActionStatus(pendingActionId),
          { card: { id: pendingActionId, approvalId: pendingApprovalId, payloadHash: pendingPayloadHash ?? '', updatedAt: pendingRevision ?? '' } },
        );
        showDurablePresentation(presentation);
      } finally {
        setDecisionBusy(null);
      }
    });
  };
  const resolvePlainDecision = async (decision: 'approve' | 'reject') => {
    if (resolved || decisionBusy || editing || message.approval?.resolution) return;
    await decisionGate.current.run(async () => {
      setDecisionBusy(decision);
      setDecisionError(null);
      try {
        await Promise.resolve(decision === 'approve' ? onApprove?.() : onReject?.());
        setResolvedDecision(decision);
      } catch (error) {
        setDecisionError(error instanceof Error && error.message.trim()
          ? error.message.trim()
          : `Could not ${decision} this ${message.status === 'awaiting-plan' ? 'plan' : 'request'}.`);
      } finally {
        setDecisionBusy(null);
      }
    });
  };

  const submitEditedDecision = async () => {
    if (resolved || message.approval?.resolution || !editableField || !onApproveWithEdits
      || !editedValue.trim() || editedValue === editableField.value) return;
    await decisionGate.current.run(async () => {
      setDecisionBusy('approve');
      setDecisionError(null);
      try {
        await onApproveWithEdits({ [editableField.name]: editedValue });
        setResolvedDecision('approve');
        setEditing(false);
      } catch (error) {
        setDecisionError(error instanceof Error && error.message.trim() ? error.message.trim() : 'That edit could not be sent. Your edit is still here.');
      } finally {
        setDecisionBusy(null);
      }
    });
  };

  const snoozeKey = message.status === 'awaiting-plan'
    ? (message.planProposalId ? `plan:${message.planProposalId}` : '')
    : (message.approval?.approvalId ? `approval:${message.approval.approvalId}` : '');
  const setAsideForLater = async () => {
    if (resolved || decisionBusy) return;
    setDecisionError(null);
    try {
      if (snoozeKey) await snoozeNeedsYou(snoozeKey);
      setSetAside(true);
    } catch (error) {
      setDecisionError(error instanceof Error && error.message.trim() ? error.message.trim() : 'Couldn’t set this aside.');
    }
  };

  // A card tap sent from the phone and the host's reply to it belong to the
  // card, not the conversation; only one that failed to land is shown. A
  // decided card keeps its own receipt, without claiming its work finished.
  if (hiddenCardDecision(message)) return null;
  const retainedActionResult = normalizePendingActionResultRecord(message.approval?.resultRecord);
  const resultClosesQuestion = retainedActionResult?.approvalId === message.approval?.approvalId
    && !['queued', 'approval_requested'].includes(retainedActionResult?.status ?? 'queued');
  const observedActionSettled = exec.observedExecution === true && ['executed', 'failed', 'rejected', 'expired', 'cancelled'].includes(exec.phase);
  if (!isUser && message.status === 'awaiting-approval' && message.approval && (message.approval.resolution || resultClosesQuestion || observedActionSettled)) {
    return <ApprovalResult approval={message.approval} observed={exec.phase !== 'idle'
      ? exec.presentation ?? { mode: 'durable', phase: exec.phase, ...(exec.note ? { note: exec.note } : {}) } : undefined} />;
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[min(85%,34rem)] rounded-[20px] rounded-br-md bg-subtle px-4 py-2.5">
          <p className="whitespace-pre-wrap text-body-lg text-fg">{message.text}</p>
          {message.attachmentNames && message.attachmentNames.length > 0 && (
            <p className="mt-1 text-caption text-muted">📎 {message.attachmentNames.join(', ')}</p>
          )}
          {message.steer && (
            <p className="mt-1 text-caption text-muted">
              {steerReceiptLabel(message)}
              {(message.steer === 'held' || message.steerFollowUp === 'held') && onSendHeld && (
                <>
                  {' · '}
                  <button type="button" className="font-medium text-fg underline-offset-2 hover:underline"
                    onClick={() => onSendHeld(message.id)}>Send now</button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (message.delegated) {
    // A task with an owner is shown by its own card, which names that owner.
    if (message.delegated.taskId && ownedTaskIds?.has(message.delegated.taskId)) return null;
    return <DelegatedWorkCard message={message} delegated={message.delegated} />;
  }

  // A check-in is Clem talking WHILE she works — not the answer. It reads as a
  // quieter aside so a returning reader can scan what happened without
  // mistaking any of it for the result they were waiting on.
  if (message.checkIn) {
    return (
      <div className="flex flex-col gap-1.5">
        <TurnHeader quiet />
        <p className="whitespace-pre-wrap border-l-2 border-dashed border-border-strong pl-3.5 text-body leading-relaxed text-muted">
          {linkify(message.text)}
        </p>
      </div>
    );
  }

  const thinking = message.status === 'thinking';
  const live = thinking || Boolean(message.workflowLive);
  const handlingSource = !live ? taskHandlingSource(message, sessionId, retainedHistorySources) : null;
  const currentMemoryWork = hasExactMemoryWork(message.terminal, handlingSource);
  // A decision needs somewhere to go. Without both handlers this thread is a
  // replay, and the card is a record rather than a control.
  const canDecide = Boolean(onApprove && onReject);
  // A plain approval the checker wrote in Clem's words reads like a question
  // card: her question, why, the exact content, and answers to tap.
  const voicedApproval = message.status === 'awaiting-approval' && !pendingAction
    && Boolean(message.approval?.preview?.ask) && !message.approval?.preview?.items;
  // A queued action card speaks the same way: Clem's question and why as the
  // heading, the exact command or content under it, answers to tap. Tool
  // names, ids and hashes stay out of the owner's sight.
  const voicedPendingAction = message.status === 'awaiting-approval' && Boolean(pendingAction?.ask);
  const pendingActionShowsRisk = Boolean(pendingAction?.risk) && pendingAction!.risk !== 'normal approval risk';
  // A queued action revised in words: the previous command, to show struck.
  const revisedCommand = (() => {
    const was = message.approval?.revises?.fields?.find((f) => f.name === 'command' || f.name === 'content')?.value;
    return was && pendingAction?.preview && was !== pendingAction.preview ? was : null;
  })();
  const pendingActionShowsRollback = Boolean(pendingAction?.rollback) && pendingAction!.rollback !== 'no rollback noted';
  const stoppedPlaceholder = message.status === 'stopped' && message.text.trim() === STOPPED_PLACEHOLDER;
  // THE PLAN CARD IS THE REPLY.
  //
  // publishedPlanTerminal returns the model's own `full_text` as the turn's
  // reply, deliberately — on a surface with no card (Discord, CLI) that is the
  // only way the plan reaches the person, in her voice rather than the
  // engine's. This surface DOES render the artifact, and PlanReview already
  // shows that same full_text, so rendering both would print the plan twice
  // and push the Execute/Approve controls off screen.
  //
  // The harness is right to send both; a surface that renders one must not
  // render the other.
  const planCardCarriesTheReply = Boolean(message.planArtifactRef);
  // While she works, the sentence she wrote before a tool ran and her first
  // words lead the work line instead of sitting in the answer's place; a draft
  // set aside for a tool call, or text that is the call itself, is never shown
  // as an answer. One rule for desktop and phone (chat-engine liveTurnText).
  const turnText = liveTurnText(message, thinking);
  const liveWords = turnText.words;
  const hasReplyText = turnText.showReply
    && !stoppedPlaceholder
    && !planCardCarriesTheReply;
  // A turn with no words, no plan and no decision draws no reply at all: the
  // work line is the whole story until the answer arrives.
  const showReply = planCardCarriesTheReply
    || message.status === 'awaiting-approval'
    || message.status === 'awaiting-plan'
    || Boolean(message.taskRef && (message.status === 'complete' || message.status === 'awaiting-reply'))
    || hasReplyText;
  const answerable = message.status === 'awaiting-reply' && Boolean(onAnswer) && (message.options?.length ?? 0) > 0;
  const keyRequest = message.status === 'awaiting-reply' && onAnswer ? message.keyRequest ?? null : null;
  return (
    <article className="group/turn flex min-w-0 flex-col gap-2.5" aria-label={project ? `${speaker || 'Clem'}, in ${project}` : speaker || 'Clem'}>
      <TurnHeader at={message.startedAt ?? message.sentAt} speaker={speaker} project={project} />
      {/* The work rides ABOVE the answer: while the turn runs it is the whole
          story (steps, helpers, the live line); once the answer lands it folds
          to one line you can reopen. */}
      {(live || (message.activity && message.activity.length > 0)) && (
        <WorkLine
          items={message.activity ?? []}
          live={live}
          progress={message.progress}
          words={liveWords || undefined}
          terminalOutcome={live ? undefined : activityTerminalOutcomeForMessageStatus(message.status)}
          traceHref={traceHref}
          onBackground={live ? onBackground : undefined}
        />
      )}
      {showReply && (
        <>
          {message.taskMode?.kind === 'plan' && <div className="text-caption font-semibold text-primary">{thinking ? 'Planning · read-only investigation' : 'Plan investigation'}</div>}
          {message.planArtifactRef && <PlanReview planRef={message.planArtifactRef} sessionId={sessionId} busy={executionBusy} onPrepare={onPreparePlan} onExecute={onExecutePlan} onRevise={onRevisePlan} />}
          {hasReplyText && (
            <DraftFrame draft={message.answerDraft} live={thinking}>
              <ReplyProse
                text={message.text}
                streaming={thinking && message.answerDraft?.phase !== 'withdrawn' && message.answerDraft?.phase !== 'checking'}
                failed={message.status === 'failed'}
              />
            </DraftFrame>
          )}
          {hasReplyText && !thinking && message.status !== 'failed' && (
            <SpeakReplyButton replyKey={message.id} text={message.text} />
          )}

        {((message.status === 'awaiting-approval' && message.approval) || message.status === 'awaiting-plan') && (
          <div className={cn('rounded-md border p-3', voicedApproval || voicedPendingAction ? 'border-border bg-surface' : 'border-warning/40 bg-warning-tint')}>
            {voicedPendingAction ? (
              <>
                <p className="text-body text-fg">{pendingAction!.ask}</p>
                {pendingAction!.why && <p className="mt-1 text-small text-muted">{pendingAction!.why}</p>}
                {pendingAction!.preview && pendingAction!.preview !== 'no preview supplied' && !message.approval?.preview?.fields.length && (
                  <>
                    <p className="mt-2.5 text-caption font-semibold uppercase tracking-wide text-faint">Exactly what happens</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-caption text-fg">{pendingAction!.preview}</pre>
                  </>
                )}
                {pendingActionShowsRisk && <p className="mt-1.5 text-caption text-warning">{pendingAction!.risk}</p>}
                {pendingActionShowsRollback && <p className="mt-1 text-caption text-muted">{pendingAction!.rollback}</p>}
                {revisedCommand && (
                  // The change in words, shown as a change: what it was, struck.
                  <p className="mt-1 text-caption text-muted">Was: <span className="line-through">{revisedCommand}</span></p>
                )}
                {message.approval?.revises?.changeRequest && (
                  <ApprovalRevisionStrip changeRequest={message.approval.revises.changeRequest} />
                )}
              </>
            ) : voicedApproval ? (
              // Clem asks in her own words, like a question card (the checker
              // wrote them from the exact call); the content below is exact.
              <>
                <p className="text-body text-fg">{message.approval!.preview!.ask}</p>
                {message.approval!.preview!.why && <p className="mt-1 text-small text-muted">{message.approval!.preview!.why}</p>}
              </>
            ) : (
            <p className="text-small font-semibold text-fg">
              {message.status === 'awaiting-plan'
                ? 'Approve this plan to continue?'
                : pendingAction
                  ? `Ready to execute: ${pendingAction.title}`
                  : message.approval?.preview?.items ? `Review ${message.approval.preview.items.length} actions`
                    : `Approve: ${message.approval?.subject ?? 'this action'}`}
            </p>
            )}
            {pendingAction && !voicedPendingAction && (
              <div className="mt-1 space-y-0.5 text-caption text-muted">
                <div>Tool: <span className="font-mono">{pendingAction.toolName}</span></div>
                {pendingAction.targetSummary && <div>Target: {pendingAction.targetSummary}</div>}
                {pendingAction.preview && <div className="whitespace-pre-wrap">Preview: {pendingAction.preview}</div>}
                {pendingAction.risk && <div className="whitespace-pre-wrap text-warning">Risk: {pendingAction.risk}</div>}
                {pendingAction.rollback && <div className="whitespace-pre-wrap">Rollback: {pendingAction.rollback}</div>}
                {pendingAction.payloadHash && <div>Payload hash: <span className="font-mono">{pendingAction.payloadHash}</span></div>}
              </div>
            )}
            {message.approval?.reason && !voicedApproval && !voicedPendingAction && <p className="mt-0.5 text-caption text-muted">{message.approval.reason}</p>}
            {!pendingAction && message.approval?.preview?.check && (
              <ApprovalCheckNote check={message.approval.preview.check} />
            )}
            {message.approval?.preview && !message.approval.preview.items && message.approval.preview.fields.length > 0 && (
              // What approving would actually send: each argument the tool
              // receives, from the host's frozen call, so the owner never
              // approves on an operation's name alone.
              <>
              {voicedApproval && message.approval.revises?.changeRequest && (
                <ApprovalRevisionStrip changeRequest={message.approval.revises.changeRequest} />
              )}
              {(voicedApproval || voicedPendingAction) && (
                <div className="mt-2.5 flex items-center justify-between">
                  <p className="text-caption font-semibold uppercase tracking-wide text-faint">{message.approval.preview.does ? 'What I’ll do' : 'Exactly what happens'}</p>
                  {editableField && onApproveWithEdits && !resolved && !message.approval.resolution && !editing && (
                    <button type="button" className="text-caption font-semibold text-primary-ink hover:underline"
                      onClick={() => { setEditedValue(editableField.value); setEditing(true); }}>
                      Edit by hand
                    </button>
                  )}
                </div>
              )}
              {editing && editableField && !resolved && !message.approval.resolution && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <label htmlFor={`edit-${message.id}`} className="text-caption text-muted">{approvalFieldLabel(editableField.name)}</label>
                  <textarea id={`edit-${message.id}`} rows={3} value={editedValue} disabled={decisionBusy !== null} onChange={(e) => setEditedValue(e.target.value)}
                    className="w-full rounded-md border border-primary-ink bg-surface px-2.5 py-2 text-small text-fg" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" disabled={decisionBusy !== null || !editedValue.trim() || editedValue === editableField.value}
                      onClick={() => { void submitEditedDecision(); }}>
                      {decisionBusy ? 'Sending…' : 'Yes, send this one'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={decisionBusy !== null} onClick={() => setEditing(false)}>Keep the original</Button>
                  </div>
                  <p className="text-caption text-muted">Exactly what you typed goes out, checked the same way first.</p>
                </div>
              )}
              {/* What will happen, in one plain sentence by name and place,
                  above the exact content (owner 2026-10-21: "a cleaner what
                  Clem is going to do"). */}
              {voicedApproval && message.approval.preview.does && (
                <p className="mt-1 text-body text-fg">{message.approval.preview.does}</p>
              )}
              <dl className={cn('mt-2 space-y-1.5 text-caption', editing && 'opacity-60')}>
                {/* Plain first, as in Needs you (owner 2026-10-18: no weird
                    approval messages): a bare id stays under Details and a
                    long block (a script, a page of text) folds behind its label. */}
                {message.approval.preview.fields.filter((field) => !field.detail && plainApprovalField(field)).map((field) => {
                  const was = message.approval?.revises?.fields?.find((f) => f.name === field.name);
                  const changed = Boolean(was && was.value !== field.value);
                  const shown = field.label ?? field.display ?? field.value;
                  // The words the action carries (a note, an email body) are
                  // what the owner is approving: shown open as a page, never
                  // folded (owner 2026-10-21: "I had to expand that"). A long
                  // block with no prose in it (a script, raw data) still folds.
                  const isMessage = !changed && field.name === editableField?.name && /\s/.test(String(shown).trim());
                  return (
                    <div key={field.name}>
                      <dt className="text-muted">{approvalFieldLabel(field.name)}</dt>
                      {isMessage ? (
                        <dd className="mt-1 max-h-[26rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-subtle px-3 py-2.5 text-small leading-relaxed text-fg">
                          {shown}
                        </dd>
                      ) : !changed && String(shown).length > 280 ? (
                        <dd>
                          <details className="rounded-md border border-border bg-subtle">
                            <summary className="cursor-pointer px-2.5 py-1.5 font-semibold text-muted">Show the full {approvalFieldLabel(field.name).toLowerCase()}</summary>
                            <p className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 text-fg">{shown}</p>
                          </details>
                        </dd>
                      ) : (
                      <dd className={cn('whitespace-pre-wrap break-words text-fg', changed && '-mx-1.5 rounded bg-primary-tint px-1.5 py-0.5')}>
                        {/* A named id reads as its name; the id itself is under Details. */}
                        {shown}
                      </dd>
                      )}
                      {changed && (
                        // The change in words, shown as a change: what it was, struck.
                        <dd className="mt-0.5 text-muted">Was: <span className="line-through">{was!.value}</span></dd>
                      )}
                    </div>
                  );
                })}
              </dl>
              {message.approval.preview.fields.some((field) => field.detail || field.label || field.display || !plainApprovalField(field)) && (
                // The plumbing (ids, flags, the raw JSON) stays one tap away,
                // never in the way of what the owner is approving.
                <details className="mt-2 text-caption text-muted">
                  <summary className="cursor-pointer select-none">Details</summary>
                  <dl className="mt-1.5 space-y-1">
                    {message.approval.preview.fields
                      .filter((field) => field.detail || field.label || field.display || !plainApprovalField(field))
                      .map((field) => (
                        <div key={field.name}>
                          <dt>{approvalFieldLabel(field.name)}</dt>
                          <dd className="whitespace-pre-wrap break-all">{field.value}</dd>
                        </div>
                      ))}
                  </dl>
                </details>
              )}
              </>
            )}
            {!pendingAction && message.approval?.preview?.items && <ApprovalReview preview={message.approval.preview} />}
            {pendingAction && !voicedPendingAction && <PayloadPreview value={pendingAction.payload} />}
            {message.approval?.confirm && !resolved && !message.approval.resolution && (
              <ApprovalConfirmStrip confirm={message.approval.confirm} />
            )}
            {pendingAction && (message.approval?.resolution === 'approved' || message.approval?.resolution === 'declined') && (
              <ApprovalOutcomePill resolution={message.approval.resolution} />
            )}
            {canOfferStandingSendTrust(pendingAction) && !resolved && !message.approval?.resolution && exec.phase === 'idle' && (
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-caption text-muted">
                <input
                  type="checkbox"
                  checked={alwaysAllow}
                  onChange={(e) => setAlwaysAllow(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--color-primary,#f97316)]"
                />
                Always allow sends like this (same recipients — revocable in Settings)
              </label>
            )}
            {!canDecide ? (
              <p className="mt-2.5 text-caption text-muted">
                This is a record of what was asked. Answer it where it is live — in Needs you.
              </p>
            ) : message.approval?.resolution && (!pendingAction || message.approval.resolution === 'expired') ? (
              // Answered on the host's record, including by a written reply. An
              // expired card has nothing left to execute, queued action or not.
              <ApprovalOutcomePill resolution={message.approval.resolution} />
            ) : setAside && !resolved ? (
              <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted" role="status">
                Left for later — it’s waiting in Needs you.
                <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setSetAside(false)}>
                  Decide now
                </button>
              </p>
            ) : editing ? null : voicedApproval ? (
              <ApprovalAnswers
                chosen={resolvedDecision ?? decisionBusy}
                disabled={resolved || decisionBusy !== null}
                onAnswer={(decision) => { void resolvePlainDecision(decision); }}
                onLater={() => { void setAsideForLater(); }}
                confirming={Boolean(message.approval?.confirm)}
              />
            ) : (
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                disabled={resolved || Boolean(message.approval?.resolution) || decisionBusy !== null || exec.phase !== 'idle'}
                onClick={pendingAction ? runExecute : () => { void resolvePlainDecision('approve'); }}
              >
                {pendingAction ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                {pendingAction ? (voicedPendingAction ? 'Yes, go ahead' : 'Execute queued action') : message.approval?.preview?.items ? `Approve all ${message.approval.preview.items.length}` : 'Approve'}
              </Button>
              <Button size="sm" variant="secondary" disabled={resolved || Boolean(message.approval?.resolution) || decisionBusy !== null || exec.phase !== 'idle'} onClick={() => { void resolvePlainDecision('reject'); }}><X className="h-4 w-4" aria-hidden /> {voicedPendingAction ? 'No, skip it' : 'Decline'}</Button>
              {!resolved && !message.approval?.resolution && exec.phase === 'idle' && (
                <Button size="sm" variant="ghost" disabled={decisionBusy !== null} onClick={() => { void setAsideForLater(); }}>Not now</Button>
              )}
              {/* Truth, not a latch: for a pending-action card the label reflects
                  the durable executor outcome; the plain approve/plan path keeps
                  the "Submitted" acknowledgement (its follow-up turn carries the
                  real result). */}
              {pendingAction ? (
                <span role="status" aria-live="polite" aria-atomic="true">
                  {exec.phase === 'queued' ? <span className="text-caption font-semibold text-muted">Approved — up next</span>
                    : exec.phase === 'running' ? <span className="text-caption text-muted">Running…</span>
                    : exec.phase === 'executed' ? <span className="text-caption font-semibold text-success">Done ✓</span>
                      : exec.phase === 'failed' ? <span className="text-caption font-semibold text-danger">Didn't go through — needs a look</span>
                        : exec.phase === 'rejected' ? <span className="text-caption font-semibold text-muted">Skipped — nothing ran</span>
                          : exec.phase === 'expired' ? <span className="text-caption font-semibold text-muted">Expired — nothing ran</span>
                            : exec.phase === 'cancelled' ? <span className="text-caption font-semibold text-muted">Cancelled — nothing ran</span>
                              : exec.phase === 'uncertain' ? <span className="text-caption font-semibold text-warning">Outcome not confirmed</span>
                                : null}
                </span>
              ) : (
                resolved && (
                  <span className="text-caption text-muted">
                    {message.status === 'awaiting-plan'
                      ? resolvedDecision === 'approve' ? 'Plan approved and queued' : 'Plan rejected — nothing queued'
                      : 'Submitted'}
                  </span>
                )
              )}
            </div>
            )}
            {decisionError && <p role="alert" className="mt-1.5 text-caption text-danger">{decisionError}</p>}
            {pendingAction && exec.note && exec.phase !== 'idle' && (
              <div className="mt-1.5 min-w-0 text-caption text-muted">
                <ReplyProse text={exec.note} failed={exec.phase === 'failed'} />
              </div>
            )}
            {pendingAction && exec.details && exec.phase !== 'idle' && (
              <details className="mt-2 min-w-0 text-caption text-muted">
                <summary className="cursor-pointer">Execution details</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-caption text-fg">{exec.details}</pre>
              </details>
            )}
            {trustNote && <p className="mt-1 text-caption text-muted">{trustNote}</p>}
          </div>
        )}

          {/* Durable evidence beneath a report-back: the harness's ledger row
              (status, counts, verified artifacts, receipts, exact next action)
              so completion never rests on the prose above it. */}
          {message.status === 'complete' && message.acceptedSource
            && message.activity?.some((row) => row.kind === 'tool' && isComputerStepLabel(row.label)) && (
            <SaveComputerTask source={{ sessionId: message.acceptedSource.sessionId, sourceUserSeq: message.acceptedSource.sourceUserSeq }} />
          )}
          {message.taskRef && (message.status === 'complete' || message.status === 'awaiting-reply') && (
            <TaskEvidenceFooter taskRef={message.taskRef} />
          )}
        </>
      )}

      {keyRequest && <KeyRequestCard request={keyRequest} onAnswer={onAnswer!} />}

      {answerable && (sessionId ? <ConnectionSetup sessionId={sessionId} options={message.options!}
        revision={JSON.stringify(message.terminal)} onContinue={onAnswer!}
        fallback={<AnswerChoices options={message.options!} onAnswer={onAnswer!} />}
        renderOtherAnswers={(options) => options.length ? <AnswerChoices options={options} onAnswer={onAnswer!} /> : null} />
        : <AnswerChoices options={message.options!} onAnswer={onAnswer!} />)}

        {/* The backend's TYPED terminal decides the pill. The legacy MessageStatus
            collapses blocked/cancelled/uncertain into "failed"/"stopped" and cannot
            tell a question from a resumable "say continue"; when the harness sent
            its typed facts, mirror them, with what the turn kept. A notice is the
            app's status line in place of the pill. Legacy events keep the old
            pills. The wording is shared with the phone (chat-engine). */}
        {(() => {
          const t = message.terminal;
          const outside = retainedOutsideChange(t);
          const outsideChip = outside ? <StatusPill tone={outside.tone}>{outside.label}</StatusPill> : null;
          const row = (children: React.ReactNode) => (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{children}{outsideChip}</div>
          );
          const notice = terminalNoticeLine(t);
          if (notice) return row(<NoticeLine line={notice} onAnswer={onAnswer} />);
          const pill = terminalStatusPill(t, { wordless: !hasReplyText });
          if (pill) return row(<>
            <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
            {onContinue && !executionBusy && !live && !currentMemoryWork && canContinueTerminal(message) && (
              <TerminalContinueButton key={message.id} onContinue={onContinue} />
            )}
          </>);
          if (message.status === 'awaiting-reply' || message.status === 'stopped' || message.status === 'failed') {
            return row(
              <>
                {message.status === 'awaiting-reply' && <StatusPill tone="info">{answerable ? 'Waiting on you · tap an answer or reply below' : 'Reply below to continue'}</StatusPill>}
                {message.status === 'stopped' && <StatusPill tone="neutral">Stopped</StatusPill>}
                {message.status === 'failed' && <StatusPill tone="danger">Didn't finish</StatusPill>}
              </>,
            );
          }
          return outsideChip ? row(null) : null;
        })()}

        {/* What she made, whether it was checked, what the turn touched, and
            (on hover) which model did the work. A confirmed change in another
            app shows as soon as it lands; the rest waits for the turn's end. */}
        {live
          ? <OutsideWorkCards activity={message.activity} />
          : <TurnReceipt activity={message.activity} terminal={message.terminal} text={hasReplyText ? message.text : ''} sessionId={sessionId} />}
        {currentMemoryWork && handlingSource && <TaskMemoryStatus key={`memory:${handlingSource.sessionId}:${handlingSource.sourceUserSeq}`} {...handlingSource} />}
        {handlingSource && <TaskDetails key={`${handlingSource.sessionId}:${handlingSource.sourceUserSeq}`} {...handlingSource} />}
    </article>
  );
}

/**
 * The delegated-work live card (2026-08-04): a real-time window in the chat
 * onto a background task this conversation spawned. Visually distinct from a
 * turn reply — breathing status dot, its own header, a ticking elapsed clock,
 * the shared TurnActivity feed (batch meters, per-tool rows, agent dots), a
 * deep link to the full run on the Tasks board, and the steering affordance:
 * the conversation stays live, so a reply redirects the running work.
 */
function DelegatedWorkCard({ message, delegated }: {
  message: ChatMessage;
  delegated: NonNullable<ChatMessage['delegated']>;
}) {
  const now = useNowTick(true);
  // Anchor the clock to the SERVER's task start when the task is known — the
  // client-open anchor lied after a reattach (a 20-minute run read as
  // seconds). One lazy fetch; until it lands, the client anchor stands with
  // an honest tooltip.
  const [serverStartedAt, setServerStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!delegated.taskId) return;
    let cancelled = false;
    void import('@/lib/board').then(({ getBackgroundTaskDetail }) =>
      getBackgroundTaskDetail(delegated.taskId as string).then((detail) => {
        const raw = detail?.task?.startedAt ?? detail?.task?.createdAt;
        const parsed = raw ? Date.parse(raw) : Number.NaN;
        if (!cancelled && Number.isFinite(parsed)) setServerStartedAt(parsed);
      }),
    ).catch(() => { /* the client anchor remains the honest fallback */ });
    return () => { cancelled = true; };
  }, [delegated.taskId]);
  const anchor = serverStartedAt ?? delegated.startedAt;
  const elapsedMin = Math.max(0, Math.floor((now - anchor) / 60_000));
  const elapsedSec = Math.max(0, Math.floor((now - anchor) / 1000) % 60);
  const elapsed = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
  const elapsedTitle = serverStartedAt ? 'time since the task started' : 'time since this live view opened';
  const traceHref = delegated.taskId ? `/tasks?select=${encodeURIComponent(delegated.taskId)}` : '/tasks';
  // A parked run is blocked on the USER — the elapsed clock keeps ticking, so
  // saying "working" is the one thing the card must never do here.
  const parked = Boolean(delegated.awaitingApproval);
  return (
    <article className="flex min-w-0 flex-col gap-2.5" aria-label="Clem, working in the background">
      <TurnHeader />
      <div className="min-w-0">
        <div className="rounded-lg border border-primary/30 bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={parked
                ? 'h-2 w-2 shrink-0 rounded-full bg-warning'
                : 'h-2 w-2 shrink-0 animate-breathe rounded-full bg-success'}
              aria-hidden
            />
            <span className="min-w-0 truncate text-small font-semibold text-fg">
              {parked ? 'Paused — waiting on your approval' : 'Working on this in the background'}
            </span>
            <span className="ml-auto shrink-0 text-caption tabular-nums text-faint" title={elapsedTitle}>{elapsed}</span>
          </div>
          {parked ? (
            <p className="mt-1.5 text-body text-muted">
              {delegated.awaitingApproval?.subject
                ? `Nothing is moving until you decide: ${delegated.awaitingApproval.subject}`
                : 'Nothing is moving until you approve or reject the pending action.'}
              {' '}
              <Link to="/inbox" className="font-medium text-primary transition-colors hover:text-primary/80">
                Review it
              </Link>
            </p>
          ) : message.progress ? (
            <p className="mt-1.5 text-body text-muted">{message.progress}</p>
          ) : null}
          {message.activity && message.activity.length > 0 && (
            <ActivityCard items={message.activity} live className="mt-2 border-0 shadow-none" />
          )}
          <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <span className="min-w-0 truncate text-caption text-faint">
              {parked
                ? 'Approve or reject to let it continue.'
                : 'Reply anytime to steer or adjust — the work picks up your change.'}
            </span>
            <Link
              to={traceHref}
              className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-primary transition-colors hover:text-primary/80"
            >
              Watch the full run
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
