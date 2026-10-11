export interface VisibleViewport {
  top: number;
  height: number;
  bottomInset: number;
}

/** Geometry only: browser chrome, zoom and a keyboard can all reduce this area. */
export function visibleViewportBounds(layoutHeight: number, visual?: { height: number; offsetTop: number } | null): VisibleViewport {
  const fullHeight = Number.isFinite(layoutHeight) && layoutHeight > 0 ? layoutHeight : 1;
  if (!visual || !Number.isFinite(visual.height) || visual.height <= 0 || !Number.isFinite(visual.offsetTop)) {
    return { top: 0, height: fullHeight, bottomInset: 0 };
  }
  const top = Math.min(Math.max(0, visual.offsetTop), fullHeight - 1);
  const height = Math.min(visual.height, fullHeight - top);
  return { top, height, bottomInset: Math.round(Math.max(0, fullHeight - height - top)) };
}
