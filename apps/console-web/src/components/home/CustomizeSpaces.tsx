import { useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useChangeHomeLayout, useHomeLayout, type HomeLayout, type HomeTile } from '@/lib/home-layout';
import { listSpaces } from '@/lib/spaces';
import { usePoll } from '@/lib/poll';
import type { HomeSpaceView, HomeStyle } from '@/lib/home-prefs';
import { effectiveSpaceView, useSpaceSummaries } from '@/lib/home-data';
import { cn } from '@/lib/cn';

/**
 * The Tune panel's Style picker: two ways to arrange the same Home.
 */
export function StylePicker({ value, onChange }: { value: HomeStyle; onChange: (style: HomeStyle) => void }) {
  const options: Array<{ id: HomeStyle; label: string; hint: string }> = [
    { id: 'dashboard', label: 'Dashboard', hint: 'Today, Needs you and what came back side by side; Spaces in a grid' },
    { id: 'briefing', label: 'Briefing', hint: 'Decisions first; each Space a wide row' },
  ];
  return (
    <div role="radiogroup" aria-label="Home style" className="grid grid-cols-2 gap-2 p-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex flex-col gap-2 rounded-md border p-2.5 text-left transition-colors cursor-pointer',
            value === o.id ? 'border-primary bg-primary-tint' : 'border-border bg-canvas hover:bg-hover',
          )}
        >
          <StyleThumb style={o.id} />
          <span className="text-small font-semibold text-fg">{o.label}</span>
          <span className="text-caption text-muted">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function StyleThumb({ style }: { style: HomeStyle }) {
  const cell = 'rounded-[2px] bg-border-strong';
  return style === 'briefing' ? (
    <span aria-hidden className="grid h-12 grid-rows-[6px_10px_1fr_1fr] gap-[3px] rounded-sm border border-border bg-surface p-1">
      <span className={cn(cell, 'bg-primary/70')} />
      <span className="grid grid-cols-3 gap-[3px]"><span className={cell} /><span className={cell} /><span className={cell} /></span>
      <span className={cell} />
      <span className={cell} />
    </span>
  ) : (
    <span aria-hidden className="grid h-12 grid-cols-3 grid-rows-2 gap-[3px] rounded-sm border border-border bg-surface p-1">
      <span className={cell} /><span className={cn(cell, 'bg-primary/70')} /><span className={cell} />
      <span className={cn(cell, 'col-span-2')} /><span className={cell} />
    </span>
  );
}

/**
 * The Spaces on Home, in their order: how each shows (summary or its full
 * page), how much room it gets, where it sits, and taking it off. Order, size
 * and removal go through the Home layout contract (conflict-safe); summary or
 * full is a Home preference, saved with the rest of this panel.
 */
export function SpacesOnHome({ views, onView }: {
  views: Record<string, HomeSpaceView>;
  onView: (spaceId: string, view: HomeSpaceView) => void;
}) {
  const layout = useHomeLayout();
  const spaces = usePoll(['spaces'], listSpaces, 60_000);
  const mutation = useChangeHomeLayout();
  const [error, setError] = useState<string | null>(null);
  const data: HomeLayout | undefined = layout.data;
  const titleOf = (id: string) => spaces.data?.find((s) => s.id === id)?.title ?? id;
  // The same summaries Home reads (shared cache), so both say the same thing.
  const summaryIds = (data?.tiles ?? []).filter((t) => views[t.spaceId] !== 'full').map((t) => t.spaceId);
  const summaries = useSpaceSummaries(summaryIds);
  if (!data) return <p className="px-3 py-2.5 text-small text-muted">{layout.isError ? 'Couldn’t load your Home layout.' : 'Loading…'}</p>;
  const tiles = data.tiles;
  if (tiles.length === 0) return <p className="px-3 py-2.5 text-small text-muted">No Spaces on Home yet — Build home adds one.</p>;

  const change = (tile: HomeTile, patch: { operation?: 'update' | 'remove'; width?: HomeTile['width']; position?: 'before' | 'end'; before_space_id?: string }) => {
    setError(null);
    mutation.mutate({
      operation: patch.operation ?? 'update',
      space_id: tile.spaceId,
      expected_revision: data.revision,
      ...(patch.width ? { width: patch.width } : {}),
      ...(patch.position ? { position: patch.position } : {}),
      ...(patch.before_space_id ? { before_space_id: patch.before_space_id } : {}),
    }, { onError: (e) => setError(e.message) });
  };

  return (
    <ul className="flex flex-col">
      {tiles.map((tile, i) => {
        const view = effectiveSpaceView(views[tile.spaceId], summaries.data?.find((s) => s.id === tile.spaceId));
        const title = titleOf(tile.spaceId);
        return (
          <li key={tile.spaceId} className="flex flex-col gap-2 border-t border-border px-3 py-2.5 first:border-t-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={title}>{title}</span>
              <button type="button" aria-label={`Move ${title} up`} disabled={i === 0 || mutation.isPending}
                onClick={() => change(tile, { position: 'before', before_space_id: tiles[i - 1]!.spaceId })}
                className="rounded-sm p-1 text-faint hover:bg-hover hover:text-fg disabled:opacity-30 cursor-pointer"><ArrowUp className="h-3.5 w-3.5" aria-hidden /></button>
              <button type="button" aria-label={`Move ${title} down`} disabled={i === tiles.length - 1 || mutation.isPending}
                onClick={() => change(tile, i + 2 < tiles.length ? { position: 'before', before_space_id: tiles[i + 2]!.spaceId } : { position: 'end' })}
                className="rounded-sm p-1 text-faint hover:bg-hover hover:text-fg disabled:opacity-30 cursor-pointer"><ArrowDown className="h-3.5 w-3.5" aria-hidden /></button>
              <button type="button" aria-label={`Remove ${title} from Home`} disabled={mutation.isPending}
                onClick={() => change(tile, { operation: 'remove' })}
                className="rounded-sm p-1 text-faint hover:bg-hover hover:text-danger disabled:opacity-30 cursor-pointer"><X className="h-3.5 w-3.5" aria-hidden /></button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-caption text-faint">
              <span>Show</span>
              <Segmented label={`Show ${title} as`} value={view} options={[['summary', 'Summary'], ['full', 'Full page']]} onChange={(v) => onView(tile.spaceId, v as HomeSpaceView)} />
              <span className="ml-1.5">Size</span>
              <Segmented label={`${title} size`} value={tile.width} disabled={mutation.isPending} options={[['small', 'S'], ['medium', 'M'], ['wide', 'L']]} onChange={(v) => change(tile, { width: v as HomeTile['width'] })} />
            </div>
          </li>
        );
      })}
      {error && <li role="alert" className="border-t border-border px-3 py-2 text-small text-danger">{error}</li>}
    </ul>
  );
}

function Segmented({ label, value, options, onChange, disabled }: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <span role="group" aria-label={label} className="inline-flex overflow-hidden rounded-sm border border-border bg-surface">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          disabled={disabled}
          onClick={() => { if (value !== v) onChange(v); }}
          className={cn('px-2 py-0.5 text-caption font-semibold transition-colors cursor-pointer disabled:opacity-50', value === v ? 'bg-fg text-canvas' : 'text-muted hover:text-fg')}
        >
          {text}
        </button>
      ))}
    </span>
  );
}
