/**
 * The model chip beside the composer (owner-approved mockup, 2026-09-08): who
 * answers, who helps, who checks — changeable mid-conversation. Brain switches
 * write the same setting mobile's chip writes and re-pin THIS conversation;
 * workers and judge are global today and the popover says so.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronUp, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';
import { PROVIDER_LABEL, roleLabel, shortModelLabel, useModelRoles, type BrainChoice } from '@/lib/model-roles';
import { ClaudeLoginForm } from '@/screens/settings/ClaudeLoginForm';

function dotColor(provider: string): string {
  const key = provider === 'byo' ? 'byo' : provider === 'glm' ? 'glm' : provider;
  return PROVIDER_DOT[(key as keyof typeof PROVIDER_DOT)] ?? PROVIDER_DOT.unknown;
}

function Roster({ rows, value, busy, onPick }: { rows: BrainChoice[]; value: string; busy: boolean; onPick: (v: string) => void }) {
  const groups = new Map<string, BrainChoice[]>();
  for (const r of rows) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  return (
    <div className="mx-4 mb-2 max-h-60 overflow-y-auto rounded-md bg-subtle">
      {[...groups.entries()].map(([provider, list]) => (
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
                <span className="truncate">{r.label}{r.note && <span className="ml-1.5 font-normal text-faint">{r.note}</span>}</span>
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
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const mr = roles.mr;
  if (!mr) return null;
  const brain = shortModelLabel(roleLabel(mr, 'brain'));
  const brainProv = mr.roles.brain.provider;
  const workerProv = mr.roles.worker.provider;
  const judgeProv = mr.roles.judge.provider;
  const busy = roles.busy !== null;
  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
      {open && (
        <div role="dialog" aria-label="Models for this conversation" className="absolute bottom-full right-0 z-30 mb-2 w-[420px] rounded-lg border border-border bg-surface pb-1 pt-2 shadow-lg">
          <div className="grid grid-cols-[84px_1fr] items-center gap-3 px-4 py-2">
            <span><span className="block text-small font-semibold text-fg">Brain</span><span className="block text-caption text-faint">{sessionId ? 'answers your next message' : 'answers new conversations'}</span></span>
            <button type="button" onClick={() => setRoster((v) => !v)} aria-expanded={roster} disabled={busy} className="inline-flex items-center justify-between gap-2 rounded-md bg-subtle px-2.5 py-1.5 text-small font-semibold text-fg hover:bg-hover">
              <span className="inline-flex min-w-0 items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotColor(brainProv) }} aria-hidden /><span className="truncate">{brain}</span></span>
              <ChevronUp className={cn('h-3.5 w-3.5 text-faint transition-transform', !roster && 'rotate-180')} aria-hidden />
            </button>
          </div>
          {roster && <Roster rows={roles.brains} value={roles.brainValue} busy={busy} onPick={(v) => { setRoster(false); void roles.onBrain(v); }} />}
          {roles.claudeSignInFor && <div className="mx-4 mb-2"><ClaudeLoginForm embedded /></div>}
          <div className="grid grid-cols-[84px_1fr] items-center gap-3 border-t border-border px-4 py-2">
            <span><span className="block text-small font-semibold text-fg">Workers</span><span className="block text-caption text-faint">parallel helpers · everywhere</span></span>
            <select
              aria-label="Workers model"
              disabled={busy}
              value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId}
              onChange={(e) => void roles.onRole('worker', e.target.value)}
              className="h-8 rounded-md border-0 bg-subtle px-2 text-small font-semibold text-fg"
            >
              <option value="__default__">Follow the brain</option>
              {roles.workers.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-[84px_1fr] items-center gap-3 border-t border-border px-4 py-2">
            <span><span className="block text-small font-semibold text-fg">Judge</span><span className="block text-caption text-faint">checks the work · everywhere</span></span>
            <select
              aria-label="Judge model"
              disabled={busy}
              value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId}
              onChange={(e) => void roles.onRole('judge', e.target.value)}
              className="h-8 rounded-md border-0 bg-subtle px-2 text-small font-semibold text-fg"
            >
              <option value="__default__">Automatic · different family, fast</option>
              {roles.judges.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
            </select>
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-border px-4 pb-1 pt-2 text-caption text-faint">
            <Info className="h-3.5 w-3.5" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {roles.error ? <span className="text-danger">{roles.error}</span>
                : roles.saved ? <span className="text-success">Saved · takes effect on your next message</span>
                : busy ? 'Switching…' : 'Takes effect on your next message.'}
            </span>
            <Link to="/settings#models" className="shrink-0 underline underline-offset-2 hover:text-muted">All settings</Link>
          </div>
        </div>
      )}
    </div>
  );
}
