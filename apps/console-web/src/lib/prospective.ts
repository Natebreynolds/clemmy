import { apiGet } from './api';

export type ProspectiveStatus = 'active' | 'due' | 'claimed' | 'blocked' | 'completed' | 'cancelled';
export type ProspectiveSourceKind =
  | 'timer'
  | 'goal'
  | 'workflow_schedule'
  | 'workflow_event'
  | 'workflow_webhook'
  | 'monitor'
  | 'check_in'
  | 'background';

export type ProspectiveTrigger =
  | { kind: 'time'; at: string; timezone?: string }
  | { kind: 'cron'; expression: string; timezone?: string }
  | { kind: 'event'; eventType: string; filter?: Record<string, string | number | boolean> }
  | { kind: 'webhook'; path: string }
  | { kind: 'state'; channel: string; intervalMs?: number }
  | { kind: 'completion'; resourceType: string; resourceId: string }
  | { kind: 'manual' };

export interface ProspectiveIntentionSummary {
  id: string;
  sourceKind: ProspectiveSourceKind;
  sourceId: string;
  generation: number;
  objective: string;
  trigger: ProspectiveTrigger;
  action: { kind: string; ref?: string; summary?: string };
  sessionId?: string;
  goalId?: string;
  workflowName?: string;
  risk: 'read' | 'write' | 'send' | 'inherits';
  approvalMode: 'none' | 'enforce_at_action';
  recurring: boolean;
  status: ProspectiveStatus;
  dueAt?: string;
  lastCueAt?: string;
  lastOutcomeAt?: string;
  cancellationReason?: string;
  updatedAt: string;
}

export interface ProspectiveIntentionsPayload {
  intentions: ProspectiveIntentionSummary[];
  counts: {
    total: number;
    open: number;
    needsAttention: number;
    active: number;
    due: number;
    claimed: number;
    blocked: number;
    completed: number;
    cancelled: number;
  };
  generatedAt: string;
}

export const listOpenProspectiveIntentions = (limit = 100) =>
  apiGet<ProspectiveIntentionsPayload>(
    `/api/console/prospective-intentions?status=open&limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`,
  );
