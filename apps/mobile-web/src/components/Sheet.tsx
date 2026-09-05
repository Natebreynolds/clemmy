/**
 * One bottom sheet for the app's floating choices.
 *
 * The dialog contract every sheet in the app already keeps, in one place:
 * a scrim that closes, Escape closes, focus lands inside on open and is
 * trapped while open, the opener gets focus back on close, and the body
 * scrolls inside the sheet so the page behind never moves.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useBackGesture } from '../lib/back-gesture';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Visible heading. Omit for a compact list sheet and pass `ariaLabel`. */
  title?: string;
  ariaLabel?: string;
  /** Small text at the heading's right edge. */
  aside?: ComponentChildren;
  footer?: ComponentChildren;
  /**
   * Register the iOS edge-swipe as "close". Off by default: a sheet whose
   * rows navigate between peer tabs must not mint a history entry, or the
   * swipe would undo the tab it just selected.
   */
  backGesture?: boolean;
  /** Extra class on the sheet surface (sizing per use). */
  class?: string;
  children: ComponentChildren;
}

let sheetSequence = 0;

export function Sheet({ open, onClose, title, ariaLabel, aside, footer, backGesture = false, class: extraClass, children }: Props) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = `sheet-${++sheetSequence}`;
  const titleId = `${idRef.current}-title`;
  // Hosts pass an inline closure; reading it through a ref keeps the focus
  // effect keyed to `open` alone, so a shell re-render (every poll tick)
  // can never pull focus out of a field the user is typing in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useBackGesture(backGesture && open, onClose);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the first real control, not the scrim, so a screen reader lands
    // on the choice rather than on "Close".
    window.requestAnimationFrame(() => {
      const first = sheetRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]):not(.sheet-scrim), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? sheetRef.current)?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div class="sheet-layer">
      <button class="sheet-scrim" type="button" aria-label="Close" onClick={onClose} />
      <section
        ref={sheetRef}
        class={`sheet${extraClass ? ` ${extraClass}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
      >
        <span class="sheet-handle" aria-hidden="true" />
        {title ? (
          <header class="sheet-head">
            <h2 id={titleId} class="sheet-title">{title}</h2>
            {aside ? <span class="sheet-aside">{aside}</span> : null}
          </header>
        ) : null}
        <div class="sheet-body">{children}</div>
        {footer ? <footer class="sheet-foot">{footer}</footer> : null}
      </section>
    </div>
  );
}
