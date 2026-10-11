import { api, apiBlob, type ApiError } from './api';

export type SessionFileKind = 'markdown' | 'text' | 'image' | 'html' | 'pdf' | 'other';
export interface SessionFile {
  fileId: string;
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

export type SessionFileRef = Pick<SessionFile, 'fileId' | 'name' | 'folder'> & { sessionId: string };

export function sessionFilePath(sessionId: string, file: Pick<SessionFile, 'fileId' | 'name' | 'folder'>, content = false, download = false): string {
  const query = new URLSearchParams({ name: file.name, folder: file.folder, fileId: file.fileId });
  if (download) query.set('download', '1');
  return `/m/api/chat/sessions/${encodeURIComponent(sessionId)}/file${content ? '/content' : ''}?${query}`;
}

export async function listSessionFiles(sessionId: string, signal?: AbortSignal): Promise<SessionFile[]> {
  return (await api<{ files: SessionFile[] }>(`/m/api/chat/sessions/${encodeURIComponent(sessionId)}/files`, { signal, cache: 'no-store' })).files;
}

export async function readSessionFile(sessionId: string, file: Pick<SessionFile, 'fileId' | 'name' | 'folder'>, signal?: AbortSignal): Promise<SessionFile> {
  return (await api<{ file: SessionFile }>(sessionFilePath(sessionId, file), { signal, cache: 'no-store' })).file;
}

export function readSessionFileContent(sessionId: string, file: Pick<SessionFile, 'fileId' | 'name' | 'folder'>, signal?: AbortSignal, download = false): Promise<Blob> {
  return apiBlob(sessionFilePath(sessionId, file, true, download), { signal, cache: 'no-store' });
}

export function fileSizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileKindWords(kind: SessionFileKind): string {
  return { markdown: 'Document', text: 'Text', image: 'Image', html: 'HTML', pdf: 'PDF', other: 'File' }[kind];
}

/** The sandbox disables scripts, forms and same-origin access. This policy
 * also blocks remote images, styles, frames and other background requests. */
export function filePreviewHtml(html: string): string {
  return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; base-uri \'none\'; form-action \'none\'; frame-src \'none\'"><meta name="referrer" content="no-referrer">' + html;
}

export function sessionFileProblem(error: unknown): string {
  const failure = error as ApiError;
  if (failure?.offline) return 'Your computer is unreachable. Reconnect and try again.';
  if (failure?.status === 404) return 'This file is no longer where it was saved. Return to the list and refresh it.';
  if (failure?.status === 413) return 'This file is too large to open on your phone. Open it on your computer.';
  if (failure?.status === 415) return 'This file type can only be opened on your computer.';
  return 'The file could not be opened. Try again.';
}
