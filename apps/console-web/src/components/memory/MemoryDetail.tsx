/** A selected memory, its recorded evidence, and reversible corrections. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageCircle, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { forgetFact, pinFact, restoreFact, updateFact, type Fact, type MemoryHit } from '@/lib/memory';
import { KIND_LABEL, displayTitle, hitSourceLine, memoryKind } from '@/lib/memory-why';
import { MemoryKindIcon } from './MemoryKindIcon';
import { Constellation } from './Constellation';

interface MemoryDetailProps {
  hit: MemoryHit | null;
  pinned?: boolean | null;
  active?: boolean | null;
  initialEditing?: boolean;
  onChanged?: () => void;
  onReplaced?: (fact: Fact) => void;
  onClose?: () => void;
  onAsk?: (hit: MemoryHit) => void;
  className?: string;
}

export function MemoryDetail(props: MemoryDetailProps) {
  // A late action on a previous selection must not overwrite the next inspector.
  return <MemoryDetailContent key={props.hit ? `${props.hit.ref.type}:${props.hit.ref.id}:${props.initialEditing ? 'edit' : 'view'}` : 'empty'} {...props} />;
}

function MemoryDetailContent({ hit: sourceHit, pinned, active, initialEditing = false, onChanged, onReplaced, onClose, onAsk, className }: MemoryDetailProps) {
  const qc = useQueryClient();
  const [replacement, setReplacement] = useState<Fact | null>(null);
  const hit: MemoryHit | null = replacement ? {
    ref: { type: 'fact', id: replacement.id }, text: replacement.content, score: sourceHit?.score ?? 0,
    confidence: replacement.confidence ?? null, evidence: replacement.evidence ?? [], whyRecalled: [],
    ...(replacement.validFrom || replacement.createdAt ? { validFrom: (replacement.validFrom ?? replacement.createdAt)! } : {}),
    ...(replacement.validTo ? { validTo: replacement.validTo } : {}),
  } : sourceHit;
  const scrollRef = useRef<HTMLElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(initialEditing && active !== false && sourceHit?.ref.type === 'fact');
  const [draft, setDraft] = useState(sourceHit?.text ?? '');
  const [forgotten, setForgotten] = useState(active === false);
  const [toast, setToast] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState<boolean | null>(pinned ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setForgotten(replacement ? replacement.active === false : active === false); setToast(false);
    setEditing(!replacement && initialEditing && active !== false && hit?.ref.type === 'fact');
    setError(null); setDraft(hit?.text ?? '');
  }, [hit?.ref.id, hit?.ref.type, hit?.text, active, initialEditing]);
  useEffect(() => { setIsPinned(replacement ? replacement.pinned ?? null : pinned ?? null); }, [replacement, pinned]);
  useLayoutEffect(() => {
    if (scrollRef.current) { scrollRef.current.scrollTop = 0; (editRef.current ?? scrollRef.current).focus({ preventScroll: true }); }
    setConnectionsOpen(false);
  }, [hit?.ref.id, hit?.ref.type]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 10_000);
    return () => clearTimeout(t);
  }, [toast]);
  const isFact = hit?.ref.type === 'fact';
  const factId = isFact ? hit.ref.id : '';
  const refresh = () => {
    if (alive.current) onChanged?.();
    void qc.invalidateQueries({ queryKey: ['facts'] });
    void qc.invalidateQueries({ queryKey: ['mem-search'] });
  };
  const run = async (fn: () => Promise<() => void>) => {
    setBusy(true); setError(null);
    try { const apply = await fn(); if (alive.current) apply(); refresh(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'That change could not be saved. Try again.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const { source, when } = hit ? hitSourceLine(hit) : { source: '', when: '' };
  const kind = hit ? memoryKind(hit.ref.type) : 'fact';
  const confidence = typeof hit?.confidence === 'number' && Number.isFinite(hit.confidence) ? hit.confidence : null;
  const secondary = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-small font-medium text-fg hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50';
  return (
    <aside ref={scrollRef} tabIndex={-1} aria-label="Selected memory" className={cn('h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-surface p-5 text-fg', className)}>
      <header className="mb-5 flex items-center gap-3">
        <h2 className="min-w-0 flex-1 text-body-lg font-semibold">Memory details</h2>
        {onClose && <button type="button" onClick={onClose} aria-label="Close memory details" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"><X className="h-4 w-4" aria-hidden /></button>}
      </header>
      {!hit ? <p className="text-body text-muted">Pick a memory to see where it came from.</p> : <>
        <div className="mb-3 flex items-center gap-2 text-small text-muted">
          <MemoryKindIcon kind={kind} size="sm" />
          <span>{KIND_LABEL[kind]}{source ? ` · ${source}` : ''}</span>
        </div>
        {editing ? (
          <div className="mb-4 space-y-3">
            <textarea ref={editRef} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label="Correct this memory" className="w-full rounded-md border border-border bg-canvas p-3 text-body text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || !draft.trim() || draft.trim() === hit.text} onClick={() => run(async () => {
                const result = await updateFact(factId, { content: draft.trim() });
                if (!result.ok || !result.fact) throw new Error('The corrected memory could not be read. Try again.');
                return () => { setReplacement(result.fact); setEditing(false); onReplaced?.(result.fact); };
              })} className="min-h-10 rounded-md bg-primary px-3 py-2 text-small font-semibold text-primary-fg disabled:opacity-50">{busy ? 'Saving…' : 'Save correction'}</button>
              <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(hit.text); requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true })); }} className={secondary}>Cancel</button>
            </div>
          </div>
        ) : <p className={cn('mb-4 break-words text-body-lg leading-relaxed', forgotten && 'text-muted line-through')}>{displayTitle(hit) ? `${displayTitle(hit)}${hit.text ? ` — ${hit.text}` : ''}` : hit.text}</p>}
        <dl className="mb-5 space-y-1 text-small">
          <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Confidence</dt><dd>{confidence == null ? 'Not recorded' : `${Math.round(confidence * 100)}%`}</dd></div>
          <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Evidence records</dt><dd>{hit.evidence.length}</dd></div>
          {when && <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Since</dt><dd>{when}</dd></div>}
          {hit.validTo && <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Until</dt><dd>{new Date(hit.validTo).toLocaleDateString()}</dd></div>}
        </dl>
        <div className="mb-5 flex flex-wrap gap-2">
          {onAsk && <button type="button" onClick={() => onAsk(hit)} className={secondary}><MessageCircle className="h-4 w-4" aria-hidden /> Ask Clem</button>}
          {isFact && <>
            <button type="button" disabled={busy || forgotten || editing} onClick={() => { setEditing(true); setDraft(hit.text); }} className={secondary}>Correct</button>
            <button type="button" disabled={busy || forgotten} aria-pressed={isPinned ?? undefined} onClick={() => run(async () => {
              const next = isPinned !== true; await pinFact(factId, next); return () => setIsPinned(next);
            })} className={secondary}>{isPinned ? 'Unpin' : 'Pin'}</button>
            {forgotten
              ? <button type="button" disabled={busy} onClick={() => run(async () => { await restoreFact(factId); return () => { setForgotten(false); setToast(false); }; })} className={secondary}>Restore</button>
              : <button type="button" disabled={busy || editing} onClick={() => run(async () => { await forgetFact(factId); return () => { setForgotten(true); setToast(true); }; })} className={secondary}>Forget</button>}
          </>}
        </div>
        {error && <p className="mb-4 text-small text-danger" role="status">{error}</p>}
        {forgotten && toast && <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-md bg-subtle p-3 text-small">
          Forgotten. She won’t use it again.
          <button type="button" disabled={busy} onClick={() => run(async () => { await restoreFact(factId); return () => { setForgotten(false); setToast(false); }; })} className="font-semibold text-primary underline underline-offset-2 disabled:opacity-50">Undo</button>
        </div>}
        <section className="border-t border-border pt-4">
          <h3 className="mb-3 text-body font-semibold">Where it came from</h3>
          {hit.evidence.length === 0 ? <p className="text-small text-muted">No source excerpt was returned for this memory.</p> : <>
            {hit.evidence.length > 4 && <p className="mb-3 text-caption text-muted">Showing 4 of {hit.evidence.length} evidence records.</p>}
            <div className="space-y-4">{hit.evidence.slice(0, 4).map((e) => <div key={`${e.episodeId}:${e.excerpt}`} className="break-words text-small">
              <blockquote className="leading-relaxed text-fg">{e.excerpt || 'Excerpt no longer available.'}</blockquote>
              {e.sourceUri && <p className="mt-1 break-all text-caption text-muted">{e.sourceUri}</p>}
            </div>)}</div>
          </>}
        </section>
        {['fact', 'entity', 'resource', 'episode', 'policy'].includes(hit.ref.type) && <details open={connectionsOpen} onToggle={(e) => setConnectionsOpen(e.currentTarget.open)} className="mt-5 border-t border-border pt-4">
          <summary className="cursor-pointer text-body font-semibold">Connections</summary>
          {connectionsOpen && <div className="mt-3"><Constellation seedId={`${hit.ref.type}:${hit.ref.id}`} /></div>}
        </details>}
      </>}
    </aside>
  );
}
