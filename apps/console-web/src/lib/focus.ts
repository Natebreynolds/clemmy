import { apiGet } from './api';

export type FocusStatus = 'active' | 'paused' | 'completed' | 'abandoned';
export type FocusWorkMode = 'explore' | 'decide' | 'execute' | 'monitor';
export type FocusCandidateStatus = 'considering' | 'selected' | 'rejected';
export type FocusActionStatus = 'planned' | 'running' | 'blocked' | 'done';
export type FocusActionKind = 'background' | 'workflow' | 'external' | 'local' | 'other';

export interface FocusWorkstateCandidate {
  id: string;
  label: string;
  status: FocusCandidateStatus;
  note?: string;
  ref?: string;
}

export interface FocusWorkstateAction {
  id: string;
  label: string;
  status: FocusActionStatus;
  kind?: FocusActionKind;
  ref?: string;
  note?: string;
}

export interface FocusWorkstate {
  version: number;
  updatedAt: string;
  mode?: FocusWorkMode;
  objective?: string;
  candidates: FocusWorkstateCandidate[];
  constraints: string[];
  decisions: string[];
  openLoops: string[];
  actions: FocusWorkstateAction[];
}

/** Deliberately excludes the daemon's internal metadata_json extension seam. */
export interface FocusView {
  id: number;
  resource_ref: string;
  title: string;
  summary: string;
  status: FocusStatus;
  resource_kind: string | null;
  related_session_id: string | null;
  related_goal_id: string | null;
  created_at: string;
  last_touched_at: string;
  confirm_after: string;
  parked_at: string | null;
  parked_reason: string | null;
  workstate: FocusWorkstate | null;
}

export interface FocusSnapshot {
  active: FocusView | null;
  parked: FocusView[];
  parkedCount?: number;
  needsConfirm: boolean;
}

export const listFocusSnapshot = () =>
  apiGet<FocusSnapshot>('/api/console/focus');

export function focusActionHref(action: FocusWorkstateAction): string | null {
  const ref = action.ref?.trim();
  if (!ref || (action.kind !== 'background' && action.kind !== 'workflow')) return null;
  return `/tasks?select=${encodeURIComponent(ref)}`;
}

export function hasWorkstateDetails(workstate: FocusWorkstate | null | undefined): boolean {
  return Boolean(workstate && (
    workstate.objective
    || workstate.candidates.length > 0
    || workstate.constraints.length > 0
    || workstate.decisions.length > 0
    || workstate.openLoops.length > 0
    || workstate.actions.length > 0
  ));
}
