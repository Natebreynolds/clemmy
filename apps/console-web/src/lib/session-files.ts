/**
 * A file a conversation's own work saved, read for the panel beside the
 * conversation. The card knows the file's name and folder; the daemon finds
 * the one file this conversation recorded writing and answers with it.
 */
import { apiGet, apiPost } from './api';

export type SessionFileKind = 'markdown' | 'text' | 'image' | 'other';

export interface SessionFile {
  name: string;
  folder: string;
  place: string;
  kind: SessionFileKind;
  bytes: number;
  modifiedAt: string;
  text?: string;
  truncated?: boolean;
  openable: boolean;
}

/** One saved file, as a conversation's card names it. */
export interface SessionFileRef { sessionId: string; name: string; folder: string }

/** The daemon route for one saved file, with or without a sub-resource. */
export function sessionFilePath(ref: SessionFileRef, part: '' | 'image' | 'open' = ''): string {
  const query = new URLSearchParams({ name: ref.name, folder: ref.folder }).toString();
  return `/api/console/sessions/${encodeURIComponent(ref.sessionId)}/file${part ? `/${part}` : ''}?${query}`;
}

export function sameSessionFile(a: SessionFileRef | null | undefined, b: SessionFileRef | null | undefined): boolean {
  return Boolean(a && b && a.sessionId === b.sessionId && a.name === b.name && a.folder === b.folder);
}

export async function readSessionFile(ref: SessionFileRef): Promise<SessionFile> {
  return (await apiGet<{ file: SessionFile }>(sessionFilePath(ref))).file;
}

export async function readSessionFileImage(ref: SessionFileRef): Promise<string> {
  const answer = await apiGet<{ image: string; mimeType: string }>(sessionFilePath(ref, 'image'));
  return `data:${answer.mimeType};base64,${answer.image}`;
}

export async function openSessionFile(ref: SessionFileRef): Promise<void> {
  await apiPost(sessionFilePath(ref, 'open'));
}

/** A size the owner reads, not a byte count. */
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
