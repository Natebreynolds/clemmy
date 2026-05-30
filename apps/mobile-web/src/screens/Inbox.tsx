import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  approveApproval,
  approvePlanProposal,
  listApprovals,
  listPlanProposals,
  rejectApproval,
  rejectPlanProposal,
  type ApprovalRow,
  type PlanProposalRow,
} from '../lib/api';

const POLL_INTERVAL_MS = 5000;

export function Inbox() {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [plans, setPlans] = useState<PlanProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [approvalResult, planResult] = await Promise.all([
        listApprovals(),
        listPlanProposals(),
      ]);
      // Only show pending ones — resolved appear in a future history view.
      setApprovals(approvalResult.approvals.filter((row) => row.status === 'pending'));
      setPlans(planResult.proposals.filter((row) => row.status === 'pending'));
      setError(null);
    } catch (err) {
      const message = (err as Error).message ?? 'Failed to load approvals';
      // Don't clobber the list on transient errors; just surface the toast.
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  async function act(id: string, action: 'approve' | 'reject') {
    if (acting) return;
    setActing(id);
    setError(null);
    try {
      if (action === 'approve') await approveApproval(id);
      else await rejectApproval(id);
      // Optimistically remove; refresh syncs the source of truth.
      setApprovals((rows) => rows.filter((row) => row.approvalId !== id));
      refresh();
    } catch (err) {
      setError((err as Error).message ?? `Failed to ${action}`);
    } finally {
      setActing(null);
    }
  }

  async function actOnPlan(id: string, action: 'approve' | 'reject') {
    if (acting) return;
    setActing(id);
    setError(null);
    try {
      if (action === 'approve') await approvePlanProposal(id);
      else await rejectPlanProposal(id);
      setPlans((rows) => rows.filter((row) => row.id !== id));
      refresh();
    } catch (err) {
      setError((err as Error).message ?? `Failed to ${action} plan`);
    } finally {
      setActing(null);
    }
  }

  if (loading && approvals.length === 0 && plans.length === 0) {
    return <div class="inbox-empty">Loading…</div>;
  }

  if (approvals.length === 0 && plans.length === 0) {
    return (
      <div class="inbox-empty">
        Nothing pending.<br />
        Clem will push here when she needs a yes/no.
      </div>
    );
  }

  return (
    <div>
      {error ? <div class="global-error">{error}</div> : null}
      {plans.map((row) => (
        <PlanCard
          key={row.id}
          row={row}
          acting={acting === row.id}
          onAct={actOnPlan}
        />
      ))}
      {approvals.map((row) => <ApprovalCard key={row.approvalId} row={row} acting={acting === row.approvalId} onAct={act} />)}
    </div>
  );
}

interface PlanCardProps {
  row: PlanProposalRow;
  acting: boolean;
  onAct: (id: string, action: 'approve' | 'reject') => void;
}

function PlanCard({ row, acting, onAct }: PlanCardProps) {
  const needsInput = row.needsUserInput.length > 0;
  return (
    <div class="approval-card plan-card">
      <div class="head">
        <div class="tool">plan</div>
        <div class="when">{relativeTime(row.proposedAt)}</div>
      </div>
      <div class="subject">{row.objective}</div>
      {row.context ? <div class="warning">{row.context}</div> : null}
      {row.appliedInstructions.length > 0 ? (
        <div class="plan-section">
          <div class="plan-section-title">Instructions</div>
          <ul>
            {row.appliedInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
          </ul>
        </div>
      ) : null}
      <div class="plan-section">
        <div class="plan-section-title">Steps</div>
        <ol>
          {row.steps.map((step) => <li key={step.n}>{step.action}</li>)}
        </ol>
      </div>
      <div class="actions">
        {needsInput ? <span class="muted">Answer the question in chat before this can run.</span> : (
          <button class="approve" disabled={acting} onClick={() => onAct(row.id, 'approve')}>
            {acting ? '…' : 'Approve & Proceed'}
          </button>
        )}
        <button class="reject" disabled={acting} onClick={() => onAct(row.id, 'reject')}>
          {acting ? '…' : needsInput ? 'Dismiss' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

interface ApprovalCardProps {
  row: ApprovalRow;
  acting: boolean;
  onAct: (id: string, action: 'approve' | 'reject') => void;
}

function ApprovalCard({ row, acting, onAct }: ApprovalCardProps) {
  const argsText = row.args !== null && row.args !== undefined
    ? typeof row.args === 'string' ? row.args : JSON.stringify(row.args, null, 2)
    : null;
  return (
    <div class="approval-card">
      <div class="head">
        <div class="tool">{row.tool ?? 'approval'}</div>
        <div class="when">{relativeTime(row.requestedAt)}</div>
      </div>
      <div class="subject">{row.subject}</div>
      {row.resourceFingerprint?.warning ? (
        <div class="warning">{row.resourceFingerprint.warning}</div>
      ) : null}
      {argsText ? <pre class="args">{argsText}</pre> : null}
      <div class="actions">
        <button class="approve" disabled={acting} onClick={() => onAct(row.approvalId, 'approve')}>
          {acting ? '…' : 'Approve'}
        </button>
        <button class="reject" disabled={acting} onClick={() => onAct(row.approvalId, 'reject')}>
          {acting ? '…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
