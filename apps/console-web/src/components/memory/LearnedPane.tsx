/** A bounded selection of saved facts with recorded origins; not a global recency feed. */
import { usePoll } from '@/lib/poll';
import { listFacts, type Fact } from '@/lib/memory';
import { relativeTime } from '@/lib/inbox';
import { memoryKind } from '@/lib/memory-why';
import { MemoryKindIcon } from './MemoryKindIcon';

function origin(f: Fact): string {
  if (f.derivedFrom?.tool) return f.derivedFrom.tool.replace(/^mcp__.*?__/, '').replace(/_/g, ' ');
  if (f.derivedFrom?.callId) return 'a tool result';
  return 'Source not recorded';
}

export function LearnedPane({ onPick }: { onPick?: (f: Fact) => void }) {
  const facts = usePoll(['facts', 'recent'], () => listFacts(undefined, 40), 60_000);
  const loaded = facts.data?.facts ?? [];
  const date = (f: Fact) => { const value = Date.parse(f.createdAt ?? f.updatedAt ?? ''); return Number.isFinite(value) ? value : 0; };
  const recent = [...loaded].sort((a, b) => date(b) - date(a)).slice(0, 5);
  return (
    <section className="rounded-lg border border-border bg-surface p-3.5 shadow-xs" aria-labelledby="mem-learned-h">
      <h3 id="mem-learned-h" className="mb-2 text-body font-semibold text-fg">From your memory</h3>
      {facts.isError && <p className="mb-3 text-small text-muted" role="status">
        {facts.data ? 'Couldn’t refresh these facts. Showing the last loaded selection.' : 'Recent facts couldn’t be read just now.'}{' '}
        <button type="button" onClick={() => { void facts.refetch(); }} className="font-semibold text-primary underline underline-offset-2">Try again</button>
      </p>}
      {facts.isLoading ? <p className="text-small text-faint">Looking…</p>
        : facts.isError && !facts.data ? null
        : recent.length === 0 ? <p className="text-small text-muted">No facts were returned in this selection.</p>
        : (
          <>
          <p className="mb-3 text-caption text-muted">A selection of {recent.length} saved facts, newest first.</p>
          <ul className="space-y-1.5">
            {recent.map((f) => (
              <li key={String(f.id)}>
                <button type="button" onClick={() => onPick?.(f)} className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md px-1 py-2 text-left text-small hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <MemoryKindIcon kind={memoryKind('fact', f.kind)} size="sm" />
                  <span className="min-w-0"><span className="line-clamp-2 text-fg">{f.content}</span>
                    <span className="mt-1 block break-words text-caption text-muted">{date(f) > 0 ? `${relativeTime(f.createdAt ?? f.updatedAt ?? '')} · ` : ''}{origin(f)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          </>
        )}
    </section>
  );
}
