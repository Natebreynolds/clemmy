/**
 * The agent chip beside the composer: who answers the next message — Clem,
 * or one of the owner's saved agents. Like the model chip it can change at
 * any point in a conversation; the switch takes effect on the next message
 * (lib/conversation-agent). Inside an agent's own page the chip is a plain
 * label: that page is the agent.
 *
 * The popover is drawn at the top of the page and placed against the
 * window (lib/popover-placement.ts), the same way the model chip is, so it
 * survives the narrow scrolling places the composer lives in.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ChevronUp, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { listAgents, type AgentRecord, type ConversationAgent } from '@/lib/agents';
import { placePopover } from '@/lib/popover-placement';

const POPOVER_WIDTH = 320;

const CHIP = 'inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-2 pr-2.5 text-small font-semibold text-fg shadow-xs';

export function AgentPicker({
  value,
  onChange,
  started,
  bound,
  className,
}: {
  /** Who answers the next message, or null for Clem. */
  value?: ConversationAgent | null;
  onChange?: (agent: ConversationAgent | null) => void;
  /** The conversation already has messages: a pick changes who answers next. */
  started?: boolean;
  /** Inside an agent's own page: the chip only names it. */
  bound?: string | null;
  className?: string;
}) {
  // Read only while a choice can be made; a locked chip has no roster to fetch.
  const roster = usePoll(['agents'], listAgents, 30_000, { enabled: !bound });
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

  if (bound) {
    return (
      <span className={cn(CHIP, 'cursor-default', className)} title="This conversation works inside this agent">
        <Users className="h-3.5 w-3.5 text-muted" aria-hidden />
        <span className="max-w-[150px] truncate">{bound}</span>
      </span>
    );
  }

  const agents: AgentRecord[] = roster.data ?? [];
  // Nothing to choose from yet: the composer stays as it was.
  if (agents.length === 0 && !value) return null;
  // A chosen agent that is no longer saved still shows by name until changed.
  const current = value ? agents.find((a) => a.id === value.id) ?? value : null;
  const label = current?.name ?? 'Clem';

  const pick = (chosen: AgentRecord | null) => {
    onChange?.(chosen ? { id: chosen.id, name: chosen.name } : null);
    close(true);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={started ? 'Who answers your next message' : 'Who answers this conversation'}
        className={cn(CHIP, 'transition-colors hover:border-border-strong', !current && 'text-muted')}
      >
        <Users className={cn('h-3.5 w-3.5', current ? 'text-primary' : 'text-faint')} aria-hidden />
        <span className="max-w-[150px] truncate">{label}</span>
        <ChevronUp className={cn('h-3.5 w-3.5 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Who answers"
          tabIndex={-1}
          style={style ?? { position: 'fixed', visibility: 'hidden', width: POPOVER_WIDTH }}
          className="z-[120] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border bg-surface pb-1 pt-2 shadow-lg outline-none"
        >
          <div className="px-4 pb-2">
            <span className="block text-small font-semibold text-fg">Who answers</span>
            <span className="block text-caption text-faint">
              {started ? 'Switch any time. Takes effect on your next message.' : 'Switch any time in the conversation.'}
            </span>
          </div>
          <div className="mx-2 mb-1 rounded-md bg-subtle">
            <Row on={!current} name="Clem" note="As usual, no agent's instructions" onPick={() => pick(null)} />
            {agents.map((a) => (
              <Row key={a.id} on={a.id === current?.id} name={a.name} note={agentNote(a)} onPick={() => pick(a)} />
            ))}
          </div>
          <div className="border-t border-border px-4 pb-1 pt-2 text-caption text-faint">
            <Link to="/agents" className="underline underline-offset-2 hover:text-muted">All agents</Link>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** What the agent handles, and the model its helpers run on when it names one
 *  (the conversation itself keeps the model chip's choice). */
function agentNote(agent: AgentRecord): string {
  const helpers = agent.model ? `helpers on ${agent.model}` : '';
  return [agent.handles, helpers].filter(Boolean).join(' · ');
}

function Row({ on, name, note, onPick }: { on: boolean; name: string; note?: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn('grid w-full grid-cols-[1fr_auto] items-center gap-2.5 px-3 py-1.5 text-left text-small transition-colors hover:bg-hover', on && 'font-semibold')}
    >
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        {note && <span className="block truncate font-normal text-caption text-faint">{note}</span>}
      </span>
      <span className="text-caption text-success">{on ? 'current' : ''}</span>
    </button>
  );
}
