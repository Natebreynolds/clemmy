/** Reads only files recorded as saved by this conversation or its workers. */
import { apiGet, apiPost, withToken } from './api';

export type SessionFileKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'other';
export interface SessionFile {
  fileId?: string;
  name: string;
  folder: string;
  place: string;
  kind: SessionFileKind;
  bytes: number;
  modifiedAt: string;
  text?: string;
  previewHtml?: string;
  truncated?: boolean;
  openable: boolean;
}
export interface SessionFileRef { sessionId: string; name: string; folder: string; fileId?: string }
export function sessionFilePath(ref: SessionFileRef, part: '' | 'image' | 'open' | 'content' = ''): string {
  const query = new URLSearchParams({ name: ref.name, folder: ref.folder });
  if (ref.fileId) query.set('fileId', ref.fileId);
  return `/api/console/sessions/${encodeURIComponent(ref.sessionId)}/file${part ? `/${part}` : ''}?${query}`;
}
export function sameSessionFile(a: SessionFileRef | null | undefined, b: SessionFileRef | null | undefined): boolean {
  if (!a || !b || a.sessionId !== b.sessionId) return false;
  return a.fileId && b.fileId ? a.fileId === b.fileId : a.name === b.name && a.folder === b.folder;
}
export async function listSessionFiles(sessionId: string): Promise<SessionFile[]> {
  return (await apiGet<{ files: SessionFile[] }>(`/api/console/sessions/${encodeURIComponent(sessionId)}/files`)).files;
}
export async function readSessionFile(ref: SessionFileRef): Promise<SessionFile> {
  try { return (await apiGet<{ file: SessionFile }>(sessionFilePath(ref))).file; }
  catch (error) {
    if ((error as { status?: number }).status === 404) throw new Error('This file is no longer where it was saved. Open All files to see what is available.');
    throw error;
  }
}
export async function readSessionFileImage(ref: SessionFileRef): Promise<string> {
  const answer = await apiGet<{ image: string; mimeType: string }>(sessionFilePath(ref, 'image'));
  return `data:${answer.mimeType};base64,${answer.image}`;
}
export async function readSessionFileBlob(ref: SessionFileRef, download = false): Promise<Blob> {
  const response = await fetch(withToken(sessionFilePath(ref, 'content') + (download ? '&download=1' : '')), { credentials: 'same-origin' });
  if (response.status === 401) window.dispatchEvent(new Event('clem:needs-login'));
  if (!response.ok) throw new Error(response.status === 413 ? 'This file is too large to preview or download here. Open it in its app.' : 'The file could not be opened. Try again.');
  return response.blob();
}
export async function openSessionFile(ref: SessionFileRef): Promise<void> { await apiPost(sessionFilePath(ref, 'open')); }
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
