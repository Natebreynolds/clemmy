import type { WorkflowCardData } from '@clem/chat-engine';
import type { RunStep, RunSourceCoverage } from '@/lib/run-presentation';
import type { TaskMode, PlanRevisionRef } from '../../lib/task-mode';
/** Mirrors the backend UnifiedSessionSummary (src/types.ts). */
export type SessionOrigin = 'desktop' | 'cli' | 'discord' | 'workflow' | 'agent';

export interface Session {
  id: string;
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
  /** Workflows this reply created or changed, as saved; drawn as cards under it. */
  workflows?: WorkflowCardData[];
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
  /** Exact still-pending plan proposal restored by the server on reopen. */
  planProposalId?: string;
  /** A still-pending approval attached by the server so a reopened chat
   *  renders the actionable card (A2, v2.3.0). */
  approval?: {
    subject: string;
    reason?: string;
    approvalId: string;
    pendingAction?: unknown;
    preview?: unknown;
    /** The card this one revises after a change in words (owner's words, fields as they were). */
    revises?: unknown;
    /** 'expired': nobody answered in time; render the card settled. */
    resolution?: unknown;
  };
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
