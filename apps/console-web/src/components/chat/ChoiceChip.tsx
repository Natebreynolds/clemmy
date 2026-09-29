/**
 * A chip beside the composer that opens a short list to choose from: who
 * answers, which project applies. One behaviour for every such chip.
 *
 * The popover is drawn at the top of the page and placed against the window
 * (lib/popover-placement.ts), the same way the model chip is, so it survives
 * the narrow scrolling places the composer lives in.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { placePopover } from '@/lib/popover-placement';

const POPOVER_WIDTH = 320;

export const CHOICE_CHIP = 'inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-2 pr-2.5 text-small font-semibold text-fg shadow-xs';

export interface ChoiceRow {
  key: string;
  name: string;
  note?: string;
  /** The choice in force. */
  on: boolean;
  onPick: () => void;
}

export function ChoiceChip({
  icon: Icon,
  label,
  chosen,
  title,
  heading,
  note,
  rows,
  footer,
  className,
}: {
  icon: LucideIcon;
  /** What the chip says: the choice in force. */
  label: string;
  /** False while the chip shows the plain default. */
  chosen: boolean;
  title: string;
  /** The popover's name, read out and shown as its heading. */
  heading: string;
  note: string;
  rows: ChoiceRow[];
  footer?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) chipRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const chip = chipRef.current;
    if (!chip) return;
    const a = chip.getBoundingClientRect();
    const p = placePopover({
      anchor: { top: a.top, bottom: a.bottom, left: a.left, right: a.right },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      preferredWidth: POPOVER_WIDTH,
      contentHeight: popRef.current?.scrollHeight ?? 0,
    });
    setStyle({
      position: 'fixed',
      left: p.left,
      width: p.width,
      maxHeight: p.maxHeight,
      ...(p.side === 'above' ? { bottom: p.bottom } : { top: p.top }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setStyle(null); return; }
    place();
    const pop = popRef.current;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (pop && observer) observer.observe(pop);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const inside = (node: Node | null) => Boolean(node && (rootRef.current?.contains(node) || popRef.current?.contains(node)));
    const onDoc = (e: MouseEvent) => { if (!inside(e.target as Node)) close(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    const onFocus = (e: FocusEvent) => { if (!inside(e.target as Node)) close(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${heading}: ${label}`}
        title={title}
        className={cn(CHOICE_CHIP, 'max-w-full transition-colors hover:border-border-strong', !chosen && 'text-muted')}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', chosen ? 'text-primary' : 'text-faint')} aria-hidden />
        {/* Never narrower than a short name: a chip that shrinks to its icon says nothing. */}
        <span className="min-w-[2.75rem] max-w-[150px] truncate text-left">{label}</span>
        <ChevronUp className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label={heading}
          tabIndex={-1}
          style={style ?? { position: 'fixed', visibility: 'hidden', width: POPOVER_WIDTH }}
          className="z-[120] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border bg-surface pb-1 pt-2 shadow-lg outline-none"
        >
          <div className="px-4 pb-2">
            <span className="block text-small font-semibold text-fg">{heading}</span>
            <span className="block text-caption text-faint">{note}</span>
          </div>
          <div className="mx-2 mb-1 rounded-md bg-subtle">
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                aria-pressed={row.on}
                onClick={() => { row.onPick(); close(true); }}
                className={cn('grid w-full grid-cols-[1fr_auto] items-center gap-2.5 px-3 py-1.5 text-left text-small transition-colors hover:bg-hover', row.on && 'font-semibold')}
              >
                <span className="min-w-0">
                  <span className="block truncate">{row.name}</span>
                  {row.note && <span className="block truncate font-normal text-caption text-faint">{row.note}</span>}
                </span>
                <span className="text-caption text-success">{row.on ? 'current' : ''}</span>
              </button>
            ))}
          </div>
          {footer && <div className="border-t border-border px-4 pb-1 pt-2 text-caption text-faint">{footer}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
