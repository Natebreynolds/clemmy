/**
 * The selected memory, on a night surface — the one deliberate bold move in
 * the Memory tab. Text set large, confidence and use, where it came from with
 * the actual excerpt, how it changed, and the actions: Correct, Pin, Forget
 * with an undo bar instead of a confirm dialog.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { forgetFact, pinFact, restoreFact, updateFact, type MemoryHit } from '@/lib/memory';
import { KIND_LABEL, displayTitle, hitSourceLine, memoryKind } from '@/lib/memory-why';
import { MemoryKindIcon } from './MemoryKindIcon';

const NIGHT = { bg: '#14131A', pane: '#1D1B26', line: '#2B2937', ink: '#EDE9F6', ink2: '#9B96AE', glow: '#8B7CF6', glow2: '#4FC3C9' };

export function MemoryDetail({ hit, pinned, onChanged, className }: { hit: MemoryHit | null; pinned?: boolean; onChanged?: () => void; className?: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [forgotten, setForgotten] = useState(false);
  const [isPinned, setIsPinned] = useState(Boolean(pinned));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setForgotten(false); setEditing(false); setError(null); setIsPinned(Boolean(pinned)); setDraft(hit?.text ?? ''); }, [hit?.ref.id, hit?.ref.type, pinned, hit?.text]);
  useEffect(() => {
    if (!forgotten) return;
    const t = setTimeout(() => setForgotten(false), 8000);
    return () => clearTimeout(t);
  }, [forgotten]);
  const isFact = hit?.ref.type === 'fact';
  const factId = isFact ? Number(hit?.ref.id) : NaN;
  const refresh = () => { onChanged?.(); void qc.invalidateQueries({ queryKey: ['facts'] }); void qc.invalidateQueries({ queryKey: ['mem-search'] }); };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const { source, when } = hit ? hitSourceLine(hit) : { source: '', when: '' };
  const kind = hit ? memoryKind(hit.ref.type) : 'fact';
  return (
    <aside
      aria-label="Selected memory"
      className={cn('relative flex min-h-0 flex-col overflow-y-auto rounded-lg border p-5', className)}
      style={{ background: NIGHT.bg, borderColor: NIGHT.line, color: NIGHT.ink, scrollbarWidth: 'thin', backgroundImage: 'radial-gradient(600px 300px at 80% -10%, rgba(139,124,246,.22), transparent 60%), radial-gradient(400px 260px at 0% 110%, rgba(79,195,201,.14), transparent 60%)' }}
    >
      {!hit ? (
        <p className="py-16 text-center text-small" style={{ color: NIGHT.ink2 }}>Pick a memory to see where it came from.</p>
      ) : (
        <>
          <header className="mb-3 flex items-center gap-2.5">
            <MemoryKindIcon kind={kind} size="sm" className="!bg-[rgba(232,100,27,.18)] !text-[#FFB27A]" />
            <span className="text-caption font-semibold uppercase tracking-wide" style={{ color: NIGHT.ink2 }}>{KIND_LABEL[kind]}{source ? ` · ${source}` : ''}</span>
            {isFact && (
              <button type="button" disabled={busy} aria-pressed={isPinned} onClick={() => run(async () => { await pinFact(factId, !isPinned); setIsPinned(!isPinned); })}
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-semibold" style={{ borderColor: isPinned ? 'rgba(139,124,246,.5)' : NIGHT.line, color: isPinned ? NIGHT.ink : NIGHT.ink2 }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: isPinned ? NIGHT.glow : NIGHT.line }} aria-hidden />{isPinned ? 'Pinned' : 'Pin'}
              </button>
            )}
          </header>
          {editing ? (
            <div className="mb-3 space-y-2">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label="Correct this memory" className="w-full rounded-md border p-2 text-body" style={{ background: NIGHT.pane, borderColor: NIGHT.line, color: NIGHT.ink }} />
              <div className="flex gap-2">
                <button type="button" disabled={busy || !draft.trim() || draft.trim() === hit.text} onClick={() => run(async () => { await updateFact(factId, { content: draft.trim() }); setEditing(false); })} className="rounded-md bg-primary px-3 py-1.5 text-small font-semibold text-primary-fg disabled:opacity-50">Save as correction</button>
                <button type="button" onClick={() => { setEditing(false); setDraft(hit.text); }} className="rounded-md px-3 py-1.5 text-small font-semibold" style={{ color: NIGHT.ink2 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <p className={cn('mb-3.5 font-serif text-h3 leading-snug transition-opacity', forgotten && 'line-through opacity-40')} style={{ color: NIGHT.ink }}>{displayTitle(hit) ? `${displayTitle(hit)}${hit.text ? ` — ${hit.text}` : ''}` : hit.text}</p>
          )}
          <div className="mb-4 grid grid-cols-3 gap-2">
            <div className="rounded-md border px-2.5 py-2" style={{ background: NIGHT.pane, borderColor: NIGHT.line }}>
              <div className="flex h-5 items-center gap-0.5" aria-label={`confidence ${Math.round(hit.confidence * 100)}%`}>{[0.33, 0.66, 0.9].map((t) => <i key={t} className="block h-1.5 w-2.5 rounded-sm" style={{ background: hit.confidence >= t ? NIGHT.glow2 : NIGHT.line }} />)}</div>
              <div className="text-caption" style={{ color: NIGHT.ink2 }}>confidence {hit.confidence >= 0.9 ? 'high' : hit.confidence >= 0.66 ? 'good' : hit.confidence >= 0.33 ? 'fair' : 'low'}</div>
            </div>
            <div className="rounded-md border px-2.5 py-2" style={{ background: NIGHT.pane, borderColor: NIGHT.line }}><div className="font-mono text-body" style={{ color: NIGHT.ink }}>{hit.evidence.length}</div><div className="text-caption" style={{ color: NIGHT.ink2 }}>{hit.evidence.length === 1 ? 'source' : 'sources'}</div></div>
            <div className="rounded-md border px-2.5 py-2" style={{ background: NIGHT.pane, borderColor: NIGHT.line }}><div className="font-mono text-body" style={{ color: NIGHT.ink }}>{when || '—'}</div><div className="text-caption" style={{ color: NIGHT.ink2 }}>{hit.validTo ? 'until ' + new Date(hit.validTo).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'since'}</div></div>
          </div>
          {hit.evidence.length > 0 && (
            <section className="mb-4">
              <h4 className="mb-2 text-caption font-semibold uppercase tracking-wide" style={{ color: NIGHT.ink2 }}>Where it came from</h4>
              <div className="space-y-1.5">
                {hit.evidence.slice(0, 4).map((e) => (
                  <div key={`${e.episodeId}:${e.excerpt}`} className="rounded-md border px-2.5 py-2 text-small" style={{ background: NIGHT.pane, borderColor: NIGHT.line }}>
                    <q className="italic" style={{ color: '#D9D4EA' }}>{e.excerpt || 'excerpt no longer available'}</q>
                    {e.sourceUri && <div className="mt-0.5 truncate font-mono text-caption" style={{ color: NIGHT.ink2 }}>{e.sourceUri}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {isFact && (
            <div className="mt-1 flex items-center gap-1.5 pt-2">
              <button type="button" disabled={busy || forgotten} onClick={() => { setEditing(true); setDraft(hit.text); }} className="rounded-md bg-primary px-3 py-1.5 text-small font-semibold text-primary-fg disabled:opacity-50">Correct</button>
              <button type="button" disabled={busy || forgotten} onClick={() => run(async () => { await forgetFact(factId); setForgotten(true); })} className="ml-auto px-1 py-1.5 text-small font-semibold" style={{ color: NIGHT.ink2 }}>Forget</button>
            </div>
          )}
          {error && <p className="mt-2 text-caption text-danger">{error}</p>}
          {forgotten && (
            <div role="status" className="sticky bottom-0 -mx-5 -mb-5 mt-3 flex items-center gap-3 border-t px-5 py-2.5 text-small" style={{ background: NIGHT.pane, borderColor: NIGHT.line }}>
              Forgotten. She won't use it again.
              <button type="button" onClick={() => run(async () => { await restoreFact(factId); setForgotten(false); })} className="ml-auto font-semibold" style={{ color: NIGHT.glow2 }}>Undo</button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
