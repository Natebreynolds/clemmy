import { apiGet } from './api';
import type { SessionFileRef } from './session-files';

/** One file, draft, or URL inside a piece of finished work. */
export interface DeliveredArtifact {
  kind: string;
  title: string;
  target: string;
  createdAt: string;
  openable: boolean;
  stillExists?: boolean;
  /** Server-resolved identity; never infer this from target. */
  fileRef?: SessionFileRef;
  conversationSessionId?: string | null;
}

/** A piece of FINISHED WORK from the durable deliverable index — grouped
 *  server-side (one card per work session, not per artifact/tool call). */
export interface DeliveredGroup {
  id: number;
  createdAt: string;
  /** Humanized name of the work — never a tool slug or bare filename. */
  title: string;
  /** The ask that produced it. */
  why: string;
  lane: string | null;
  sessionId: string | null;
  /** Verified chat origin. Null means no safe conversation link is known. */
  conversationSessionId?: string | null;
  url?: string;
  filePath?: string;
  fileStillExists?: boolean;
  artifactCount: number;
  rerunnable: boolean;
  artifacts?: DeliveredArtifact[];
}

export function listDelivered(limit = 12, options?: { sessionIds?: readonly string[] }): Promise<DeliveredGroup[]> {
  if (options?.sessionIds && options.sessionIds.length === 0) return Promise.resolve([]);
  const query = new URLSearchParams({ limit: String(limit) });
  if (options?.sessionIds) query.set('sessionIds', options.sessionIds.join(','));
  return apiGet<{ groups: DeliveredGroup[] }>(`/api/console/delivered?${query}`).then((r) => r.groups);
}

/** A local preview needs the server's association with the producing session. */
export function deliveredFileRef(artifact: DeliveredArtifact): SessionFileRef | null {
  const ref = artifact.fileRef;
  return artifact.kind === 'file' && artifact.stillExists !== false && ref
    && typeof ref.sessionId === 'string' && ref.sessionId.length > 0
    && typeof ref.name === 'string' && ref.name.length > 0
    && typeof ref.folder === 'string'
    && typeof ref.fileId === 'string' && ref.fileId.length > 0 ? ref : null;
}

export function deliveredConversationId(group: DeliveredGroup, artifact?: DeliveredArtifact): string | null {
  if (artifact?.conversationSessionId !== undefined) return artifact.conversationSessionId;
  return group.conversationSessionId !== undefined ? group.conversationSessionId : group.sessionId;
}

export function latestDeliveredGroups(groups: readonly DeliveredGroup[]): DeliveredGroup[] {
  const time = (group: DeliveredGroup) => Date.parse(group.createdAt) || 0;
  return [...groups].sort((a, b) => time(b) - time(a) || b.id - a.id);
}

export function matchesDeliveredSearch(group: DeliveredGroup, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [group.title, ...groupArtifacts(group).flatMap(artifact => [
    artifact.title, artifact.fileRef?.name ?? '', artifact.target.split(/[\\/]/).at(-1) ?? '',
  ])].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

/** A folder match can span several artifacts; its direct Open must identify one. */
export function matchingDeliveredFile(group: DeliveredGroup, query = ''): DeliveredArtifact | undefined {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return [...groupArtifacts(group)]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .find(artifact => {
      const ref = deliveredFileRef(artifact);
      if (!ref) return false;
      const text = `${group.title} ${artifact.title} ${ref.name}`.toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
}

export function folderHref(group: Pick<DeliveredGroup, 'id'>): string {
  return `/made/${group.id}`;
}

/** Older daemons omit `artifacts`; synthesize from the representative url/file. */
type ArtifactSource = Pick<DeliveredGroup, 'artifactCount'> & Partial<DeliveredGroup>;

export function groupArtifacts(group: ArtifactSource): DeliveredArtifact[] {
  if (group.artifacts && group.artifacts.length > 0) return group.artifacts;
  const rows: DeliveredArtifact[] = [];
  if (group.url) {
    rows.push({
      kind: 'url',
      title: group.title ?? group.url,
      target: group.url,
      createdAt: group.createdAt ?? '',
      openable: true,
    });
  }
  if (group.filePath) {
    rows.push({
      kind: 'file',
      title: group.title ?? group.filePath,
      target: group.filePath,
      createdAt: group.createdAt ?? '',
      openable: group.fileStillExists !== false,
      stillExists: group.fileStillExists,
    });
  }
  return rows;
}

export function isHttpTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export function isEmailTarget(target: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target);
}

/** Kinds inside the folder, or a best guess from the humanized title when
 *  an older daemon omitted `artifacts`. */
export function groupKinds(group: ArtifactSource): Set<string> {
  const kinds = new Set(groupArtifacts(group).map((a) => a.kind));
  if (kinds.size > 0) return kinds;
  const title = group.title ?? '';
  if (title === 'Email drafted') kinds.add('draft');
  else if (title === 'Email sent') kinds.add('send');
  else if (title === 'Google Sheet' || title === 'Google Sheet updated') kinds.add('external_doc');
  if (group.filePath) kinds.add('file');
  if (group.url) kinds.add('url');
  return kinds;
}

export function artifactCountLabel(group: ArtifactSource): string {
  const artifacts = groupArtifacts(group);
  const n = Math.max(group.artifactCount || 0, artifacts.length);
  const kinds = groupKinds(group);
  const mixed = kinds.size > 1;
  if (n > 0 && !mixed && kinds.has('draft')) return n === 1 ? '1 draft' : `${n} drafts`;
  if (n > 0 && !mixed && kinds.has('file')) return n === 1 ? '1 file' : `${n} files`;
  if (n > 0 && !mixed && kinds.has('send')) return n === 1 ? '1 send' : `${n} sends`;
  return n === 1 ? '1 item' : `${n} items`;
}

export function dayHeading(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  const then = startOfDay(t);
  const days = Math.round((today - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
