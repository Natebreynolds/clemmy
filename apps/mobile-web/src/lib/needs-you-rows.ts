/**
 * The phone's Needs you as one compact list. Every kind of waiting item reads
 * as the same row (what, for what work, how current); tapping one opens that
 * item's full card on its own. Pure: the screen passes the rows it already
 * loaded, in the order it already shows them, so membership and the count are
 * unchanged — this only decides how a row reads. The reading rules are the
 * shared ones the desktop list uses.
 */
import { decisionPreview, oneLine } from '@clem/chat-engine';
import type {
  ApprovalRow,
  InboxNotification,
  InboxQuestion,
  InboxTrustProposal,
  InboxUnlistedItem,
  PlanProposalRow,
  WorkspaceDestinationChooser,
} from './api';
import { needsYouCardLabel, notificationTitle } from './inbox-presentation';

export type NeedsRowKind = 'question' | 'trust' | 'workspace' | 'plan' | 'approval' | 'unlisted' | 'attention';

export interface NeedsRow {
  /** The same identity the screen's cards and deep links use. */
  key: string;
  kind: NeedsRowKind;
  title: string;
  preview?: string;
  /** Who or what asked, and the project when there is one. */
  context?: string;
  at?: string;
  label: string;
  /** Only a real problem (a stopped workflow) reads as urgent. */
  urgent: boolean;
}

const TITLE_MAX = 120;

function joinContext(...parts: Array<string | null | undefined>): string | undefined {
  const text = parts.map((part) => part?.trim()).filter(Boolean).join(' · ');
  return text || undefined;
}

function questionSource(question: InboxQuestion): string {
  if (question.workflowName) return question.workflowName;
  if (question.agentLabel && question.agentLabel !== 'Clem') return question.agentLabel;
  if (question.source === 'workflow') return 'Workflow';
  if (question.source === 'background_task') return 'Task';
  return 'Check-in';
}

export function buildNeedsRows(input: {
  questions: readonly InboxQuestion[];
  trustProposals: readonly InboxTrustProposal[];
  workspaceChoosers: readonly WorkspaceDestinationChooser[];
  plans: readonly PlanProposalRow[];
  approvals: readonly ApprovalRow[];
  unlisted: readonly InboxUnlistedItem[];
  attention: ReadonlyArray<{ row: InboxNotification; earlier: number }>;
  /** The project a row's session works in, when it works in one. */
  projectOf?: (kind: NeedsRowKind, row: unknown) => string | null;
}): NeedsRow[] {
  const project = (kind: NeedsRowKind, row: unknown) => input.projectOf?.(kind, row) ?? null;
  const rows: NeedsRow[] = [];
  for (const question of input.questions) {
    const title = oneLine(question.question, TITLE_MAX) || 'Clem has a question';
    rows.push({
      key: question.id, kind: 'question', title,
      preview: decisionPreview(title, [question.context]),
      context: joinContext(project('question', question), questionSource(question)),
      at: question.askedAt, label: 'Question', urgent: false,
    });
  }
  for (const proposal of input.trustProposals) {
    const scope = [...proposal.recipients, ...proposal.domains.map((domain) => `anyone @${domain}`)].join(', ');
    const title = oneLine(`Stop asking before sends to ${scope}?`, TITLE_MAX);
    rows.push({
      key: `trust:${proposal.id}`, kind: 'trust', title,
      preview: decisionPreview(title, [proposal.rationale]),
      at: proposal.createdAt, label: 'Suggestion', urgent: false,
    });
  }
  for (const chooser of input.workspaceChoosers) {
    rows.push({
      key: `chooser:${chooser.chooserId}`, kind: 'workspace', title: 'Where should these records live?',
      preview: 'Choose a Workspace for the records Clem is preparing.',
      at: chooser.createdAt, label: 'Choose', urgent: false,
    });
  }
  for (const plan of input.plans) {
    const title = oneLine(plan.objective, TITLE_MAX) || 'Proposed plan';
    rows.push({
      key: `plan:${plan.id}`, kind: 'plan', title,
      preview: decisionPreview(title, [plan.context, plan.steps[0]?.action]),
      context: joinContext(project('plan', plan)),
      at: plan.proposedAt, label: plan.needsUserInput.some((q) => q.trim()) ? 'Needs answers' : 'Plan', urgent: false,
    });
  }
  for (const approval of input.approvals) {
    const title = oneLine(approval.presentation?.action || approval.subject, TITLE_MAX) || 'Approval';
    rows.push({
      key: `approval:${approval.approvalId}`, kind: 'approval', title,
      preview: decisionPreview(title, [approval.contentPreview?.body, approval.subject]),
      context: joinContext(project('approval', approval), approval.presentation?.app),
      at: approval.requestedAt, label: 'Approve', urgent: false,
    });
  }
  for (const item of input.unlisted) {
    const stopped = item.kind === 'workflow_binding' || item.kind === 'workflow_paused';
    const title = oneLine(item.title, TITLE_MAX) || 'Needs your attention';
    rows.push({
      key: `unlisted:${item.key}`, kind: 'unlisted', title,
      preview: decisionPreview(title, [item.detail]),
      context: joinContext(item.workflow),
      label: item.kind === 'workflow_binding' ? 'Stopped' : item.kind === 'workflow_paused' ? 'Paused' : 'Needs you',
      urgent: stopped,
    });
  }
  for (const { row, earlier } of input.attention) {
    const title = oneLine(notificationTitle(row.title), TITLE_MAX) || 'I need your attention';
    const gate = row.workflowCapability;
    const cardLabel = needsYouCardLabel(row);
    // "Needs you" inside Needs you says nothing; the row is an update to read.
    const label = gate ? 'Stopped' : cardLabel === 'Update · needs you' ? 'Update' : cardLabel;
    rows.push({
      key: `notification:${row.id}`, kind: 'attention', title,
      preview: decisionPreview(title, [row.body]),
      context: joinContext(project('attention', row), gate?.workflow, earlier > 0 ? `+${earlier} earlier` : null),
      at: row.createdAt, label,
      urgent: Boolean(gate) || label === 'Flow · stopped',
    });
  }
  return rows;
}
