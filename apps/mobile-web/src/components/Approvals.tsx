/**
 * The decisions Clem is waiting on. These live on Home rather than behind a
 * tab of their own: an approval IS the thing that needs you now, so it
 * belongs on the first screen, not one navigation away.
 */
import { useState } from 'preact/hooks';
import {
  approveApproval,
  approvePlanProposal,
  rejectApproval,
  rejectPlanProposal,
  type ApprovalRow,
  type PlanProposalRow,
} from '../lib/api';
import { haptic } from '../lib/native-bridge';

export function relativeTime(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

interface DecisionsProps {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  onResolved: () => void;
}

export function Decisions({ approvals, plans, onResolved }: DecisionsProps) {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, work: () => Promise<unknown>) {
    if (acting) return;
    setActing(id);
    setError(null);
    haptic('medium');
    try {
      await work();
      haptic('success');
      onResolved();
    } catch (err) {
      haptic('error');
      setError((err as Error).message ?? 'That did not go through');
    } finally {
      setActing(null);
    }
  }

  if (approvals.length === 0 && plans.length === 0) return null;

  return (
    <section class="stack">
      {error ? <div class="global-error">{error}</div> : null}
      {plans.map((row, i) => (
        <PlanCard
          key={row.id}
          row={row}
          index={i}
          acting={acting === row.id}
          onAct={(action) => run(row.id, () => action === 'approve' ? approvePlanProposal(row.id) : rejectPlanProposal(row.id))}
        />
      ))}
      {approvals.map((row, i) => (
        <ApprovalCard
          key={row.approvalId}
          row={row}
          index={plans.length + i}
          acting={acting === row.approvalId}
          onAct={(action) => run(row.approvalId, () => action === 'approve' ? approveApproval(row.approvalId) : rejectApproval(row.approvalId))}
        />
      ))}
    </section>
  );
}

type Act = (action: 'approve' | 'reject') => void;

function PlanCard({ row, index, acting, onAct }: { row: PlanProposalRow; index: number; acting: boolean; onAct: Act }) {
  const needsInput = row.needsUserInput.length > 0;
  const [open, setOpen] = useState(false);
  const steps = open ? row.steps : row.steps.slice(0, 3);
  return (
    <article class="card card-plan rise" style={{ '--i': index }}>
      <header class="card-head">
        <span class="chip chip-plan">Plan</span>
        <span class="card-when">{relativeTime(row.proposedAt)}</span>
      </header>
      <h3 class="card-title">{row.objective}</h3>
      {row.context ? <p class="card-note">{row.context}</p> : null}
      <ol class="plan-steps">
        {steps.map((step) => <li key={step.n}>{step.action}</li>)}
      </ol>
      {row.steps.length > 3 ? (
        <button class="link-btn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `+${row.steps.length - 3} more steps`}
        </button>
      ) : null}
      <footer class="card-actions">
        {needsInput ? (
          <p class="card-note">Answer Clem's question in chat before this can run.</p>
        ) : (
          <button class="btn-approve" disabled={acting} onClick={() => onAct('approve')}>
            {acting ? 'Working…' : 'Approve'}
          </button>
        )}
        <button class="btn-reject" disabled={acting} onClick={() => onAct('reject')}>
          {needsInput ? 'Dismiss' : 'No'}
        </button>
      </footer>
    </article>
  );
}

function ApprovalCard({ row, index, acting, onAct }: { row: ApprovalRow; index: number; acting: boolean; onAct: Act }) {
  const [open, setOpen] = useState(false);
  const argsText = row.args !== null && row.args !== undefined
    ? typeof row.args === 'string' ? row.args : JSON.stringify(row.args, null, 2)
    : null;
  return (
    <article class="card card-approval rise" style={{ '--i': index }}>
      <header class="card-head">
        <span class="chip chip-tool">{row.tool ?? 'approval'}</span>
        <span class="card-when">{relativeTime(row.requestedAt)}</span>
      </header>
      <h3 class="card-title">{row.subject}</h3>
      {row.resourceFingerprint?.warning ? (
        <p class="card-warn">{row.resourceFingerprint.warning}</p>
      ) : null}
      {argsText ? (
        <>
          <button class="link-btn" onClick={() => setOpen(!open)}>
            {open ? 'Hide details' : 'What exactly?'}
          </button>
          {open ? <pre class="card-args">{argsText}</pre> : null}
        </>
      ) : null}
      <footer class="card-actions">
        <button class="btn-approve" disabled={acting} onClick={() => onAct('approve')}>
          {acting ? 'Working…' : 'Approve'}
        </button>
        <button class="btn-reject" disabled={acting} onClick={() => onAct('reject')}>No</button>
      </footer>
    </article>
  );
}
