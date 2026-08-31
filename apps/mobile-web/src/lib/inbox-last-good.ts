import type {
  ApprovalRow,
  InboxNotification,
  InboxQuestion,
  InboxTrustProposal,
  PlanProposalRow,
  WorkspaceDestinationChooser,
} from './api';

export interface InboxCollections {
  approvals: ApprovalRow[];
  plans: PlanProposalRow[];
  workspaceChoosers: WorkspaceDestinationChooser[];
  questions: InboxQuestion[];
  trustProposals: InboxTrustProposal[];
  notifications: InboxNotification[];
}

/** Missing means “never successfully observed”; [] means authoritative zero. */
export type InboxLastGood = Partial<InboxCollections>;

export function mergeInboxLastGood(
  previous: InboxLastGood,
  successfulSources: InboxLastGood,
): InboxLastGood {
  return { ...previous, ...successfulSources };
}

export function inboxNeedsCountKnown(value: InboxLastGood): value is InboxCollections {
  return value.approvals !== undefined
    && value.plans !== undefined
    && value.workspaceChoosers !== undefined
    && value.questions !== undefined
    && value.trustProposals !== undefined
    && value.notifications !== undefined;
}
