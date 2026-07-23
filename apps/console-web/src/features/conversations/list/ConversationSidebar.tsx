import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Plus, Archive, X, PanelLeftClose } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useSessions } from '../hooks/useSessions';
import { useSessionMutations } from '../hooks/useSessionMutations';
import { groupSessions, collectTags } from '../lib/groupSessions';
import { ConversationListItem } from './ConversationListItem';
import type { SessionFilters } from '../types';

export function ConversationSidebar({ onCollapse }: { onCollapse?: () => void } = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mutations = useSessionMutations();

  // Debounced search text mirrored into ?q=.
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (search.trim()) next.set('q', search.trim());
        else next.delete('q');
        return next;
      }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [search, setSearchParams]);

  const tag = searchParams.get('tag') ?? '';
  const includeArchived = searchParams.get('archived') === '1';
  const filters: SessionFilters = useMemo(
    () => ({ q: searchParams.get('q') ?? undefined, tag: tag || undefined, includeArchived }),
    [searchParams, tag, includeArchived],
  );

  const { data, isLoading } = useSessions(filters);
  // Hide empty desktop shells ("t" · "No messages yet") unless it's the one
  // currently open (a just-created chat must stay visible while you type).
  // Harness rows always report turnCount 0 — never filter those.
  const { pathname } = useLocation();
  const activeId = decodeURIComponent(pathname.match(/^\/chat\/([^/]+)/)?.[1] ?? '');
  const sessions = useMemo(
    () => (data?.sessions ?? []).filter((s) => !(s.store === 'desktop' && s.turnCount === 0 && s.id !== activeId)),
    [data, activeId],
  );
  const groups = useMemo(() => groupSessions(sessions, Date.now()), [sessions]);
  const tags = useMemo(() => collectTags(sessions), [sessions]);

  const setParam = (key: string, value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };

  const actions = {
    onRename: mutations.rename,
    onPin: mutations.setPinned,
    onTags: mutations.setTags,
    onArchive: mutations.setArchived,
    onDelete: (id: string) => mutations.remove(id),
  };

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-1.5">
          <Button className="min-w-0 flex-1" onClick={() => navigate('/chat', { state: { newChat: Date.now() } })}>
            <Plus className="h-4 w-4" /> New chat
          </Button>
          {onCollapse && (
            <button
              type="button"
              title="Hide chat history"
              aria-label="Hide chat history"
              onClick={onCollapse}
              className="shrink-0 rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-canvas px-2.5">
          <Search className="h-4 w-4 shrink-0 text-faint" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations"
            className="h-9 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-faint"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch('')} className="text-faint hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {(tags.length > 0 || tag) && (
          <div className="flex flex-wrap gap-1">
            {tag && (
              <button
                type="button"
                onClick={() => setParam('tag', null)}
                className="inline-flex items-center gap-1 rounded-sm bg-primary-tint px-2 py-0.5 text-caption font-semibold text-primary"
              >
                {tag} <X className="h-3 w-3" />
              </button>
            )}
            {tags.filter((t) => t !== tag).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setParam('tag', t)}
                className="rounded-sm bg-subtle px-2 py-0.5 text-caption text-muted transition-colors hover:bg-hover"
              >
                {t}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setParam('archived', includeArchived ? null : '1')}
          className={cn(
            'inline-flex items-center gap-1.5 text-caption transition-colors',
            includeArchived ? 'text-primary' : 'text-faint hover:text-muted',
          )}
        >
          <Archive className="h-3.5 w-3.5" /> {includeArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-3 py-10 text-center text-small text-faint">
            {filters.q ? `No conversations match “${filters.q}”.` : 'No conversations yet.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="px-3 py-1 text-label uppercase tracking-wide text-faint">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((s) => (
                  <ConversationListItem key={s.id} session={s} actions={actions} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
