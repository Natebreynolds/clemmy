import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Paperclip, Send, SendToBack, X } from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { TurnActivity } from '@/components/chat/TurnActivity';
import { useNowTick } from '@/components/chat/ActivityFeed';
import { TaskEvidenceFooter } from '@/components/chat/TaskEvidenceFooter';
import { cn } from '@/lib/cn';
import { linkify } from '@/lib/linkify';
import {
  approveExecutePendingAction,
  canOfferStandingSendTrust,
  getPendingActionStatus,
  reconcilePendingActionExecutionFailure,
  resolvePendingActionExecutionPresentation,
  type PendingActionExecutionPhase,
  type PendingActionExecutionPresentation,
} from '@/lib/pendingActions';
import type { ChatMessage } from '@/lib/useChat';
import { activityTerminalOutcomeForMessageStatus } from '@/lib/activity-presentation';

/** Inline spans within a line: **bold** and `code`; everything else is linkified
 *  plain text. No dangerouslySetInnerHTML — React escapes all text children. */
function renderInline(text: string, keyBase: string): ReactNode {
  const RE = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`${keyBase}-t${i}`}>{linkify(text.slice(last, m.index))}</Fragment>);
    if (m[1] != null) nodes.push(<strong key={`${keyBase}-b${i}`} className="font-semibold">{m[1]}</strong>);
    else if (m[2] != null) nodes.push(<code key={`${keyBase}-c${i}`} className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.9em]">{m[2]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyBase}-t${i}`}>{linkify(text.slice(last))}</Fragment>);
  return nodes;
}

/** Minimal, dependency-free markdown for assistant replies: ##/### headings,
 *  bold, inline code, fenced code blocks, and bullet/numbered lists. Plain
 *  paragraphs keep whitespace-pre-wrap. Unhandled text falls through linkified. */
