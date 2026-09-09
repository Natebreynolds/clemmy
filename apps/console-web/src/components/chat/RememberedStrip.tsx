/**
 * "Remembered N things for this": the recall receipts for one reply — what
 * she actually used, each with its kind and source, and a Wrong? that forgets
 * the memory (with undo) right where it was used. One lazy fetch per settled
 * reply; silently absent when the turn recalled nothing.
 */
import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { forgetFact, getSessionRecall, restoreFact, type SessionRecallRef } from '@/lib/memory';
import { memoryKind } from '@/lib/memory-why';
import { MemoryKindIcon } from '@/components/memory/MemoryKindIcon';

export function RememberedStrip({ sessionId, startedAt }: { sessionId: string; startedAt: number }) {
  const [refs, setRefs] = useState<SessionRecallRef[] | null>(null);
  const [state, setState] = useState<Record<string, 'forgotten' | 'busy'>>({});
  useEffect(() => {
    let alive = true;
    getSessionRecall(sessionId, new Date(startedAt - 5_000).toISOString())
      .then((r) => { if (alive) setRefs(r.used); })
      .catch(() => { if (alive) setRefs([]); });
    return () => { alive = false; };
  }, [sessionId, startedAt]);
  if (!refs || refs.length === 0) return null;
  const toggle = async (ref: SessionRecallRef) => {
    if (ref.type !== 'fact') return;
    const key = `${ref.type}:${ref.id}`;
    const forgotten = state[key] === 'forgotten';
    setState((s) => ({ ...s, [key]: 'busy' }));
    try {
      if (forgotten) await restoreFact(ref.id); else await forgetFact(ref.id);
      setState((s) => ({ ...s, [key]: forgotten ? undefined as never : 'forgotten' }));
    } catch { setState((s) => { const n = { ...s }; delete n[key]; return n; }); }
  };
  return (
    <div className="mt-2 rounded-lg border border-border bg-surface px-4 py-2.5 shadow-xs">
      <div className="mb-1.5 flex items-center gap-2 text-caption font-semibold text-muted"><Brain className="h-3.5 w-3.5 text-[#8B7CF6]" aria-hidden />Remembered {refs.length} {refs.length === 1 ? 'thing' : 'things'} for this</div>
      <ul className="space-y-1">
        {refs.slice(0, 6).map((ref) => {
          const key = `${ref.type}:${ref.id}`;
          const forgotten = state[key] === 'forgotten';
          return (
            <li key={key} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 text-small">
              <MemoryKindIcon kind={memoryKind(ref.type, ref.kind)} size="sm" />
              <span className={forgotten ? 'truncate text-faint line-through' : 'truncate text-fg'}>{ref.text || `${ref.type} ${ref.id}`}</span>
              <span className="font-mono text-caption text-faint">{ref.source ? ref.source.replace(/^mcp__.*?__/, '').replace(/_/g, ' ') : ref.kind === 'feedback' ? 'you' : ''}</span>
              {ref.type === 'fact' && (
                <button type="button" disabled={state[key] === 'busy'} onClick={() => void toggle(ref)} className="text-caption font-semibold text-muted underline underline-offset-2 hover:text-fg disabled:opacity-50">{forgotten ? 'Undo' : 'Wrong?'}</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
