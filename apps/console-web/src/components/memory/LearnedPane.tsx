/** What she learned recently, and from whom: the newest facts with their origin. */
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { listFacts, type Fact } from '@/lib/memory';
import { relativeTime } from '@/lib/inbox';
import { memoryKind } from '@/lib/memory-why';
import { MemoryKindIcon } from './MemoryKindIcon';

function origin(f: Fact): string {
  if (f.derivedFrom?.tool) return f.derivedFrom.tool.replace(/^mcp__.*?__/, '').replace(/_/g, ' ');
  if (f.derivedFrom?.callId) return 'a tool result';
  return 'you';
}

export function LearnedPane({ onPick }: { onPick?: (f: Fact) => void }) {
  const facts = usePoll(['facts', 'recent'], () => listFacts(undefined, 40), 60_000);
  const recent = [...(facts.data?.facts ?? [])].sort((a, b) => Date.parse(b.createdAt ?? b.updatedAt ?? '') - Date.parse(a.createdAt ?? a.updatedAt ?? '')).slice(0, 5);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = (facts.data?.facts ?? []).filter((f) => Date.parse(f.createdAt ?? '') >= weekAgo).length;
  return (
    <section className="rounded-lg border border-border bg-surface p-3.5 shadow-xs" aria-labelledby="mem-learned-h">
      <h3 id="mem-learned-h" className="mb-2 flex items-center gap-2 text-body font-semibold text-fg">Learned recently <StatusPill tone="neutral">{thisWeek} this week</StatusPill></h3>
      {facts.isLoading ? <p className="text-small text-faint">Looking…</p>
        : recent.length === 0 ? <p className="text-small text-muted">Nothing yet. She learns from what you tell her and what she reads.</p>
        : (
          <ul className="space-y-1.5">
            {recent.map((f) => (
              <li key={String(f.id)}>
                <button type="button" onClick={() => onPick?.(f)} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-1 py-1 text-left text-small hover:bg-hover">
                  <MemoryKindIcon kind={memoryKind('fact', f.kind)} size="sm" />
                  <span className="truncate text-fg">{f.content}</span>
                  <span className="font-mono text-caption text-faint">{relativeTime(f.createdAt ?? f.updatedAt ?? '')} · {origin(f)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
