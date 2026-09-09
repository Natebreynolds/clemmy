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
  /** Exact step sessions supplied by the backend for a collapsed run. */
  runSteps?: RunStep[];
  runCoverage?: RunSourceCoverage;
}

export interface Turn {
  taskMode?: TaskMode;
  planArtifactRef?: PlanRevisionRef;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  /** Exact still-pending plan proposal restored by the server on reopen. */
  planProposalId?: string;
  /** A still-pending approval attached by the server so a reopened chat
   *  renders the actionable card (A2, v2.3.0). */
  approval?: {
    subject: string;
    reason?: string;
    approvalId: string;
    pendingAction?: unknown;
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
  includeArchived?: boolean;
  /** Rows to ask the server for. Runs share the page with chats now, so the
   *  route's default of 100 would let a busy morning of workflow runs push
   *  yesterday's conversations off the end of the list. Capped at 500 server
   *  side (sessions-api.ts buildUnifiedSessionList). */
  limit?: number;
}
