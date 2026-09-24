/**
 * Where a popover anchored to a control fits inside the window it is drawn
 * in. The desktop app is an Electron window: nothing can paint past its
 * bounds, so a popover that "fits the design" but not the window is cut off
 * whatever its z-index. Every number here is window pixels.
 */
export interface AnchorRect { top: number; bottom: number; left: number; right: number }
export interface Viewport { width: number; height: number }

export interface PopoverPlacement {
  side: 'above' | 'below';
  /** Left edge, window pixels. */
  left: number;
  /** Set when the popover opens above: distance from the window's bottom edge. */
  bottom?: number;
  /** Set when the popover opens below: distance from the window's top edge. */
  top?: number;
  width: number;
  /** The popover scrolls inside this height rather than leaving the window. */
  maxHeight: number;
}

export function placePopover(input: {
  anchor: AnchorRect;
  viewport: Viewport;
  /** The width the design asks for; narrower windows get less. */
  preferredWidth: number;
  /** The popover's natural height, when known (0 before the first measure). */
  contentHeight: number;
  /** Space kept clear of the window edge. */
  margin?: number;
  /** Space between the control and the popover. */
  gap?: number;
  prefer?: 'above' | 'below';
}): PopoverPlacement {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 8;
  const { anchor, viewport } = input;
  const width = Math.max(0, Math.min(input.preferredWidth, viewport.width - margin * 2));
  // Right-aligned to the control (it sits at the end of the composer row),
  // then pulled back inside the window on either side.
  const left = Math.min(Math.max(anchor.right - width, margin), Math.max(margin, viewport.width - margin - width));

  const spaceAbove = Math.max(0, anchor.top - gap - margin);
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const need = input.contentHeight;
  const prefer = input.prefer ?? 'above';
  const fitsPreferred = prefer === 'above' ? need <= spaceAbove : need <= spaceBelow;
  const side: 'above' | 'below' = fitsPreferred
    ? prefer
    : (prefer === 'above' ? (spaceBelow > spaceAbove ? 'below' : 'above') : (spaceAbove > spaceBelow ? 'above' : 'below'));
  const maxHeight = side === 'above' ? spaceAbove : spaceBelow;
  return side === 'above'
    ? { side, left, bottom: viewport.height - anchor.top + gap, width, maxHeight }
    : { side, left, top: anchor.bottom + gap, width, maxHeight };
}
