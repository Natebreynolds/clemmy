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

export type ClementineLivePresentation = 'dormant' | 'panel';

export interface ClementineLiveLayoutRequest extends ClementineLiveSize {
  presentation: ClementineLivePresentation;
  /** Monotonic renderer-generated id used to reject late resize requests. */
  layoutId: number;
}

export const DEFAULT_CLEMENTINE_LIVE_SHORTCUT = 'CommandOrControl+Shift+Space';
export const DEFAULT_CLEMENTINE_LIVE_SIZE: Readonly<ClementineLiveSize> = Object.freeze({
  width: 326,
  height: 46,
});

/**
 * The dormant native window is deliberately just large enough to make the dog
 * easy to hit while still extending below the menu-bar inset. Keeping this as
 * an exact, always-interactive window avoids the unreliable macOS transition
 * from click-through to interactive at the top edge of the display.
 */
export const DEFAULT_CLEMENTINE_LIVE_DORMANT_SIZE: Readonly<ClementineLiveSize> = Object.freeze({
  width: 62,
  height: 48,
});

// A dormant blended notch tab is roughly the width/height of the physical notch,
// so the minimums are small enough to allow it while still rejecting degenerate
// renderer requests. The expanded panel drives the larger sizes.
const MIN_WIDTH = 48;
const MIN_HEIGHT = 28;
const MAX_WIDTH = 720;
const MAX_HEIGHT = 720;
const EDGE_GAP = 8;
const NOTCH_INSET_THRESHOLD = 32;
const NOTCHED_DORMANT_CENTER_OFFSET = 118;
const PANEL_SHADOW_MARGIN_X = 16;
const PANEL_SHADOW_MARGIN_BOTTOM = 24;

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
  presentation?: ClementineLivePresentation;
  /** Exact NSScreen safe-area inset when the native helper is available. */
  topInsetOverride?: number | null;
}): ClementineLiveGeometry {
  const bounds = input.bounds;
  const workArea = input.workArea;
  const inferredTopInset = Math.max(0, Math.round(workArea.y - bounds.y));
  const topInset = Number.isFinite(input.topInsetOverride)
    ? Math.max(inferredTopInset, Math.round(input.topInsetOverride ?? 0))
    : inferredTopInset;
  const likelyNotched = topInset >= NOTCH_INSET_THRESHOLD;
  // TRUE NOTCH (Stage 1): anchor at the very TOP edge of the display so the
  // surface hangs from the physical notch / menu-bar region and grows DOWNWARD,
  // like a native macOS notch app. main.ts raises the window level above the menu
  // bar so this top strip is actually drawn. The renderer drives the size — a
  // slim blended tab (~notch-sized) when dormant, a tall panel when expanded —
  // and we only anchor it to the top and center it horizontally (the built-in
  // notch is centered on the display). The centered dormant tab is kept near the
  // physical notch width so it reads as part of the notch and never covers the
  // menu items that flow to either side of it.
  const y = Math.round(bounds.y);
  // The surface may grow downward from the top edge, but an expanded panel must
  // still stop short of the Dock — so the height budget runs from the top down to
  // the work-area bottom (which excludes a bottom Dock), never the raw display
  // bottom. The menu-bar inset at the top is intentionally spanned.
  const safeBottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height);
  const availableHeight = Math.max(MIN_HEIGHT, Math.round(safeBottom - y - EDGE_GAP));
  const size = normalizeClementineLiveSize(input.requestedSize, {
    width: bounds.width,
    height: availableHeight,
  });
  const presentation = input.presentation ?? 'panel';
  const windowWidth = presentation === 'panel'
    ? Math.min(Math.round(bounds.width), size.width + (PANEL_SHADOW_MARGIN_X * 2))
    : size.width;
  const minX = Math.round(bounds.x);
  const maxX = Math.round(bounds.x + bounds.width - windowWidth);
  // A real MacBook notch occupies the display center. The dormant Clementine
  // dog lives immediately to its left, while every expanded presentation stays
  // centered and grows downward from the notch. Electron does not expose
  // NSScreen.auxiliaryTopLeftArea, so this offset is the startup fallback. The
  // native click helper reports the exact per-display hardware boundary and
  // main.ts replaces this anchor as soon as it is available. Non-notched
  // displays stay centered.
  const dormantOffset = presentation === 'dormant' && likelyNotched
    ? NOTCHED_DORMANT_CENTER_OFFSET
    : 0;
  const centeredX = Math.round(bounds.x + ((bounds.width - windowWidth) / 2) - dormantOffset);
  const x = maxX >= minX ? clamp(centeredX, minX, maxX) : Math.round(bounds.x);
  // The WINDOW spans the notch inset PLUS the requested surface height. This does
  // two things: (1) it keeps the window from being clamped below the menu bar —
  // macOS refuses to place a window that fits ENTIRELY inside the inset (height
  // ≤ topInset) at y=0, but allows one that extends past it; (2) the renderer pads
  // its content down by topInset (delivered via shell-state) so the visible surface
  // hangs just under the physical notch, connected to it, not floating below the
  // whole bar. Height is still clamped so an expanded panel stops short of the Dock.
  // The dormant frame already extends below the menu-bar inset and draws its dog
  // inside that strip, so adding the inset would only create a dead transparent
  // click target. Expanded panels pad their content below the physical notch and
  // therefore need the inset included in the native window height.
  const desiredWindowHeight = presentation === 'dormant'
    ? Math.max(size.height, topInset + 1)
    : size.height + topInset + PANEL_SHADOW_MARGIN_BOTTOM;
  const windowHeight = Math.min(desiredWindowHeight, Math.round(safeBottom - y));
  return { x, y, width: windowWidth, height: windowHeight, likelyNotched, topInset };
}
