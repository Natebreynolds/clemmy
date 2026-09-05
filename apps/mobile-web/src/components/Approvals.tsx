/**
 * Reusable response cards for the durable Needs-you inbox.
 */
import { useRef, useState } from 'preact/hooks';
import {
  approveApproval,
  approvePlanProposal,
  rejectApproval,
  rejectPlanProposal,
  resolveWorkspaceDestinationChooser,
  type ApprovalRow,
  type PlanProposalRow,
  type WorkspaceDestinationChooser,
} from '../lib/api';
import { haptic } from '../lib/native-bridge';
import { approvalDetails, approvalKindLabel, approvalQuestion } from '../lib/inbox-presentation';

export function relativeTime(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function approvalExpiryLabel(iso: string): string {
  const expires = Date.parse(iso);
  if (!Number.isFinite(expires)) return '';
  const remaining = expires - Date.now();
  if (remaining <= 0) return 'Expired';
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  if (minutes < 60) return `Respond in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `Respond in ${hours}h`;
  return `Expires ${new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

interface DecisionsProps {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  workspaceChoosers: WorkspaceDestinationChooser[];
  onResolved: (message: string) => void;
  onReply?: (sessionId: string, draft: string) => void;
}

export function Decisions({ approvals, plans, workspaceChoosers, onResolved, onReply }: DecisionsProps) {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionLock = useRef(false);

  async function run(
    id: string,
    work: () => Promise<unknown>,
    successMessage: string,
    conflictMessage: string,
  ) {
    if (actionLock.current) return;
    actionLock.current = true;
    setActing(id);
    setError(null);
    haptic('medium');
    try {
      await work();
      haptic('success');
      onResolved(successMessage);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        haptic('light');
        onResolved(conflictMessage);
        return;
      }
      haptic('error');
      setError((err as Error).message ?? 'That did not go through');
    } finally {
      actionLock.current = false;
      setActing(null);
    }
  }

  if (approvals.length === 0 && plans.length === 0 && workspaceChoosers.length === 0) return null;

  return (
    <section class="stack">
      {error ? <div class="global-error">{error}</div> : null}
      {workspaceChoosers.map((chooser, i) => (
        <WorkspaceChooserCard
          key={chooser.chooserId}
          chooser={chooser}
          index={i}
          acting={acting === chooser.chooserId}
          disabled={acting !== null}
          onChoose={(choiceId) => run(
            chooser.chooserId,
            () => resolveWorkspaceDestinationChooser(chooser, choiceId),
            'Workspace selected. Clem can continue with that destination.',
            'That workspace choice could not be applied to the current request. I refreshed its status.',
          )}
        />
      ))}
      {plans.map((row, i) => (
        <PlanCard
          key={row.id}
          row={row}
          index={workspaceChoosers.length + i}
          acting={acting === row.id}
          disabled={acting !== null}
          onReply={onReply}
          onAct={(action) => run(
            row.id,
            () => action === 'approve' ? approvePlanProposal(row.id) : rejectPlanProposal(row.id),
            action === 'approve'
              ? 'Plan approved and queued. Clem will continue it in the original conversation.'
              : 'Plan rejected. Clem will not start it.',
            action === 'approve'
              ? 'The plan could not be started from this card. I refreshed its current status.'
              : 'The plan could not be rejected from this card. I refreshed its current status.',
          )}
        />
      ))}
      {approvals.map((row, i) => (
        <ApprovalCard
          key={row.approvalId}
          row={row}
          index={workspaceChoosers.length + plans.length + i}
          acting={acting === row.approvalId}
          disabled={acting !== null}
          onReply={onReply}
          onAct={(action) => run(
            row.approvalId,
            () => action === 'approve' ? approveApproval(row.approvalId) : rejectApproval(row.approvalId),
            action === 'approve'
              ? 'Approval recorded. Clem can continue when the exact task is ready.'
              : 'Rejected. Clem will not perform that action.',
            action === 'approve'
              ? 'The approval could not be applied from this card. I refreshed its current status.'
              : 'The rejection could not be applied from this card. I refreshed its current status.',
          )}
        />
      ))}
    </section>
  );
}

function WorkspaceChooserCard({ chooser, index, acting, disabled, onChoose }: {
  chooser: WorkspaceDestinationChooser;
  index: number;
  acting: boolean;
  disabled: boolean;
  onChoose: (choiceId: string) => void;
}) {
  return (
    <article class="card card-approval rise" style={{ '--i': index }}>
      <header class="card-head">
        <span class="chip chip-kind">Workspace · needs a choice</span>
        <span class="card-when">{relativeTime(chooser.createdAt)}</span>
      </header>
      <h2 class="card-title">I need your help choosing where these records should live.</h2>
      <p class="card-note">
        Pick an existing Workspace, or ask me to prepare a new one.
      </p>
      <footer class="card-actions workspace-choice-actions">
        {chooser.choices.map((choice) => (
          <button
            type="button"
            key={choice.choiceId}
            class={choice.kind === 'existing' ? 'btn-approve' : 'btn-reject'}
            disabled={disabled}
            onClick={() => onChoose(choice.choiceId)}
          >
            {acting
              ? 'Working…'
              : choice.kind === 'existing' ? `${choice.label} (${choice.workspaceId})` : choice.label}
          </button>
        ))}
      </footer>
    </article>
  );
}

type Act = (action: 'approve' | 'reject') => void;

function PlanCard({ row, index, acting, disabled, onAct, onReply }: {
  row: PlanProposalRow;
  index: number;
  acting: boolean;
  disabled: boolean;
  onAct: Act;
  onReply?: DecisionsProps['onReply'];
}) {
  const needsInput = row.needsUserInput.length > 0;
  const [open, setOpen] = useState(false);
  const steps = open ? row.steps : row.steps.slice(0, 3);
  return (
    <article id={`inbox-plan:${row.id}`} class="card card-plan rise" style={{ '--i': index }} tabIndex={-1}>
      <header class="card-head">
        <span class="chip chip-kind">Plan · ready to start</span>
        <span class="card-when">{relativeTime(row.proposedAt)}</span>
      </header>
      <h2 class="card-title">I made a plan for “{row.objective}.”</h2>
      {row.context ? <p class="card-note">{row.context}</p> : null}
      <ol class="plan-steps">
        {steps.map((step) => <li key={step.n}>{step.action}</li>)}
      </ol>
      {row.steps.length > 3 ? (
        <button type="button" class="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `+${row.steps.length - 3} more steps`}
        </button>
      ) : null}
      <footer class="card-actions">
        {needsInput ? (
          <p class="card-note">I still need: {row.needsUserInput.join(' ')}</p>
        ) : (
          <button
            type="button"
            class="btn-approve"
            aria-label={`Start plan: ${row.objective}`}
            disabled={disabled}
            onClick={() => onAct('approve')}
          >
            {acting ? 'Starting…' : 'Start this plan'}
          </button>
        )}
        <button
          type="button"
          class="btn-reject"
          aria-label={`Reject plan: ${row.objective}`}
          disabled={disabled}
          onClick={() => onAct('reject')}
        >
          Reject plan
        </button>
        {needsInput && onReply && row.sessionId ? (
          <button
            class="btn-reply"
            type="button"
            aria-label={`Answer Clem about plan: ${row.objective}`}
            disabled={disabled}
            onClick={() => onReply(row.sessionId!, `About the plan “${row.objective}”: `)}
          >
            Answer Clem
          </button>
        ) : null}
        {needsInput && !row.sessionId ? (
          <p class="card-note">This plan has no safe linked conversation on the phone yet.</p>
        ) : null}
      </footer>
    </article>
  );
}

function ApprovalCard({ row, index, acting, disabled, onAct, onReply }: {
  row: ApprovalRow;
  index: number;
  acting: boolean;
  disabled: boolean;
  onAct: Act;
  onReply?: DecisionsProps['onReply'];
}) {
  const [open, setOpen] = useState(false);
  const details = approvalDetails(row);
  return (
    <article id={`inbox-approval:${row.approvalId}`} class="card card-approval rise" style={{ '--i': index }} tabIndex={-1}>
      <header class="card-head">
        <span class="chip chip-kind">Approval · {approvalKindLabel(row.tool)}</span>
        <span class="card-when">
          {relativeTime(row.requestedAt)} ·{' '}
          <time class="card-expiry" dateTime={row.expiresAt} title={new Date(row.expiresAt).toLocaleString()}>
            {approvalExpiryLabel(row.expiresAt)}
          </time>
        </span>
      </header>
      <h2 class="card-title">{approvalQuestion(row.subject)}</h2>
      {row.resourceFingerprint?.warning ? (
        <p class="card-warn">{row.resourceFingerprint.warning}</p>
      ) : null}
      {details.length > 0 ? (
        <>
          <button
            type="button"
            class="link-btn"
            aria-expanded={open}
            aria-controls={`approval-details-${row.approvalId}`}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide details' : 'Review details'}
          </button>
          {open ? (
            <dl id={`approval-details-${row.approvalId}`} class="approval-details">
              {details.map((detail) => (
                <div key={detail.label} class={detail.long ? 'approval-detail-long' : ''}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : null}
      <p class="approval-response-hint">Approve it, reject it, or tell me what you want changed.</p>
      <footer class="card-actions">
        <button
          type="button"
          class="btn-approve"
          aria-label={`Approve ${approvalKindLabel(row.tool)}: ${row.subject}`}
          disabled={disabled}
          onClick={() => onAct('approve')}
        >
          {acting ? 'Continuing…' : 'Yes, do it'}
        </button>
        <button
          type="button"
          class="btn-reject"
          aria-label={`Reject ${approvalKindLabel(row.tool)}: ${row.subject}`}
          disabled={disabled}
          onClick={() => onAct('reject')}
        >
          Don’t do this
        </button>
        {onReply ? (
          <button
            class="btn-reply"
            type="button"
            aria-label={`Tell Clem about: ${row.subject}`}
            disabled={disabled}
            onClick={() => onReply(row.sessionId, `About “${row.subject}”: `)}
          >
            Tell Clem
          </button>
        ) : null}
      </footer>
    </article>
  );
}
