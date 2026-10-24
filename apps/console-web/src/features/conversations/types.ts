import type { WorkflowCardData } from '@clem/chat-engine';
import type { RunStep, RunSourceCoverage } from '@/lib/run-presentation';
import type { TaskMode, PlanRevisionRef } from '../../lib/task-mode';
/** Mirrors the backend UnifiedSessionSummary (src/types.ts). */
export type SessionOrigin = 'desktop' | 'cli' | 'discord' | 'workflow' | 'agent';

export interface Session {
  id: string;
  /** Physical execution head; id remains the stable visible conversation. */
  executionSessionId?: string;
  origin: SessionOrigin;
  store: 'desktop' | 'harness';
  kind: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  pinned: boolean;
  tags: string[];
  archived: boolean;
  continuable: boolean;
  turnCount: number;
  /** The agent answering this conversation's next message; null = Clem. */
  agentId?: string | null;
  agentName?: string | null;
  /** Every agent that has answered here, oldest first. */
  agentIds?: string[];
  /** The project this conversation works in from its next message; null = none. */
  projectId?: string | null;
  projectName?: string | null;
  /** Exact step sessions supplied by the backend for a collapsed run. */
  runSteps?: RunStep[];
  runCoverage?: RunSourceCoverage;
  /** Work is in flight in it right now. Absent from an older Mac. */
  running?: boolean;
}

export interface Turn {
  /** A question's answers as its question offered them (server transcript). */
  questionOptions?: string[];
  /** Exact real accepted source paired by the server transcript projector.
   * Missing on legacy/orphan/synthetic turns; never inferred by the client. */
  acceptedSource?: { sessionId: string; sourceUserSeq: number; turn: number };
  checkIn?: boolean;
  fromClem?: boolean;
  steerReceipt?: import('@clem/chat-engine').SteerReceipt;
  steerNote?: true;
  steerNoteSessionId?: string;
  steerNoteSeq?: number;
  /** Workflows this reply created or changed, as saved; drawn as cards under it. */
  workflows?: WorkflowCardData[];
  /** Recorded file saves belonging to this reply, resolved by the chat on open. */
  files?: Array<{ name: string; dir: string }>;
  taskMode?: TaskMode;
  planArtifactRef?: PlanRevisionRef;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  /** Who answered this exchange: an agent's name, null for Clem. Absent when
   *  the turn left no record of it. */
  agentName?: string | null;
  /** The project this exchange worked in, by name. Absent when it worked in
   *  none, or when the turn left no record. */
  projectName?: string | null;
  /** The reply's typed terminal, as live delivery projected it: how it ended
   *  (presentation and outcome status), the review ruling and finding, what
   *  was kept, and any app notice. Lets a reopened reply draw the same status
   *  line, pill and review chip it did live. Absent from an older Mac, whose
   *  history is plain text. */
  terminal?: TurnTerminal;
  /** Exact still-pending plan proposal restored by the server on reopen. */
  planProposalId?: string;
  /** A still-pending approval attached by the server so a reopened chat
   *  renders the actionable card (A2, v2.3.0). */
  approval?: {
    subject: string;
    reason?: string;
    approvalId: string;
    ownerSessionId?: string;
    pendingActionId?: string;
    pendingAction?: unknown;
    preview?: unknown;
    /** The card this one revises after a change in words (owner's words, fields as they were). */
    revises?: unknown;
    /** 'expired': nobody answered in time; render the card settled. */
    resolution?: unknown;
  };
}

/** The typed terminal facts a reopened assistant turn carries, in the same
 *  shapes as the live terminal event; the chat engine revalidates every field. */
export interface TurnTerminal {
  sourceUserSeq?: unknown;
  blockedReason?: unknown;
  presentation?: { status?: unknown; kind?: unknown };
  turnOutcome?: { status?: unknown; resumable?: unknown; needs?: unknown };
  review?: unknown;
  reviewNote?: unknown;
  retained?: unknown;
  notice?: unknown;
}

export interface ContinueHint {
  mode: 'desktop' | 'harness';
  endpoint: string;
  streamUrl: string | null;
  protocol: 'ndjson' | 'sse';
}

export interface SessionDetail {
  session: Session;
  turns: Turn[];
  continueHint: ContinueHint | null;
}

export interface SessionListResponse {
  sessions: Session[];
  total: number;
}

export interface SessionFilters {
  q?: string;
  tag?: string;
  source?: string;
  /** Only conversations bound to this agent id. */
  agent?: string;
  includeArchived?: boolean;
  /** Rows to ask the server for. Runs share the page with chats now, so the
   *  route's default of 100 would let a busy morning of workflow runs push
   *  yesterday's conversations off the end of the list. Capped at 500 server
   *  side (sessions-api.ts buildUnifiedSessionList). */
  limit?: number;
}
