/**
 * What is waiting on the owner in this project: a task's question, or an
 * approval one of its conversations or tasks asked for. One row each, with
 * what answering does and where it came from. A question is answered here;
 * an approval is decided through the same call Needs you uses, with the
 * content it would act on shown first. Something that was asked in the
 * conversation's own words is answered in that conversation, and is never
 * approved or declined from a card.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, MessageSquare, X } from 'lucide-react';
import {
  projectDecisionConsequence, projectDecisionIsFormal, projectDecisionOptions, projectDecisionSource,
} from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { approvalDecisionSuccessText, decideApproval, listApprovals, relativeTime, type ApprovalRow } from '@/lib/inbox';
import { usePoll } from '@/lib/poll';
import {
  answerTask, conversationPath, refusalText, taskRunPath,
  type ProjectDecisionView, type ProjectOverview,
} from '@/lib/projects';
import { ProjectSection, QuietNote } from './ProjectSection';

const DRAFT_FOLD = 420;

function Source({ decision }: { decision: ProjectDecisionView }) {
  const asked = relativeTime(decision.askedAt);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
      <span>Asked {asked === 'now' ? 'just now' : asked ? `${asked} ago` : 'recently'}</span>
      {decision.taskId && (
        <Link to={taskRunPath(decision.taskId)} className="font-semibold text-primary hover:underline">Open the task</Link>
      )}
      <Link to={conversationPath(decision.sessionId)} className="font-semibold text-primary hover:underline">
        {decision.taskId ? 'Open the conversation it came from' : 'Open the conversation'}
      </Link>
    </p>
  );
}

function QuestionRow({ decision, onDecided }: {
  decision: ProjectDecisionView;
  onDecided: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = projectDecisionOptions(decision);

  const send = async (text: string) => {
    const value = text.trim();
    if (!value || busy || !decision.taskId) return;
    setBusy(true);
    setError('');
    try {
      await answerTask(decision.taskId, value);
      setAnswer('');
    } catch (failure) {
      setError(refusalText(failure, 'Your answer did not go through. Try again.'));
    } finally {
      setBusy(false);
      // Answered or refused, the record moved or was never what this row
      // showed: read it again either way.
      onDecided();
    }
  };

  return (
    <li className="rounded-lg border border-warning/50 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill tone="warning">Question</StatusPill>
        <span className="min-w-0 truncate text-small font-semibold text-muted">{projectDecisionSource(decision)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-body-lg text-fg">{decision.detail}</p>
      <p className="mt-1 text-small text-muted">{projectDecisionConsequence(decision)}</p>
      {decision.taskId ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void send(answer); }}>
          {options.length > 0 && (
            <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-1.5">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  onClick={() => { void send(option); }}
                  className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-left text-small font-semibold text-fg transition-colors duration-fast hover:border-primary hover:bg-primary-tint active:scale-press disabled:opacity-50 motion-reduce:active:scale-100 cursor-pointer"
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              disabled={busy}
              aria-label={`Your answer to ${decision.owner || 'Clem'}`}
              placeholder={options.length > 0 ? 'Or type your answer…' : 'Type your answer…'}
              className="h-10 min-w-48 flex-1"
            />
            <Button type="submit" size="sm" className="h-10" disabled={busy || !answer.trim()}>{busy ? 'Sending…' : 'Answer'}</Button>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-small text-muted">Answer it in the conversation it came from.</p>
      )}
      {error && <p role="alert" className="mt-2 text-caption text-danger">{error}</p>}
      <Source decision={decision} />
    </li>
  );
}

function ApprovalRowCard({ decision, approval, loading, onDecided }: {
  decision: ProjectDecisionView;
  approval?: ApprovalRow;
  loading: boolean;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);

  const decide = async (choice: 'approve' | 'reject') => {
    if (busy || !approval) return;
    setBusy(choice);
    setNotice(null);
    try {
      const response = await decideApproval(approval.approvalId, choice, { kind: approval.kind });
      setNotice({ tone: 'success', text: approvalDecisionSuccessText(approval, choice, response) });
    } catch (failure) {
      setNotice({ tone: 'error', text: refusalText(failure, 'Your decision did not go through. Try again.') });
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  const draft = approval?.contentPreview?.body?.trim() ?? '';
  const draftIsLong = draft.length > DRAFT_FOLD;
  const details = approval?.presentation?.details ?? [];
  const inboxHref = decision.approvalId ? `/inbox?tab=needs&select=${encodeURIComponent(decision.approvalId)}` : '/inbox';

  return (
    <li className="rounded-lg border border-warning/50 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill tone="warning">Approval</StatusPill>
        <span className="min-w-0 truncate text-small font-semibold text-muted">{projectDecisionSource(decision)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-body-lg text-fg">
        {approval?.pendingAction?.title || approval?.presentation?.action || decision.detail}
      </p>
      <p className="mt-1 text-small text-muted">{projectDecisionConsequence(decision)}</p>

      {loading && !approval ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : approval ? (
        <>
          {/* What approving would act on, before the owner approves it. */}
          {draft && (
            <div className="mt-3 rounded-md border border-border bg-subtle px-3 py-2" aria-label="What you are approving">
              <p className="text-label text-faint">Draft</p>
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-small text-fg">
                {draftIsLong && !draftOpen ? `${draft.slice(0, DRAFT_FOLD - 1)}…` : draft}
              </pre>
              {draftIsLong && (
                <button type="button" className="mt-1 text-caption font-semibold text-primary hover:underline cursor-pointer" aria-expanded={draftOpen} onClick={() => setDraftOpen((open) => !open)}>
                  {draftOpen ? 'Show less' : 'Show the whole draft'}
                </button>
              )}
            </div>
          )}
          {!draft && details.length > 0 && (
            <dl className="mt-3 space-y-1.5 rounded-md border border-border bg-subtle px-3 py-2 text-small">
              {approval.presentation?.app && (<div><dt className="text-caption text-faint">App</dt><dd className="text-fg">{approval.presentation.app}</dd></div>)}
              {details.map((line) => (
                <div key={line.label}>
                  <dt className="text-caption text-faint">{line.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-fg">{line.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => { void decide('approve'); }}>
              <Check className="h-4 w-4" aria-hidden /> {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void decide('reject'); }}>
              <X className="h-4 w-4" aria-hidden /> {busy === 'reject' ? 'Declining…' : 'Decline'}
            </Button>
            <Link to={inboxHref} className="ml-1 text-caption font-semibold text-primary hover:underline">See everything about it in Needs you</Link>
          </div>
        </>
      ) : (
        // The approval is not in the list this screen can read its content
        // from, so it is not decided blind from here.
        <p className="mt-3 text-small text-muted">
          <Link to={inboxHref} className="font-semibold text-primary hover:underline">Review it in Needs you</Link>, where what it would do is shown in full.
        </p>
      )}
      {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'mt-2 text-caption text-danger' : 'mt-2 text-caption text-success'}>{notice.text}</p>}
      <Source decision={decision} />
    </li>
  );
}

