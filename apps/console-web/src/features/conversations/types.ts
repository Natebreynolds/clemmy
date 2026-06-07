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
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
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
}
