/**
 * Proposal learning loop — aggregate the user's approve/reject/edit
 * signals on past check-in proposals into a compact block the agent
 * can read at the start of every cycle.
 *
 * Why: the agent has a tool to propose check-in templates, but with no
 * feedback channel it keeps drafting blindly. By summarizing what the
 * user has approved, what they've rejected (with reasons), and which
 * fields they tend to edit before approving, the agent's future
 * proposals match the patterns the user actually wants and avoid the
 * ones they don't.
 *
 * The output is intentionally short — 12 to 20 lines max — so it can
 * sit inside the autonomy and chat instructions without bloating
 * every prompt.
 */
import { listProposals } from './check-in-proposals.js';
import type { CheckInTemplateProposal } from './check-in-proposals.js';

export interface ProposalFeedback {
  windowDays: number;
  totalApproved: number;
  totalRejected: number;
  approvedSamples: Array<{ name: string; trigger: string; question: string; appliedEdits?: Record<string, string | number> }>;
  rejectedSamples: Array<{ name: string; trigger: string; reason?: string }>;
  /** Counts by trigger for approved proposals (signals which kinds the user likes). */
  approvedTriggerCounts: Record<string, number>;
  /** Counts by trigger for rejected proposals. */
  rejectedTriggerCounts: Record<string, number>;
  /** Fields the user has overridden across approvals — the agent should match those values rather than its defaults. */
  commonEdits: Record<string, number>;
}

export interface GetFeedbackOptions {
  windowDays?: number;
  maxSamples?: number;
}

function withinWindow(iso: string | undefined, cutoff: Date): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts >= cutoff.getTime();
}

export function getProposalFeedback(options: GetFeedbackOptions = {}): ProposalFeedback {
  const windowDays = options.windowDays ?? 30;
  const maxSamples = options.maxSamples ?? 4;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const all: CheckInTemplateProposal[] = listProposals({ status: 'all' });

  const approved = all.filter((p) => p.status === 'approved' && withinWindow(p.resolvedAt, cutoff));
  const rejected = all.filter((p) => p.status === 'rejected' && withinWindow(p.resolvedAt, cutoff));

  const approvedTriggerCounts: Record<string, number> = {};
  const rejectedTriggerCounts: Record<string, number> = {};
  const commonEdits: Record<string, number> = {};
  for (const p of approved) {
    approvedTriggerCounts[p.trigger] = (approvedTriggerCounts[p.trigger] ?? 0) + 1;
    if (p.appliedEdits) {
      for (const field of Object.keys(p.appliedEdits)) {
        commonEdits[field] = (commonEdits[field] ?? 0) + 1;
      }
    }
  }
  for (const p of rejected) {
    rejectedTriggerCounts[p.trigger] = (rejectedTriggerCounts[p.trigger] ?? 0) + 1;
  }

  const approvedSamples = approved.slice(0, maxSamples).map((p) => ({
    name: p.name,
    trigger: p.trigger,
    question: p.questionTemplate,
    appliedEdits: p.appliedEdits,
  }));
  const rejectedSamples = rejected.slice(0, maxSamples).map((p) => ({
    name: p.name,
    trigger: p.trigger,
    reason: p.rejectionReason,
  }));

  return {
    windowDays,
    totalApproved: approved.length,
    totalRejected: rejected.length,
    approvedSamples,
    rejectedSamples,
    approvedTriggerCounts,
    rejectedTriggerCounts,
    commonEdits,
  };
}

/**
 * Render the feedback as a compact instructions block. Returns empty
 * string when there's no signal yet — callers can drop it entirely
 * rather than show an empty header.
 */
export function renderProposalFeedback(feedback: ProposalFeedback): string {
  if (feedback.totalApproved === 0 && feedback.totalRejected === 0) return '';

  const lines: string[] = [
    `PROPOSAL FEEDBACK (last ${feedback.windowDays}d) — your past check-in proposals.`,
  ];

  if (feedback.totalApproved > 0) {
    const triggerSummary = Object.entries(feedback.approvedTriggerCounts)
      .map(([t, n]) => `${t}×${n}`)
      .join(', ');
    lines.push(`Approved (${feedback.totalApproved}): ${triggerSummary}.`);
    for (const s of feedback.approvedSamples) {
      const editsNote = s.appliedEdits && Object.keys(s.appliedEdits).length > 0
        ? ` (user edited: ${Object.keys(s.appliedEdits).join(', ')})`
        : '';
      lines.push(`  · "${s.name}" — ${s.trigger}${editsNote}`);
    }
  }

  if (feedback.totalRejected > 0) {
    const triggerSummary = Object.entries(feedback.rejectedTriggerCounts)
      .map(([t, n]) => `${t}×${n}`)
      .join(', ');
    lines.push(`Rejected (${feedback.totalRejected}): ${triggerSummary}.`);
    for (const s of feedback.rejectedSamples) {
      const reasonNote = s.reason ? ` — "${s.reason}"` : '';
      lines.push(`  · "${s.name}" — ${s.trigger}${reasonNote}`);
    }
  }

  if (Object.keys(feedback.commonEdits).length > 0) {
    const editList = Object.entries(feedback.commonEdits)
      .sort((a, b) => b[1] - a[1])
      .map(([field, n]) => `${field}(${n}×)`)
      .join(', ');
    lines.push(`Fields the user often edits on approval: ${editList}. Default to their preference next time.`);
  }

  lines.push('Draft new proposals that match the approved patterns; avoid the rejected ones. If you have any doubt about whether a pattern would be welcome, skip the proposal rather than risk a reject.');

  return lines.join('\n');
}
