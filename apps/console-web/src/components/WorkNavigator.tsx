import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { ChevronRight, FolderKanban, LayoutDashboard, MessageSquare, Pin, Users, Zap } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { getProjectOverview, projectKeys } from '@/lib/projects';
import { useWorkCatalog } from '@/lib/use-work-catalog';
import { projectWorkItems, searchWorkItems, WORK_KIND_LABEL, type WorkItem, type WorkKind } from '@/lib/work-navigation';

export const WORK_ICONS = { project: FolderKanban, space: LayoutDashboard, workflow: Zap, agent: Users, chat: MessageSquare };

function WorkLink({ item, compact = false }: { item: WorkItem; compact?: boolean }) {
  const Icon = WORK_ICONS[item.kind];
  return (
    <NavLink to={item.path} end title={[item.title, item.detail].filter(Boolean).join(' — ')} className={({ isActive }) => cn('flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-small transition-colors hover:bg-hover', isActive ? 'bg-subtle font-semibold text-fg' : 'text-muted')}>
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {item.running ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" role="img" aria-label="Working" /> : item.pinned ? <Pin className="h-3 w-3 shrink-0" aria-label="Pinned" /> : null}
      {!compact && <span className="text-caption text-muted">{WORK_KIND_LABEL[item.kind]}</span>}
    </NavLink>
  );
}

function ProjectBranch({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false);
  const id = item.key.slice('project:'.length);
  const overview = useQuery({ queryKey: projectKeys.overview(id), queryFn: () => getProjectOverview(id), enabled: open, staleTime: 30_000 });
  const children = overview.data ? projectWorkItems(overview.data) : [];
  return (
    <div>
      <div className="flex min-w-0 items-center">
        <div className="min-w-0 flex-1"><WorkLink item={item} compact /></div>
        <button type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} work in ${item.title}`} onClick={() => setOpen(v => !v)} className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-fg">
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
        </button>
      </div>
      {open && <div className="ml-3 border-l border-border pl-2">
        {overview.isLoading ? <LoadingRows /> : overview.isError && !overview.data ? <Unavailable onRetry={() => { void overview.refetch(); }} /> : children.length ? children.map(child => <WorkLink key={child.key} item={child} compact />) : <p className="px-2 py-2 text-caption text-muted">Conversations and linked work appear here.</p>}
        <Link to={item.path} className="block px-2 py-2 text-caption font-semibold text-primary hover:underline">Project overview</Link>
      </div>}
    </div>
  );
}

function LoadingRows() {
  return <div role="status" className="space-y-2 px-2 py-3"><span className="sr-only">Loading work</span><div className="h-3 w-3/4 animate-pulse rounded bg-subtle motion-reduce:animate-none" /><div className="h-3 w-1/2 animate-pulse rounded bg-subtle motion-reduce:animate-none" /></div>;
}

function Unavailable({ onRetry }: { onRetry: () => void }) {
  return <p className="px-2 py-2 text-caption text-muted">Couldn't load this list. <button type="button" onClick={onRetry} className="font-semibold text-primary hover:underline">Retry</button></p>;
}

export function WorkCollection({ kind, path }: { kind: Exclude<WorkKind, 'chat'>; path: string }) {
  const catalog = useWorkCatalog(true, kind);
  const items = searchWorkItems(catalog.items, '', 6);
  return (
    <div className="mb-1 ml-5 border-l border-border pl-2" aria-label={`${WORK_KIND_LABEL[kind]} items`}>
      {catalog.loading && !items.length ? <LoadingRows /> : catalog.unavailable && !items.length ? <Unavailable onRetry={catalog.retry} /> : items.length ? items.map(item => kind === 'project' ? <ProjectBranch key={item.key} item={item} /> : <WorkLink key={item.key} item={item} compact />) : <p className="px-2 py-2 text-caption text-muted">No {kind === 'space' ? 'Spaces' : `${kind}s`} yet.</p>}
      <Link to={path} className="block px-2 py-2 text-caption font-semibold text-primary hover:underline">View all</Link>
    </div>
  );
}

export function RecentWork({ onHistory }: { onHistory: () => void }) {
  const catalog = useWorkCatalog(true, 'chat');
  const items = searchWorkItems(catalog.items, '', 5);
  return (
    <section className="mb-3 border-b border-border pb-3" aria-labelledby="work-recent-heading">
      <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2">
        <h2 id="work-recent-heading" className="text-caption font-semibold text-muted">Recent chats</h2>
        <button type="button" onClick={onHistory} className="rounded-sm text-caption text-muted hover:text-fg hover:underline">All chats</button>
      </div>
      {catalog.loading && !items.length ? <LoadingRows /> : catalog.unavailable && !items.length ? <Unavailable onRetry={catalog.retry} /> : items.length ? items.map(item => <WorkLink key={item.key} item={item} compact />) : <p className="px-2 py-2 text-caption text-muted">Start a chat and return to it here.</p>}
    </section>
  );
}
