/**
 * The model chip beside the composer (owner-approved mockup, 2026-09-08): who
 * answers, who helps, who checks — changeable mid-conversation. Brain switches
 * write the same setting mobile's chip writes and re-pin THIS conversation;
 * workers and judge are global today and the popover says so.
 *
 * The popover is drawn at the top of the page and placed against the WINDOW
 * (lib/popover-placement.ts): the composer also lives in narrow, scrolling
 * places — a Space's 400px Ask Clem dock — whose overflow cut a 420px card
 * off, and the desktop app cannot paint past its own window edge.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ChevronUp, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';
import { PROVIDER_LABEL, roleLabel, shortModelLabel, useModelRoles, type BrainChoice } from '@/lib/model-roles';
import { ClaudeLoginForm } from '@/screens/settings/ClaudeLoginForm';
import { placePopover } from '@/lib/popover-placement';

const POPOVER_WIDTH = 420;

const ROLE_ROW = 'grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2';
const ROLE_TRIGGER = 'flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md bg-subtle px-2.5 text-small font-semibold text-fg hover:bg-hover disabled:opacity-60';

function RoleSelect({
  label,
  title,
  disabled,
  value,
  onChange,
  children,
}: {
  label: string;
  title?: string;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label={label}
        title={title}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full min-w-0 appearance-none truncate rounded-md border-0 bg-subtle py-1.5 pl-2.5 pr-8 text-small font-semibold text-fg focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
      >
        {children}
      </select>
      <ChevronUp className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-180 text-faint" aria-hidden />
    </div>
  );
}

function dotColor(provider: string): string {
  const key = provider === 'byo' ? 'byo' : provider === 'glm' ? 'glm' : provider;
  return PROVIDER_DOT[(key as keyof typeof PROVIDER_DOT)] ?? PROVIDER_DOT.unknown;
}

function Roster({ rows, value, busy, onPick }: { rows: BrainChoice[]; value: string; busy: boolean; onPick: (v: string) => void }) {
  const groups = new Map<string, BrainChoice[]>();
  for (const r of rows) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  // Signed-in providers first: the roster opens on what can actually be picked.
  const ordered = [...groups.entries()].sort((a, b) => Number(b[1].some((r) => r.available)) - Number(a[1].some((r) => r.available)));
  return (
    <div className="mx-4 mb-2 max-h-60 overflow-y-auto rounded-md bg-subtle">
      {ordered.map(([provider, list]) => (
        <div key={provider}>
          <div className="px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{PROVIDER_LABEL[provider] ?? provider}</div>
          {list.map((r) => {
            const on = r.value === value;
            return (
              <button
                key={r.value}
                type="button"
                disabled={busy || !r.available}
                onClick={() => onPick(r.value)}
                className={cn('grid w-full grid-cols-[auto_1fr_auto] items-center gap-2.5 px-3 py-1.5 text-left text-small transition-colors hover:bg-hover disabled:cursor-default', on && 'font-semibold', !r.available && 'text-faint hover:bg-transparent')}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotColor(r.provider) }} aria-hidden />
                <span className="truncate">{shortModelLabel(r.label)}{r.note && <span className="ml-1.5 font-normal text-faint">{r.note}</span>}</span>
                <span className="text-caption text-success">{on ? 'current' : ''}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function ModelPicker({ sessionId, className }: { sessionId?: string; className?: string }) {
  const roles = useModelRoles({ sessionId });
  const [open, setOpen] = useState(false);
  const [roster, setRoster] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  // The brain the owner last picked here, held until the saved settings are
  // read back: "Saved" is only said when the daemon reports that same brain.
  const [picked, setPicked] = useState<string | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setRoster(false);
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
    // Content grows (the brain roster, a sign-in form): place again.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (pop && observer) observer.observe(pop);
    window.addEventListener('resize', place);
    // Any scrolling ancestor moves the chip; follow it.
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place, roster, roles.claudeSignInFor]);

  useEffect(() => {
    if (!open) return;
    // Focus moves into the card so the keyboard can reach it; the portal sits
    // at the end of the page, so Tab order alone would never get there.
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

  const mr = roles.mr;
  // Read-back of a brain change: compare what the daemon now reports.
  const brainMismatch = picked !== null && roles.saved === 'brain' && !roles.fetching && roles.brainValue !== picked;
  useEffect(() => {
    if (picked !== null && roles.saved === 'brain' && !roles.fetching && roles.brainValue === picked) setPicked(null);
  }, [picked, roles.saved, roles.fetching, roles.brainValue]);
  if (!mr) return null;
  const brain = shortModelLabel(roleLabel(mr, 'brain'));
  const brainProv = mr.roles.brain.provider;
  const workerProv = mr.roles.worker.provider;
  const judgeProv = mr.roles.judge.provider;
  const busy = roles.busy !== null;
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={chipRef}
        type="button"
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Models for this conversation — who answers, who helps, who checks"
        className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-2 pr-2.5 text-small font-semibold text-fg shadow-xs transition-colors hover:border-border-strong"
      >
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotColor(brainProv) }} aria-hidden />
        <span className="max-w-[150px] truncate">{brain}</span>
        <span className="flex" aria-hidden>
          <span className="h-2 w-2 rounded-full ring-1 ring-surface" style={{ backgroundColor: dotColor(workerProv) }} />
          <span className="-ml-0.5 h-2 w-2 rounded-full ring-1 ring-surface" style={{ backgroundColor: dotColor(judgeProv) }} />
        </span>
        <ChevronUp className={cn('h-3.5 w-3.5 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Models for this conversation"
          tabIndex={-1}
          style={style ?? { position: 'fixed', visibility: 'hidden', width: POPOVER_WIDTH }}
          className="z-[120] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border bg-surface pb-1 pt-2 shadow-lg outline-none"
        >
          <div className={ROLE_ROW}>
            <span><span className="block text-small font-semibold text-fg">Brain</span><span className="block text-caption text-faint">{sessionId ? 'answers your next message' : 'answers new conversations'}</span></span>
            <button type="button" onClick={() => setRoster((v) => !v)} aria-expanded={roster} disabled={busy} title={brain} className={ROLE_TRIGGER}>
              <span className="inline-flex min-w-0 items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor(brainProv) }} aria-hidden /><span className="truncate">{brain}</span></span>
              <ChevronUp className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform', !roster && 'rotate-180')} aria-hidden />
            </button>
          </div>
          {roster && <Roster rows={roles.brains} value={roles.brainValue} busy={busy} onPick={(v) => { setRoster(false); setPicked(v); void roles.onBrain(v); }} />}
          {roles.claudeSignInFor && <div className="mx-4 mb-2"><ClaudeLoginForm embedded /></div>}
          <div className={cn(ROLE_ROW, 'border-t border-border')}>
            <span><span className="block text-small font-semibold text-fg">Workers</span><span className="block text-caption text-faint">helpers · everywhere</span></span>
            <RoleSelect
              label="Workers model"
              title={mr.roles.worker.source === 'default' ? 'Follow the brain' : `${roleLabel(mr, 'worker')} · ${PROVIDER_LABEL[workerProv] ?? workerProv}`}
              disabled={busy}
              value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId}
              onChange={(v) => void roles.onRole('worker', v)}
            >
              <option value="__default__">Follow the brain</option>
              {roles.workers.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
            </RoleSelect>
          </div>
          <div className={cn(ROLE_ROW, 'border-t border-border')}>
            <span><span className="block text-small font-semibold text-fg">Judge</span><span className="block text-caption text-faint">checks · everywhere</span></span>
            <RoleSelect
              label="Judge model"
              title={mr.roles.judge.source === 'default' ? 'Automatic · different family, fast' : `${roleLabel(mr, 'judge')} · ${PROVIDER_LABEL[judgeProv] ?? judgeProv}`}
              disabled={busy}
              value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId}
              onChange={(v) => void roles.onRole('judge', v)}
            >
              <option value="__default__">Automatic · different family, fast</option>
              {roles.judges.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
            </RoleSelect>
          </div>
          <div className="mt-1 flex items-start gap-2 border-t border-border px-4 pb-1 pt-2 text-caption text-faint">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            {/* A failed change is said in full, never truncated to a line. */}
            <span className="min-w-0 flex-1" role={roles.error || brainMismatch ? 'alert' : 'status'}>
              {roles.error ? <span className="text-danger">{roles.error}</span>
                : brainMismatch ? <span className="text-danger">That change didn’t take: Clem is still on {brain}. Try again, or check Settings.</span>
                : roles.saved && !roles.fetching ? <span className="text-success">Saved · takes effect on your next message</span>
                : busy || roles.fetching ? 'Switching…' : 'Takes effect on your next message.'}
            </span>
            <Link to="/settings#models" className="shrink-0 underline underline-offset-2 hover:text-muted">All settings</Link>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
