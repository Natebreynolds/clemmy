/**
 * Needs you as one scannable list: every kind of decision becomes the same
 * compact row (what, for what work, how current), and the full content, the
 * form and the actions live only in the one selected detail. Pure; the screen
 * supplies the rows it already polls. Order and membership follow the feeds
 * exactly — this only decides how a row reads, never what counts.
 */
import { decisionPreview, oneLine } from '@clem/chat-engine';
import type { Tone } from '@/components/ui/StatusPill';
import {
  attentionPill,
  type ApprovalRow,
  type CollapsedAttentionRow,
  type InboxQuestionRow,
  type NeedsYouSummary,
  type PlanProposalRow,
  type TrustProposalRow,
  type WorkspaceDestinationChooser,
} from './inbox';

export type NeedsYouItem =
  | { kind: 'workspace'; id: string; row: WorkspaceDestinationChooser }
  | { kind: 'question'; id: string; row: InboxQuestionRow }
  | { kind: 'plan'; id: string; row: PlanProposalRow }
  | { kind: 'approval'; id: string; row: ApprovalRow; aged: boolean }
  | { kind: 'trust'; id: string; row: TrustProposalRow }
  | { kind: 'attention'; id: string; row: CollapsedAttentionRow['row']; collapsedCount: number }
  | { kind: 'unlisted'; id: string; row: NeedsYouSummary['unlisted'][number] };

export interface NeedsYouRowView {
  id: string;
  kind: NeedsYouItem['kind'];
  /** One line: the decision itself. */
  title: string;
  /** One short line of what it is about; never a repeat of the title. */
  preview?: string;
  /** Who or what asked (an agent, a workflow, a check-in). */
  context?: string;
  at?: string;
  state: { tone: Tone; label: string };
  /** Approvals can be decided together; nothing else is batch-decidable. */
  checkable: boolean;
  /** Older approvals sit below the live decisions. */
  aged: boolean;
  /** Rows that are a link to where they are resolved, not a selection. */
  href?: string;
}

const TITLE_MAX = 160;

/** The shared reading rules (one line, no reference ids, short headings). */
export { oneLine, isIdentifierLike, decisionHeading as detailHeading } from '@clem/chat-engine';
const previewFor = decisionPreview;

/** Where an attention item is resolved, from the server's own grouping key
 *  (dashboard/needs-you.ts): a conversation, or a workflow. */
export function attentionDestination(needsYouKey: string | null | undefined): { href: string; label: string } | undefined {
  const key = needsYouKey ?? '';
  if (key.startsWith('session:') && key.length > 'session:'.length) {
    return { href: `/chat/${encodeURIComponent(key.slice('session:'.length))}`, label: 'Open the conversation' };
  }
  if (key.startsWith('flow:') && key.length > 'flow:'.length) {
    return { href: `/automate?workflow=${encodeURIComponent(key.slice('flow:'.length))}`, label: 'Open the workflow' };
  }
  return undefined;
}

function questionContext(row: InboxQuestionRow): string {
  const source = row.source === 'workflow'
    ? (row.workflowName ? `${row.workflowName} workflow` : 'Workflow')
    : row.source === 'background_task' ? 'Background task' : 'Check-in';
  return row.agentLabel && row.agentLabel !== source ? `${row.agentLabel} · ${source}` : source;
}

