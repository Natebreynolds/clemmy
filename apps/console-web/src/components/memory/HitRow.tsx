/**
 * One search hit: the kind glyph, the text, why it matched in plain words,
 * and where it came from. Selecting it opens the memory on the right.
 */
import { cn } from '@/lib/cn';
import type { MemoryHit } from '@/lib/memory';
import { displayTitle, hitSourceLine, memoryKind, whyChips } from '@/lib/memory-why';
import { MemoryKindIcon } from './MemoryKindIcon';

export function HitRow({ hit, selected, onSelect }: { hit: MemoryHit; selected: boolean; onSelect: () => void; index?: number }) {
  const kind = memoryKind(hit.ref.type);
  const chips = whyChips(hit);
  const { source, when } = hitSourceLine(hit);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn('grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary', selected ? 'border-primary' : 'border-border')}
    >
      <MemoryKindIcon kind={kind} />
      <span className="min-w-0">
        <span className="line-clamp-3 text-body text-fg">{displayTitle(hit) ? <><span className="font-semibold">{displayTitle(hit)}</span>{hit.text ? ` — ${hit.text}` : ''}</> : hit.text || hit.title}</span>
        {chips.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {chips.map((c) => <span key={c.label} className={cn('rounded-full px-2 py-0.5 text-caption', c.strong ? 'bg-success-tint text-success' : 'bg-subtle text-muted')}>{c.label}</span>)}
          </span>
        )}
        {(source || when) && <span className="mt-2 flex flex-wrap gap-x-3 text-caption text-muted">
          {source && <span>{source}</span>}{when && <span>{when}</span>}
        </span>}
      </span>
    </button>
  );
}