/** Asked in the conversation's own words: read here, answered there. */
function AskedInConversation({ decision }: { decision: ProjectDecisionView }) {
  return (
    <li className="rounded-lg border border-warning/50 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill tone="warning">Asked you</StatusPill>
        <span className="min-w-0 truncate text-small font-semibold text-muted">{projectDecisionSource(decision)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-body-lg text-fg">{decision.detail}</p>
      <p className="mt-1 text-small text-muted">{projectDecisionConsequence(decision)}</p>
      <div className="mt-3">
        <Link
          to={conversationPath(decision.sessionId)}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-small font-semibold text-fg transition-colors hover:border-border-strong hover:bg-hover"
        >
          <MessageSquare className="h-4 w-4" aria-hidden /> Reply in the conversation
        </Link>
      </div>
      <Source decision={decision} />
    </li>
  );
}

export function ProjectDecisions({ overview, onDecided }: {
  overview: ProjectOverview;
  /** Read the project again: something was answered or decided. */
  onDecided: () => void;
}) {
  const qc = useQueryClient();
  const decisions = overview.decisions;
  const hasApproval = decisions.some((decision) => decision.kind === 'approval' && projectDecisionIsFormal(decision));
  // The same list Needs you reads, so a decision made in either place is
  // seen by both.
  const approvals = usePoll(['approvals'], listApprovals, 6000, { enabled: hasApproval });
  const decided = () => {
    onDecided();
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['command-center'] });
  };

  return (
    <ProjectSection title="Needs you" count={decisions.length} attention>
      {decisions.length === 0 ? (
        <QuietNote>Nothing in this project is waiting on you.</QuietNote>
      ) : (
        <ul className="space-y-3">
          {decisions.map((decision) => (!projectDecisionIsFormal(decision) ? (
            <AskedInConversation key={`c-${decision.sessionId}-${decision.askedAt}`} decision={decision} />
          ) : decision.kind === 'question' ? (
            <QuestionRow
              key={`q-${decision.questionId ?? decision.taskId ?? decision.askedAt}`}
              decision={decision}
              onDecided={decided}
            />
          ) : (
            <ApprovalRowCard
              key={`a-${decision.approvalId ?? decision.askedAt}`}
              decision={decision}
              approval={approvals.data?.approvals.find((row) => row.approvalId === decision.approvalId)}
              loading={approvals.isLoading}
              onDecided={decided}
            />
          )))}
        </ul>
      )}
    </ProjectSection>
  );
}
