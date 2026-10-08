/**
 * Pages made in a project, as the phone looks at one.
 *
 * Nothing a page contains is ever run on the phone. The Mac renders the page
 * at the phone's width and sends pictures, one part of the page at a time,
 * and the viewer is a column of those pictures. What a page is called, where
 * it is, where the next part starts and how a refusal is said are the shared
 * engine's (@clem/chat-engine). What lives here is only what the phone does
 * with what the Mac answers: read one part, decide which width to ask for,
 * and decide what stands below the last part.
 *
 * An answer this build cannot read is no part at all, never half a picture.
 */
import { projectPageNextOffset, projectPageRefusal, type ProjectPageImage } from '@clem/chat-engine';
import { refusalWords } from './project-words';

/** The widths a page is rendered at for a phone, and the one asked for when nothing was measured. */
export const PAGE_WIDTH_LEAST = 360;
export const PAGE_WIDTH_MOST = 430;
export const PAGE_WIDTH_USUAL = 390;

/** The only kind of picture the viewer draws. */
const PAGE_IMAGE_TYPE = 'image/png';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const PAGE_RENDERING_WORDS = 'Rendering the next part on your computer…';
export const PAGE_MORE_WORDS = 'Show more of the page';
export const PAGE_ENDED_WORDS = 'End of the page.';
export const PAGE_LIMIT_WORDS = 'This is as much as is shown here. Open the page on your computer to see the rest.';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The width to ask the Mac for, from the width the viewer measured. */
export function pageWidthFor(measured: unknown): number {
  if (!finite(measured) || measured <= 0) return PAGE_WIDTH_USUAL;
  return Math.min(PAGE_WIDTH_MOST, Math.max(PAGE_WIDTH_LEAST, Math.round(measured)));
}

/** One part of a page as the Mac sent it, or null when it cannot be read as one. */
export function readPageImage(value: unknown): ProjectPageImage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.image !== 'string' || !BASE64.test(raw.image)) return null;
  if (raw.mimeType !== PAGE_IMAGE_TYPE) return null;
  if (!finite(raw.width) || raw.width <= 0 || !finite(raw.height) || raw.height <= 0) return null;
  if (!finite(raw.offsetY) || raw.offsetY < 0) return null;
  return {
    image: raw.image,
    mimeType: PAGE_IMAGE_TYPE,
    width: raw.width,
    height: raw.height,
    offsetY: raw.offsetY,
    // Only an explicit yes says the page ended above this part.
    end: raw.end === true,
  };
}

/** What an <img> shows for one part. The kind is this build's, never the answer's. */
export function pageImageSource(part: Pick<ProjectPageImage, 'image'>): string {
  return `data:${PAGE_IMAGE_TYPE};base64,${part.image}`;
}

/**
 * One part as the viewer keeps it: where it lies, and the picture as the
 * source it is drawn from. The picture is kept once, and a part that shows
 * nothing keeps none.
 */
export interface PagePart {
  src: string;
  width: number;
  height: number;
  offsetY: number;
  end: boolean;
}

export function pagePart(image: ProjectPageImage): PagePart {
  return {
    src: image.end ? '' : pageImageSource(image),
    width: image.width,
    height: image.height,
    offsetY: image.offsetY,
    end: image.end,
  };
}

/** The parts that are drawn: every part but one that shows nothing. */
export function drawnPageParts<T extends { end: boolean }>(parts: readonly T[]): T[] {
  return parts.filter((part) => !part.end);
}

export function pagePartLabel(index: number, title: string): string {
  return `Part ${index + 1} of the page ${title}`;
}

export type PageFooter = 'loading' | 'more' | 'ended' | 'limit' | 'error';

/** What stands below the last drawn part. */
export function pageFooter(
  parts: ReadonlyArray<Pick<ProjectPageImage, 'offsetY' | 'height' | 'end'>>,
  loading: boolean,
  error: unknown,
): PageFooter {
  if (loading) return 'loading';
  if (error) return 'error';
  if (projectPageNextOffset(parts) !== null) return 'more';
  return parts[parts.length - 1]?.end ? 'ended' : 'limit';
}

/**
 * Whether the reader is close enough to the end of what is drawn to ask for
 * the next part: within one screen height of the bottom of the last part.
 */
export function pageNearEnd(distance: number, screenHeight: number): boolean {
  if (!finite(distance) || !finite(screenHeight) || screenHeight <= 0) return false;
  return distance <= screenHeight;
}

export interface PageFailure {
  text: string;
  /** False when asking again cannot help: the page is gone. */
  retry: boolean;
}

/** What to say about a part that did not arrive, and whether asking again can help. */
export function pageFailure(error: unknown): PageFailure {
  const candidate = error as { offline?: boolean; body?: unknown } | null | undefined;
  if (candidate?.offline) return { text: refusalWords(error), retry: true };
  const body = candidate?.body as { error?: unknown } | null | undefined;
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  return { text: projectPageRefusal(code), retry: code.toUpperCase() !== 'PAGE_NOT_FOUND' };
}
