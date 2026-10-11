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
  /** Exact bytes available when this preview was opened. */
  revision?: string;
  text?: string;
  previewHtml?: string;
  truncated?: boolean;
  openable: boolean;
}
export interface SessionFileRef { sessionId: string; name: string; folder: string; fileId?: string }
export function sessionFilePath(ref: SessionFileRef, part: '' | 'image' | 'open' | 'content' | 'context' = '', expectedRevision?: string): string {
  const query = new URLSearchParams({ name: ref.name, folder: ref.folder });
  if (ref.fileId) query.set('fileId', ref.fileId);
  if (expectedRevision) query.set('expectedRevision', expectedRevision);
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
export async function readSessionFileImage(ref: SessionFileRef, expectedRevision?: string): Promise<string> {
  const answer = await apiGet<{ image: string; mimeType: string }>(sessionFilePath(ref, 'image', expectedRevision));
  return `data:${answer.mimeType};base64,${answer.image}`;
}
export async function readSessionFileBlob(ref: SessionFileRef, download = false, expectedRevision?: string): Promise<Blob> {
  const response = await fetch(withToken(sessionFilePath(ref, 'content', expectedRevision) + (download ? '&download=1' : '')), { credentials: 'same-origin' });
  if (response.status === 401) window.dispatchEvent(new Event('clem:needs-login'));
  if (!response.ok) throw new Error(response.status === 409 ? 'This file changed. Reload it to review the current version.' : response.status === 413 ? 'This file is too large to preview or download here. Open it in its app.' : 'The file could not be opened. Try again.');
  return response.blob();
}
export async function openSessionFile(ref: SessionFileRef): Promise<void> { await apiPost(sessionFilePath(ref, 'open')); }
export async function prepareSessionFileContext(ref: SessionFileRef, expectedRevision: string): Promise<{ id: string; name: string }> {
  try {
    return await apiPost(sessionFilePath(ref, 'context'), { fileId: ref.fileId, expectedRevision });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) throw new Error('This file changed since you opened it. Reload the file, then choose Ask Clem about this again. Your message is still here.');
    if (status === 404) throw new Error('This saved file is no longer available. Choose another file or remove it from your message.');
    if (status === 413) throw new Error('This file is too large to add here. Remove it and tell Clem which part you want to work on.');
    throw new Error('The selected file could not be added. Your message is still here; try again.');
  }
}
export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
