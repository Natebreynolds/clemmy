import type { SessionFileRef } from './session-files';

export interface ArtifactReadingState {
  source: boolean;
  pdfPage: number;
  pdfZoom: number | 'fit';
  pdfTextView: boolean;
  scroll: Record<string, { top: number; left: number }>;
}

// Reading position belongs to the file, so opening it from Made, a project or
// its conversation resumes the same place. Keep only UI state in this window;
// neither document contents nor credentials are persisted.
const positions = new Map<string, ArtifactReadingState>();
const EMPTY: ArtifactReadingState = { source: false, pdfPage: 1, pdfZoom: 'fit', pdfTextView: false, scroll: {} };
const MAX_FILES = 160;

export function artifactReadingKey(ref: SessionFileRef): string {
  return ref.fileId ? `file:${ref.fileId}` : JSON.stringify([ref.sessionId, ref.folder, ref.name]);
}

export function readArtifactReadingState(key: string): ArtifactReadingState {
  const state = positions.get(key) ?? EMPTY;
  return { ...state, scroll: { ...state.scroll } };
}

export function rememberArtifactReadingState(key: string, change: Partial<ArtifactReadingState>): void {
  const previous = positions.get(key) ?? EMPTY;
  const scroll = { ...previous.scroll, ...change.scroll };
  // A long PDF can have many page/zoom combinations. Keep a bounded trail.
  for (const view of Object.keys(scroll).slice(0, -24)) delete scroll[view];
  const next = { ...previous, ...change, scroll };
  next.pdfPage = Number.isFinite(next.pdfPage) ? Math.max(1, Math.floor(next.pdfPage)) : 1;
  if (next.pdfZoom !== 'fit' && (![.5, .75, 1, 1.25, 1.5, 2].includes(next.pdfZoom))) next.pdfZoom = 'fit';
  positions.delete(key);
  positions.set(key, next);
  if (positions.size > MAX_FILES) positions.delete(positions.keys().next().value!);
}
