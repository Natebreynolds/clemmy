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

/**
 * Whether the workstate carries structured collaboration detail — the lists,
 * not merely an objective string. An objective alone renders as two lines of
 * text that just echo the last chat message, which reads as noise.
 */
export function workstateHasStructure(workstate: FocusWorkstate | null | undefined): boolean {
  return Boolean(workstate && (
    workstate.candidates.length > 0
    || workstate.constraints.length > 0
    || workstate.decisions.length > 0
    || workstate.openLoops.length > 0
    || workstate.actions.length > 0
  ));
}

/**
 * The Working Together card earns its space only when it shows something the
 * chat itself doesn't: structured workstate (options, decisions, open loops,
 * actions) or a context check the user needs to answer. A bare title+summary
 * card is an echo, so it stays hidden (owner feedback, 2026-07-30).
 */
export function shouldShowWorkstate(snapshot: FocusSnapshot | null | undefined): boolean {
  if (!snapshot?.active) return false;
  return snapshot.needsConfirm || workstateHasStructure(snapshot.active.workstate);
}

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