function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;
  const flushPara = () => {
    if (para.length === 0) return;
    const body = para.join('\n');
    blocks.push(<p key={`p${key++}`} className="whitespace-pre-wrap">{renderInline(body, `p${key}`)}</p>);
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flushPara();
      const fence: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { fence.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence
      blocks.push(<pre key={`f${key++}`} className="overflow-x-auto rounded-md bg-subtle p-3 font-mono text-caption">{fence.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const cls = h[1].length === 2 ? 'text-h3 font-semibold' : 'text-body-lg font-semibold';
      blocks.push(<div key={`h${key++}`} className={cls}>{renderInline(h[2], `h${key}`)}</div>);
      i++;
      continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    const unordered = /^\s*[-*]\s+/.test(line);
    if (ordered || unordered) {
      flushPara();
      const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      const listKey = key++;
      while (i < lines.length && marker.test(lines[i])) { items.push(lines[i].replace(marker, '')); i++; }
      const lis = items.map((it, idx) => <li key={idx}>{renderInline(it, `li${listKey}-${idx}`)}</li>);
      blocks.push(ordered
        ? <ol key={`l${listKey}`} className="list-decimal space-y-0.5 pl-5">{lis}</ol>
        : <ul key={`l${listKey}`} className="list-disc space-y-0.5 pl-5">{lis}</ul>);
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return <div className="space-y-2">{blocks}</div>;
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

/**
 * WHO IS TALKING, without a bubble.
 *
 * The transcript used to say it with shape: the user's words in a tinted
 * lozenge with an asymmetric tail radius (`rounded-lg rounded-tr-sm`), the
 * reply in a bordered, shadowed card with the mirrored tail. That tail is THE
 * messenger signature — it is what made an operations console read as a chat
 * app, and the phone deleted exactly this in its own Wave 1. Speaker is a
 * label now, and the difference between a question and an answer is weight,
 * colour and the air around them.
 */
function Speaker({ children, mark = false }: { children: ReactNode; mark?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-caption font-semibold text-muted">
      {mark && <DogMark size={16} className="shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

/** One turn. Reading measure, generous rhythm, no box. */
function Turn({ children }: { children: ReactNode }) {
  return <article className="flex max-w-[70ch] flex-col gap-1.5">{children}</article>;
}

/** "Continue in background" — a real icon, not the ⇥ glyph it used to draw. */
function BackgroundButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Continue in background — keeps working, reports back here, frees the chat"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-caption text-muted',
        'transition-colors hover:border-border-strong hover:text-fg cursor-pointer',
        className,
      )}
    >
      <SendToBack className="h-3.5 w-3.5" aria-hidden />
      Background
    </button>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Clementine is working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary"
          style={{ animation: 'dot-pulse 1.2s ease-in-out infinite', animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatBubble({
  message,
  onApprove,
  onReject,
  onBackground,
  traceHref,
}: {
  message: ChatMessage;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  /** Detach THIS running turn to a durable background task (shown while thinking). */
  onBackground?: () => void;
  /** Deep link to this session's card/trace on the Tasks board. */
  traceHref?: string;
}) {
  const isUser = message.role === 'user';
  // Approve/Reject fire a follow-up turn but never patch THIS bubble's status, so
  // without a local latch the buttons stay live forever. Latch on first click.
  const [resolvedDecision, setResolvedDecision] = useState<'approve' | 'reject' | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const resolved = resolvedDecision !== null;
  // Execute-button truth (U3): a pending-action card's Execute fires the exact
  // stored call server-side and shows the DURABLE outcome — never a client-side
  // "Submitted" that outruns whether the send actually happened.
  const [exec, setExec] = useState<{ phase: 'idle' | PendingActionExecutionPhase; note?: string }>({ phase: 'idle' });
  // Grant-at-card (C, v2.3.0): opting in stores a NARROW standing send-trust
  // grant (exactly this card's recipients on this toolkit) so the next
  // identical send skips the card. trustNote reports the server's truth —
  // "stored" vs "couldn't scope it" — never an optimistic claim.
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [trustNote, setTrustNote] = useState<string | null>(null);
  const pendingActionId = message.approval?.pendingAction?.id;
  const showDurablePresentation = (presentation: PendingActionExecutionPresentation) => {
    if (presentation.mode !== 'durable') return false;
    const note = presentation.note?.trim();
    const defaultNote: Partial<Record<PendingActionExecutionPhase, string>> = {
      running: 'This exact queued action already has an execution claim. No second dispatch was attempted.',
      failed: 'The action failed or its final provider outcome needs review. Check the durable action before retrying.',
      rejected: 'You rejected this action. It was not dispatched.',
      expired: 'This approval expired. The action was not dispatched.',
      cancelled: 'This action was cancelled. It was not dispatched.',
      uncertain: 'The execution outcome is not confirmed. Check the durable action before continuing; do not retry it.',
    };
    setExec({
      phase: presentation.phase,
      note: (note || defaultNote[presentation.phase])?.slice(0, 240),
    });
    return true;
  };
  const runExecute = async () => {
    if (!pendingActionId) return;
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
      );
      if (!showDurablePresentation(presentation)) {
        // A genuinely queued/non-executable legacy card still belongs to the
        // conversational approval path. EXECUTING / EXECUTED / FAILED skips
        // are handled above from durable truth and can never reach this call.
        setExec({ phase: 'idle' });
        onApprove();
      }
    } catch {
      // A lost POST response cannot prove the provider did not act. Reconcile
      // the record; bounded failure becomes explicit do-not-retry uncertainty.
      const presentation = await reconcilePendingActionExecutionFailure(
        () => getPendingActionStatus(pendingActionId),
      );
      showDurablePresentation(presentation);
    }
  };
  const resolvePlainDecision = async (decision: 'approve' | 'reject') => {
    if (resolved || decisionBusy) return;
    setDecisionBusy(decision);
    setDecisionError(null);
    try {
      await Promise.resolve(decision === 'approve' ? onApprove() : onReject());
      setResolvedDecision(decision);
    } catch (error) {
      setDecisionError(error instanceof Error && error.message.trim()
        ? error.message.trim()
        : `Could not ${decision} this ${message.status === 'awaiting-plan' ? 'plan' : 'request'}.`);
    } finally {
      setDecisionBusy(null);
    }
  };

  if (isUser) {
    // What you asked is context for the answer below it, so it is quieter than
    // the answer — muted ink at full reading size, never a tinted lozenge.
    return (
      <Turn>
        <Speaker>You</Speaker>
        <p className="whitespace-pre-wrap text-body-lg leading-relaxed text-muted">{message.text}</p>
        {message.attachmentNames && message.attachmentNames.length > 0 && (
          <p className="flex items-center gap-1.5 text-caption text-faint">
            <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{message.attachmentNames.join(', ')}</span>
          </p>
        )}
        {message.steer && (
          <p className="flex items-center gap-1.5 text-caption text-faint">
            {message.steer === 'delivered' && <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />}
            {message.steer === 'pending' && 'Reaching her mid-run…'}
            {message.steer === 'delivered' && 'Reaches her at the next step — the run keeps going'}
            {message.steer === 'failed' && 'The run just ended before this landed — send it again'}
          </p>
        )}
      </Turn>
    );
  }

  if (message.delegated) {
    return <DelegatedWorkCard message={message} delegated={message.delegated} />;
  }

  // A check-in is Clem talking WHILE she works — not the answer. It reads as a
  // quieter aside so a returning reader can scan what happened without
  // mistaking any of it for the result they were waiting on.
  if (message.checkIn) {
    // A hairline rule, not a dashed box: an aside in a document, which is
    // exactly what a check-in is.
    return (
      <Turn>
        <Speaker mark>Clementine</Speaker>
        <div className="border-l-2 border-border pl-3">
          <p className="whitespace-pre-wrap text-body-lg leading-relaxed text-muted">
            {linkify(message.text)}
          </p>
        </div>
      </Turn>
    );
  }

  const thinking = message.status === 'thinking';
  const live = thinking || Boolean(message.workflowLive);
  const pendingAction = message.approval?.pendingAction;
  return (
    <Turn>
      <Speaker mark>Clementine</Speaker>
      {/* The reply is the page: full width to the reading measure, unboxed,
          the darkest and largest text in the turn. Everything under it — what
          she did, what needs a decision, the ledger row — is quieter than it. */}
      <div className="flex flex-col gap-1.5">
        {thinking && !message.text ? (
          <div className="flex items-center gap-2 text-body-lg text-muted">
            <ThinkingDots />
            <span className="min-w-0 flex-1">{message.progress ?? 'Thinking…'}</span>
            {onBackground && <BackgroundButton onClick={onBackground} />}
          </div>
        ) : thinking && message.text ? (
          // Mid-stream: render plain (linkified) text + a live caret. Full
          // markdown formatting is applied once the reply lands (below).
          // The background control stays available HERE too — brains that
          // stream text immediately (Claude) skip the pre-text state, which
          // made the bubble button vanish for them (live 2026-07-08).
          <div>
            <p className="whitespace-pre-wrap text-body-lg leading-relaxed text-fg">
              {linkify(message.text)}
              <span
                aria-hidden
                className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] rounded-full bg-primary"
                style={{ animation: 'dot-pulse 1.2s ease-in-out infinite' }}
              />
            </p>
            {onBackground && (
              <div className="mt-1.5 flex justify-end">
                <BackgroundButton onClick={onBackground} />
              </div>
            )}
          </div>
        ) : (
          <div className={cn('text-body-lg leading-relaxed', message.status === 'failed' ? 'text-danger' : 'text-fg')}>
            <Markdown text={message.text} />
          </div>
        )}

        {/* Premium activity strip: live tool calls + parallel agents (Claude/Codex/
            GLM) with status — shown while working AND kept (collapsed) after. Falls
            back to the single rolling line only before any activity has arrived. */}
        {message.activity && message.activity.length > 0 ? (
          <TurnActivity
            items={message.activity}
            live={live}
            terminalOutcome={live ? undefined : activityTerminalOutcomeForMessageStatus(message.status)}
            traceHref={traceHref}
          />
        ) : (
          live && message.text && message.progress && (
            <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2 text-caption text-faint">
              <ThinkingDots />
              <span>{message.progress}</span>
            </div>
          )
        )}

        {(message.status === 'awaiting-approval' || message.status === 'awaiting-plan') && (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning-tint p-3">
            <p className="text-small font-semibold text-fg">
              {message.status === 'awaiting-plan'
                ? 'Approve this plan to continue?'
                : pendingAction
                  ? `Ready to execute: ${pendingAction.title}`
                  : `Approve: ${message.approval?.subject ?? 'this action'}`}
            </p>
            {pendingAction && (
              <div className="mt-1 space-y-0.5 text-caption text-muted">
                <div>Tool: <span className="font-mono">{pendingAction.toolName}</span></div>
                {pendingAction.targetSummary && <div>Target: {pendingAction.targetSummary}</div>}
                {pendingAction.preview && <div className="whitespace-pre-wrap">Preview: {pendingAction.preview}</div>}
                {pendingAction.risk && <div className="whitespace-pre-wrap text-warning">Risk: {pendingAction.risk}</div>}
                {pendingAction.rollback && <div className="whitespace-pre-wrap">Rollback: {pendingAction.rollback}</div>}
                {pendingAction.payloadHash && <div>Payload hash: <span className="font-mono">{pendingAction.payloadHash}</span></div>}
              </div>
            )}
            {message.approval?.reason && <p className="mt-0.5 text-caption text-muted">{message.approval.reason}</p>}
            {pendingAction && <PayloadPreview value={pendingAction.payload} />}
            {canOfferStandingSendTrust(pendingAction) && !resolved && (
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-caption text-muted">
                <input
                  type="checkbox"
                  checked={alwaysAllow}
                  onChange={(e) => setAlwaysAllow(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                Always allow sends like this (same recipients — revocable in Settings)
              </label>
            )}
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                disabled={resolved || decisionBusy !== null || exec.phase === 'running'}
                onClick={pendingAction ? runExecute : () => { void resolvePlainDecision('approve'); }}
              >
                {pendingAction ? <Send className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                {pendingAction ? 'Execute queued action' : 'Approve'}
              </Button>
              <Button size="sm" variant="secondary" disabled={resolved || decisionBusy !== null} onClick={() => { void resolvePlainDecision('reject'); }}><X className="h-4 w-4" aria-hidden /> Not now</Button>
              {/* Truth, not a latch: for a pending-action card the label reflects
                  the durable executor outcome; the plain approve/plan path keeps
                  the "Submitted" acknowledgement (its follow-up turn carries the
                  real result). */}
              {pendingAction ? (
                <span role="status" aria-live="polite" aria-atomic="true">
                  {exec.phase === 'running' ? <span className="text-caption text-muted">Executing…</span>
                    : exec.phase === 'executed' ? <span className="inline-flex items-center gap-1 text-caption font-semibold text-success"><Check className="h-3.5 w-3.5" aria-hidden />Executed</span>
                      : exec.phase === 'failed' ? <span className="text-caption font-semibold text-danger">Failed / needs review</span>
                        : exec.phase === 'rejected' ? <span className="text-caption font-semibold text-muted">Rejected — not dispatched</span>
                          : exec.phase === 'expired' ? <span className="text-caption font-semibold text-muted">Expired — not dispatched</span>
                            : exec.phase === 'cancelled' ? <span className="text-caption font-semibold text-muted">Cancelled — not dispatched</span>
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
            {decisionError && <p role="alert" className="mt-1.5 text-caption text-danger">{decisionError}</p>}
            {pendingAction && exec.note && exec.phase !== 'idle' && (
              <p
                className={cn('mt-1.5 whitespace-pre-wrap text-caption', exec.phase === 'failed' ? 'text-danger' : 'text-muted')}
              >
                {exec.note}
              </p>
            )}
            {trustNote && <p className="mt-1 text-caption text-muted">{trustNote}</p>}
          </div>
        )}

        {/* Durable evidence beneath a report-back: the harness's ledger row
            (status, counts, verified artifacts, receipts, exact next action)
            so completion never rests on the prose above it. */}
        {message.taskRef && (message.status === 'complete' || message.status === 'awaiting-reply') && (
          <TaskEvidenceFooter taskRef={message.taskRef} />
        )}
      </div>

      {(message.status === 'awaiting-reply' || message.status === 'stopped' || message.status === 'failed') && (
        <div className="mt-0.5">
          {message.status === 'awaiting-reply' && <StatusPill tone="info">Reply below to continue</StatusPill>}
          {message.status === 'stopped' && <StatusPill tone="neutral">Stopped</StatusPill>}
          {message.status === 'failed' && <StatusPill tone="danger">Didn't finish</StatusPill>}
        </div>
      )}
    </Turn>
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
    <Turn>
      <Speaker mark>Clementine</Speaker>
      {/* This one keeps a surface: it is a live status object, not prose. But
          it is a hairline on a lighter surface — no tail radius, no shadow. */}
      <div className="rounded-md border border-border bg-surface px-4 py-3">
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
            <Link to="/inbox" className="font-medium text-primary transition-colors hover:text-primary-hover">
              Review it
            </Link>
          </p>
        ) : message.progress ? (
          <p className="mt-1.5 text-body text-muted">{message.progress}</p>
        ) : null}
        {message.activity && message.activity.length > 0 && (
          <TurnActivity items={message.activity} live />
        )}
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <span className="min-w-0 truncate text-caption text-faint">
            {parked
              ? 'Approve or reject to let it continue.'
              : 'Reply anytime to steer or adjust — the work picks up your change.'}
          </span>
          <Link
            to={traceHref}
            className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-primary transition-colors hover:text-primary-hover"
          >
            Watch the full run
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
      </div>
      </div>
    </Turn>
  );
}
