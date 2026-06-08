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
export interface SpaceNote { id: string; text: string; kind?: string; createdAt: string }
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

/** Absolute URL the daemon serves the view at (same-origin → cookie-authed). */
export const spaceViewUrl = (id: string) => `/console/spaces/${encodeURIComponent(id)}/view`;

/** The dedicated chat thread for a workspace's floating dock + re-engage. */
export const spaceSessionId = (id: string) => `space-${id}`;
