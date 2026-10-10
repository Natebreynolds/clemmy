import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { ALL_NAV } from '@/lib/nav';
import { cn } from '@/lib/cn';
import { useWorkCatalog } from '@/lib/use-work-catalog';
import { searchWorkItems, WORK_KIND_LABEL } from '@/lib/work-navigation';
import { WORK_ICONS } from './WorkNavigator';

/** Every result opens work; the palette never executes it or changes bindings. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [chatQuery, setChatQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const catalog = useWorkCatalog(open, undefined, chatQuery);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close(); else setOpen(true);
      } else if (open && e.key === 'Escape') { e.preventDefault(); close(); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('clem:command-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('clem:command-palette', onOpen);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(''); setChatQuery(''); setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setChatQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const actual = searchWorkItems(catalog.items, query, 40).map(item => ({
      key: item.key, path: item.path, title: item.title, detail: item.detail,
      kind: WORK_KIND_LABEL[item.kind], icon: WORK_ICONS[item.kind],
    }));
    const destinations = ALL_NAV.filter(d => words.every(word => `${d.label} ${d.hint}`.toLocaleLowerCase().includes(word)))
      .map(d => ({ key: `destination:${d.path}`, path: d.path, title: d.label, detail: d.hint, kind: 'Go to', icon: d.icon }));
    return [...actual, ...destinations];
  }, [catalog.items, query]);
  const selected = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    if (open) document.getElementById(`work-search-result-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected]);

  if (!open) return null;
  const go = (path: string) => {
    navigate(path);
    close(false);
    requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/30 p-4 pt-[10vh]" onMouseDown={() => close()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search work and chats"
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-surface shadow-modal"
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={event => {
          if (event.key !== 'Tab') return;
          const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled]):not([tabindex="-1"]), a[href]') ?? [])];
          const first = elements[0]; const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(selected + 1, Math.max(0, results.length - 1))); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(selected - 1, 0)); }
              else if (e.key === 'Enter' && results[selected]) { e.preventDefault(); go(results[selected].path); }
            }}
            placeholder="Find a chat, project, Space, workflow…"
            aria-label="Search work and chats"
            role="combobox"
            aria-expanded="true"
            aria-controls="work-search-results"
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `work-search-result-${selected}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-muted"
          />
          <button type="button" onClick={() => close()} title="Close search · Escape" aria-label="Close search" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {catalog.loading && <p role="status" className="px-5 pt-3 text-caption text-muted">Finding your work…</p>}
          {catalog.unavailable && <p role="status" className="px-5 pt-3 text-caption text-muted">Some work couldn't load. <button type="button" onClick={catalog.retry} className="font-semibold text-primary hover:underline">Retry</button></p>}
          <ul id="work-search-results" className="p-2" role="listbox" aria-label="Work and destinations">
            {!results.length && !catalog.loading && <li role="presentation" className="px-3 py-6 text-center text-small text-muted">No matching work found. Try another name.</li>}
            {results.map((item, index) => {
              const Icon = item.icon;
              return <li id={`work-search-result-${index}`} key={item.key} role="option" aria-selected={index === selected}>
                <button type="button" tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => go(item.path)} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left', index === selected ? 'bg-subtle text-fg' : 'text-muted hover:bg-hover')}>
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
                  <span className="min-w-0 flex-1"><span className="block truncate text-body font-medium text-fg">{item.title}</span>{item.detail && <span className="block truncate text-caption text-muted">{item.detail}</span>}</span>
                  <span className="shrink-0 text-caption text-muted">{item.kind}</span>
                </button>
              </li>;
            })}
          </ul>
        </div>
        <p className="shrink-0 border-t border-border px-5 py-2.5 text-caption text-muted">Use arrow keys to choose · Enter to open · Escape to close</p>
      </div>
    </div>
  );
}