export function needsYouRowView(item: NeedsYouItem): NeedsYouRowView {
  const base = { id: item.id, kind: item.kind, checkable: false, aged: false } as const;
  switch (item.kind) {
    case 'workspace': {
      const title = 'Where should these records live?';
      return { ...base, title, preview: 'Choose a Workspace for the records Clem is preparing.',
        at: item.row.createdAt, state: { tone: 'neutral', label: 'Choose' } };
    }
    case 'question': {
      const title = oneLine(item.row.question, TITLE_MAX) || 'Clem has a question';
      return { ...base, title, preview: previewFor(title, [item.row.context]),
        context: questionContext(item.row), at: item.row.askedAt,
        state: item.row.answerable ? { tone: 'neutral', label: 'Question' } : { tone: 'neutral', label: 'Answer elsewhere' } };
    }
    case 'plan': {
      const needsInput = (item.row.plan.needsUserInput ?? []).some((q) => typeof q === 'string' && q.trim());
      const title = oneLine(item.row.plan.objective || item.row.originatingRequest, TITLE_MAX) || 'Proposed plan';
      return { ...base, title, preview: previewFor(title, [item.row.originatingRequest, item.row.context]),
        at: item.row.proposedAt, state: needsInput ? { tone: 'neutral', label: 'Needs answers' } : { tone: 'neutral', label: 'Plan' } };
    }
    case 'approval': {
      const queued = item.row.pendingAction;
      // Clem's own question and why when her checker wrote them, then the
      // subject in words; the kind of action names a row only when nothing
      // else does. Never an operation id.
      const ask = item.row.presentation?.ask;
      const title = oneLine(queued?.title || ask || item.row.subject || item.row.presentation?.action, TITLE_MAX) || 'Approval';
      return { ...base, checkable: true, aged: item.aged, title,
        preview: previewFor(title, ask && !queued
          ? [item.row.presentation?.why, item.row.contentPreview?.body]
          : [queued?.targetSummary, item.row.contentPreview?.body, item.row.summary, item.row.subject]),
        context: item.row.presentation?.app, at: item.row.requestedAt,
        state: item.aged ? { tone: 'neutral', label: 'Older' } : { tone: 'live', label: queued ? 'Ready' : 'Approve' } };
    }
    case 'trust': {
      const scope = [...item.row.recipients, ...(item.row.domains ?? []).map((d) => `anyone @${d}`)].join(', ');
      const title = oneLine(`Trust sends to ${scope}`, TITLE_MAX);
      return { ...base, title, preview: previewFor(title, [item.row.rationale]),
        at: item.row.createdAt, state: { tone: 'neutral', label: 'Suggestion' } };
    }
    case 'attention': {
      const capability = item.row.workflowCapability;
      const title = oneLine(item.row.title || item.row.body, TITLE_MAX) || 'Needs your attention';
      const pill = attentionPill(item.row);
      return { ...base, title, preview: previewFor(title, [item.row.body]),
        context: capability ? `${capability.workflow} workflow` : undefined, at: item.row.createdAt,
        state: capability ? { tone: 'warning', label: 'Stopped' }
          : pill.label === 'Stopped' ? { tone: 'warning', label: 'Stopped' }
          : pill.label === 'Reply' ? { tone: 'info', label: 'Reply' }
          // "Needs you" inside Needs you says nothing; the row is an update to read.
          : { tone: 'neutral', label: pill.label === 'Needs you' ? 'Update' : pill.label },
        ...(item.collapsedCount > 0 ? { context: `${capability ? `${capability.workflow} workflow · ` : ''}+${item.collapsedCount} earlier` } : {}) };
    }
    case 'unlisted': {
      const title = oneLine(item.row.title, TITLE_MAX) || 'Needs your attention';
      const stopped = item.row.kind === 'workflow_binding' || item.row.kind === 'workflow_paused';
      return { ...base, title, preview: previewFor(title, [item.row.detail]),
        context: item.row.workflow ? `${item.row.workflow} workflow` : undefined,
        state: stopped ? { tone: 'warning', label: item.row.kind === 'workflow_binding' ? 'Stopped' : 'Paused' } : { tone: 'neutral', label: 'Needs you' },
        href: item.row.workflow ? `/automate?workflow=${encodeURIComponent(item.row.workflow)}` : '/chat' };
    }
  }
}

/** Every decision source in one order: live decisions first, older approvals last. */
export function buildNeedsYouItems(input: {
  workspaceChoosers: readonly WorkspaceDestinationChooser[];
  questions: readonly InboxQuestionRow[];
  plans: readonly PlanProposalRow[];
  approvals: readonly ApprovalRow[];
  trust: readonly TrustProposalRow[];
  attention: readonly CollapsedAttentionRow[];
  unlisted: NeedsYouSummary['unlisted'];
}): NeedsYouItem[] {
  return [
    ...input.workspaceChoosers.map((row): NeedsYouItem => ({ kind: 'workspace', id: row.chooserId, row })),
    ...input.questions.map((row): NeedsYouItem => ({ kind: 'question', id: row.id, row })),
    ...input.plans.map((row): NeedsYouItem => ({ kind: 'plan', id: row.id, row })),
    ...input.approvals.filter((row) => !row.stale).map((row): NeedsYouItem => ({ kind: 'approval', id: row.approvalId, row, aged: false })),
    ...input.trust.map((row): NeedsYouItem => ({ kind: 'trust', id: row.id, row })),
    ...input.attention.map(({ row, collapsedCount }): NeedsYouItem => ({ kind: 'attention', id: row.id, row, collapsedCount })),
    ...input.unlisted.map((row): NeedsYouItem => ({ kind: 'unlisted', id: row.key, row })),
    ...input.approvals.filter((row) => row.stale).map((row): NeedsYouItem => ({ kind: 'approval', id: row.approvalId, row, aged: true })),
  ];
}
