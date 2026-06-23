/**
 * Workspaces ("Spaces") — typed fetchers over the daemon's /api/console/spaces
 * routes. Mirrors lib/meetings.ts. The view itself is served at the absolute
 * path /console/spaces/<id>/view (by the daemon, outside the SPA router).
 */
import { apiGet, apiPost, apiPatch, apiDelete } from './api';

export interface SpaceDataSource {
  id: string;
  runner?: string;
  composioSlug?: string;
  composioArgs?: Record<string, unknown>;
  schedule?: string;
  timezone?: string;
}
export interface SpaceAction {
  id: string;
  label?: string;
  composioSlug?: string;
  runner?: string;
  argsTemplate?: Record<string, unknown>;
  confirm?: boolean;
}
export interface SpaceRevision { version: number; ts: string; bytes: number; file: string }
export type SpaceStatus = 'active' | 'paused' | 'archived';
export interface SpaceRecord {
  id: string;
  title: string;
  status: SpaceStatus;
  viewEntry: string;
  dataSources: SpaceDataSource[];
  actions: SpaceAction[];
  reengage?: { triggers: string[]; guidance?: string };
  originSessionId?: string;
  version: number;
  revisions: SpaceRevision[];
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  lastRefreshedAt?: string;
  recipe?: string;
}
export interface SpaceNote { id: string; text: string; kind?: string; meta?: Record<string, unknown>; createdAt: string }
export interface SpaceAudit { ts: string; method: string; path: string; outcome: string; note?: string }
export interface SpaceDetail {
  space: SpaceRecord;
  viewSource: string;
  /** Last-modified of the view file — changes on ANY edit (write_file, space_edit_view, rollback). */
  viewMtimeMs?: number;
  notes: SpaceNote[];
  audit: SpaceAudit[];
}
export interface RefreshResult { ok: boolean; sourceId: string; error?: string }

export const listSpaces = () =>
  apiGet<{ spaces: SpaceRecord[] }>('/api/console/spaces').then((r) => r.spaces);

export const getSpace = (id: string) =>
  apiGet<SpaceDetail>(`/api/console/spaces/${encodeURIComponent(id)}`);

export const createSpace = (title: string) =>
  apiPost<{ space: SpaceRecord }>('/api/console/spaces', { title }).then((r) => r.space);

export const patchSpace = (id: string, patch: { title?: string; status?: SpaceStatus }) =>
  apiPatch<{ space: SpaceRecord }>(`/api/console/spaces/${encodeURIComponent(id)}`, patch).then((r) => r.space);

export const archiveSpace = (id: string) =>
  apiDelete<{ space: SpaceRecord }>(`/api/console/spaces/${encodeURIComponent(id)}`);

export const deleteSpace = (id: string) =>
  apiDelete<{ removed: boolean }>(`/api/console/spaces/${encodeURIComponent(id)}?hard=1`);

export const refreshSpace = (id: string, sourceId?: string) =>
  apiPost<{ results: RefreshResult[]; data: unknown }>(
    `/api/console/spaces/${encodeURIComponent(id)}/refresh`, sourceId ? { sourceId } : {},
  );

export const rollbackSpace = (id: string, version: number) =>
  apiPost<{ space: SpaceRecord }>(`/api/console/spaces/${encodeURIComponent(id)}/rollback`, { version });

/** Tell Clem about an in-workspace interaction (note / ask / threshold). */
export const reengageSpace = (id: string, body: { trigger?: 'note' | 'ask' | 'threshold'; message?: string; actionId?: string }) =>
  apiPost<{ ok: boolean; reengaged: boolean; sessionId?: string }>(
    `/api/console/spaces/${encodeURIComponent(id)}/reengage`, body,
  );

/** Count actions still WAITING on approval (E1): a 'pending' action note whose
 *  approvalId hasn't been resolved by a later note (ran → meta.ok set, or
 *  rejected → meta.status 'rejected'). Drives the toolbar "N waiting" badge. */
export function openApprovalCount(notes: SpaceNote[]): number {
  const resolved = new Set<string>();
  for (const n of notes) {
    const m = n.meta;
    const aid = m && typeof m.approvalId === 'string' ? m.approvalId : null;
    if (aid && (m!.ok !== undefined || m!.status === 'rejected')) resolved.add(aid);
  }
  let open = 0;
  for (const n of notes) {
    const m = n.meta;
    if (n.kind !== 'action' || !m || m.status !== 'pending') continue;
    const aid = typeof m.approvalId === 'string' ? m.approvalId : null;
    if (aid && !resolved.has(aid)) open += 1;
  }
  return open;
}

export interface GapQuestion { question: string; why?: string }

/** The clarifying questions Clem's gap-test flagged at save time (the LATEST
 *  gap note wins, so a later clean save clears them). Surfaced in the build panel. */
export function gapQuestions(notes: SpaceNote[]): GapQuestion[] {
  const gapNotes = notes.filter((n) => n.kind === 'gap');
  const latest = gapNotes[gapNotes.length - 1];
  const gaps = latest?.meta?.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps
    .filter((g): g is { question: string; why?: string } => !!g && typeof (g as { question?: unknown }).question === 'string')
    .map((g) => ({ question: g.question, why: typeof g.why === 'string' ? g.why : undefined }));
}

/** Absolute URL the daemon serves the view at (same-origin → cookie-authed). */
export const spaceViewUrl = (id: string) => `/console/spaces/${encodeURIComponent(id)}/view`;

/** The dedicated chat thread for a workspace's floating dock + re-engage. */
export const spaceSessionId = (id: string) => `space-${id}`;
