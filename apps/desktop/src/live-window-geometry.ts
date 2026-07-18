export interface ClementineLiveSize {
  width: number;
  height: number;
}

export interface ClementineLiveRect extends ClementineLiveSize {
  x: number;
  y: number;
}

export interface ClementineLiveGeometry extends ClementineLiveRect {
  /** Best-effort inference from the menu-bar safe area, not a hardware claim. */
  likelyNotched: boolean;
  topInset: number;
}

export const DEFAULT_CLEMENTINE_LIVE_SHORTCUT = 'CommandOrControl+Shift+Space';
export const DEFAULT_CLEMENTINE_LIVE_SIZE: Readonly<ClementineLiveSize> = Object.freeze({
  width: 326,
  height: 46,
});

const MIN_WIDTH = 240;
const MIN_HEIGHT = 40;
const MAX_WIDTH = 720;
const MAX_HEIGHT = 720;
const EDGE_GAP = 8;
const NOTCH_INSET_THRESHOLD = 32;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function resolveClementineLiveShortcut(value?: string | null): string {
  const configured = value?.trim();
  return configured || DEFAULT_CLEMENTINE_LIVE_SHORTCUT;
}

export function normalizeClementineLiveSize(
  requested?: Partial<ClementineLiveSize> | null,
  available?: Partial<ClementineLiveSize> | null,
): ClementineLiveSize {
  const availableWidth = Math.max(MIN_WIDTH, Math.floor(finiteOr(available?.width ?? MAX_WIDTH, MAX_WIDTH)) - (EDGE_GAP * 2));
  const availableHeight = Math.max(MIN_HEIGHT, Math.floor(finiteOr(available?.height ?? MAX_HEIGHT, MAX_HEIGHT)) - EDGE_GAP);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth));
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, availableHeight));
  return {
    width: Math.round(clamp(finiteOr(requested?.width ?? DEFAULT_CLEMENTINE_LIVE_SIZE.width, DEFAULT_CLEMENTINE_LIVE_SIZE.width), MIN_WIDTH, maxWidth)),
    height: Math.round(clamp(finiteOr(requested?.height ?? DEFAULT_CLEMENTINE_LIVE_SIZE.height, DEFAULT_CLEMENTINE_LIVE_SIZE.height), MIN_HEIGHT, maxHeight)),
  };
}

export function computeClementineLiveGeometry(input: {
  bounds: ClementineLiveRect;
  workArea: ClementineLiveRect;
  requestedSize?: Partial<ClementineLiveSize> | null;
}): ClementineLiveGeometry {
  const bounds = input.bounds;
  const workArea = input.workArea;
  const topInset = Math.max(0, Math.round(workArea.y - bounds.y));
  const likelyNotched = topInset >= NOTCH_INSET_THRESHOLD;
  // The surface starts below the menu bar/camera safe area. Constrain its
  // height to the space remaining below that actual y-coordinate so a short
  // display cannot place the bottom of an expanded surface off-screen.
  const y = Math.round(Math.max(bounds.y, workArea.y) + EDGE_GAP);
  const safeBottom = Math.min(
    bounds.y + bounds.height,
    workArea.y + workArea.height,
  );
  const availableHeightBelowSafeArea = Math.max(
    MIN_HEIGHT,
    Math.round(safeBottom - y),
  );
  const size = normalizeClementineLiveSize(input.requestedSize, {
    width: bounds.width,
    height: availableHeightBelowSafeArea,
  });
  const minX = Math.round(bounds.x + EDGE_GAP);
  const maxX = Math.round(bounds.x + bounds.width - size.width - EDGE_GAP);
  const centeredX = Math.round(bounds.x + ((bounds.width - size.width) / 2));
  const x = maxX >= minX ? clamp(centeredX, minX, maxX) : Math.round(bounds.x);
  // Stage 0 deliberately stays below the system safe area. The work-area
  // inset tells us that a menu bar/cutout exists, but not the notch's exact
  // horizontal geometry; placing centered controls at bounds.y could hide
  // them behind the camera housing. A future native NSScreen bridge can use
  // auxiliaryTopLeft/RightArea once we intentionally wrap the physical notch.
  return { x, y, ...size, likelyNotched, topInset };
}
