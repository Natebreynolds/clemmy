import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { ProjectLabelTag } from '@/components/projects/ProjectLabelTag';
import { useProjectLabels } from '@/lib/project-labels';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { listQuestionPresentations, presentInboxQuestion, sameQuestionPresentation, type QuestionPresentationList } from '@/lib/inbox';
import { ATTENTION_PRESENTATION_INVALIDATE, ATTENTION_PRESENTATION_QUERY, attentionInboxHref, listAttentionPresentations,
  presentAttentionItem, sameAttentionPresentation, type AttentionPresentationList } from '@/lib/attention-presentation';
import { matchesSetAsideItem, mergeSetAsideItems, setAsideItemContext, setAsideItemDate, setAsideItemDetail,
  setAsideItemSource, setAsideItemTitle, setAsideReturnLabel, setAsideView, type SetAsideItem, type SetAsideView } from '@/lib/set-aside-questions';

const QUESTION_QUERY = ['inbox-question-presentations'] as const;

/** Both server stores remain independently recoverable, including after reload. */
export function SetAsideQuestions() {
  const questions = usePoll(QUESTION_QUERY, listQuestionPresentations, 15_000);
  const attention = usePoll(ATTENTION_PRESENTATION_QUERY, listAttentionPresentations, 15_000);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = setAsideView(params.get('view'));
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string; href?: string } | null>(null);
  const rows = mergeSetAsideItems(questions.data?.questions ?? [], attention.data?.items ?? []);
  const labelFor = useProjectLabels(rows.map(item => item.row));
  const projectOf = (item: SetAsideItem) => labelFor(item.row);
  const projects = [...new Map(rows.flatMap(item => {
    const project = projectOf(item);
    return project ? [[project.projectId, project.projectName] as const] : [];
  })).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const filtered = rows.filter(item => matchesSetAsideItem(item, { view, search, projectId }, projectOf(item)));
  const pending = (!questions.data && questions.isLoading) || (!attention.data && attention.isLoading);
  const failed = [questions.isError && 'questions', attention.isError && 'other requests'].filter(Boolean);
  const noneAvailable = !questions.data && !attention.data;
  const incomplete = pending || failed.length > 0;
  const refresh = () => { void questions.refetch(); void attention.refetch(); };
  const changeView = (next: SetAsideView) => {
    const updated = new URLSearchParams(params);
    if (next === 'all') updated.delete('view'); else updated.set('view', next);
    setParams(updated);
  };
  const resetFilters = () => { setSearch(''); setProjectId(''); changeView('all'); };
  const restore = async (item: SetAsideItem) => {
    if (lock.current) return;
    lock.current = true; setBusy(item.key); setNotice(null);
    try {
      if (item.target === 'question') {
        const row = item.row;
        await presentInboxQuestion(row.id, 'restore', row.generation, row.mutationToken);
        client.setQueryData<QuestionPresentationList>(QUESTION_QUERY, current => {
          if (!current) return current;
          const saved = current.questions.filter(candidate => !sameQuestionPresentation(candidate, row));
          return { ...current, questions: saved, count: saved.length };
        });
        setNotice({ tone: 'success', text: 'Restored to Needs you. The work stays paused.', href: `/inbox?tab=needs&select=${encodeURIComponent(row.id)}` });
      } else {
        const row = item.row;
        await presentAttentionItem(row.key, 'restore', row.generation, row.mutationToken);
        client.setQueryData<AttentionPresentationList>(ATTENTION_PRESENTATION_QUERY, current => {
          if (!current) return current;
          const items = current.items.filter(candidate => !sameAttentionPresentation(candidate, row));
          return { ...current, items, count: items.length };
        });
        setNotice({ tone: 'success', text: 'Restored to Needs you. Nothing was answered or resolved.', href: attentionInboxHref(row) });
      }
      window.requestAnimationFrame(() => noticeRef.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setNotice({ tone: 'error', text: (cause as { status?: number })?.status === 409
        ? 'This item changed. Check the refreshed list before trying again.'
        : 'Couldn’t confirm restoration. Refresh the list before trying again.' });
    } finally {
      lock.current = false; setBusy(null);
      for (const key of ATTENTION_PRESENTATION_INVALIDATE) void client.invalidateQueries({ queryKey: [key] });
    }
  };
  const filters: { id: SetAsideView; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: rows.length },
    { id: 'later', label: 'Later', count: rows.filter(item => item.row.action === 'defer').length },
    { id: 'dismissed', label: 'Dismissed', count: rows.filter(item => item.row.action === 'dismiss').length },
  ];
  return <section aria-labelledby="set-aside-heading" className="min-w-0">
    <div className="mb-5">
      <h2 id="set-aside-heading" className="text-h3 text-fg">Items you set aside</h2>
      <p className="mt-1 max-w-[65ch] text-small text-muted">Restore an item to Needs you when you’re ready. Setting it aside does not answer a question, approve an action or resolve the work.</p>
    </div>
    {notice && <div ref={noticeRef} tabIndex={-1} role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('mb-4 flex flex-wrap items-center gap-3 rounded-md border px-3.5 py-3 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', notice.tone === 'error' ? 'border-warning/40 bg-warning-tint text-fg' : 'border-border bg-subtle text-fg')}>
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.href ? <Link to={notice.href} className="font-semibold text-primary hover:underline">Review item</Link>
        : <Button size="sm" variant="secondary" onClick={refresh}>Refresh list</Button>}
    </div>}
    {noneAvailable && pending ? <div role="status" className="space-y-3"><span className="sr-only">Loading set-aside items</span>{[0, 1, 2].map(index => <Skeleton key={index} className="h-24 w-full" />)}</div>
      : noneAvailable && failed.length > 0 ? <QueryUnavailable title="Set aside is unavailable" description="Clementine couldn’t load your set-aside items. Your saved choices have not changed." onRetry={refresh} />
      : <>
        {failed.length > 0 && <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border px-3.5 py-3 text-small text-muted"><span className="min-w-0 flex-1">Couldn’t refresh {failed.join(' and ')}. Showing their last saved lists and any items that loaded. Your saved choices have not changed.</span><Button size="sm" variant="secondary" onClick={refresh}>Try again</Button></div>}
        {pending && <p role="status" className="mb-4 text-small text-muted">Still checking the rest of your set-aside items…</p>}
        {rows.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Set aside items" className="inline-flex gap-1 rounded-md bg-subtle p-1">
            {filters.map(filter => <button key={filter.id} type="button" aria-pressed={view === filter.id} onClick={() => changeView(filter.id)} className={cn('min-h-9 rounded px-3 text-small font-medium transition-colors', view === filter.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:bg-hover hover:text-fg')}>{filter.label} <span className="ml-1 text-caption tabular-nums text-faint">{filter.count}</span></button>)}
          </div>
          <label className="min-w-40 flex-1 sm:max-w-64"><span className="sr-only">Find a set-aside item</span><Input type="search" placeholder="Find an item…" value={search} onChange={event => setSearch(event.target.value)} /></label>
          {projects.length > 0 && <label className="min-w-40 sm:max-w-64"><span className="sr-only">Filter set-aside items by project</span><Select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></label>}
        </div>}
        {rows.length === 0 ? <EmptyState title={incomplete ? 'No items in the available lists' : 'Nothing set aside'} description={incomplete
          ? 'Some saved items could not be checked. Try again to see the complete list.'
          : 'Questions and requests you put off or dismiss stay here while they’re pending. Later items return to Needs you at their scheduled time.'} />
          : filtered.length === 0 ? <EmptyState title="No matching items" description="Try another view, project or search." action={<Button size="sm" variant="secondary" onClick={resetFilters}>Clear filters</Button>} />
          : <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {filtered.map(item => {
              const row = item.row, title = setAsideItemTitle(item), detail = setAsideItemDetail(item), target = setAsideItemContext(item);
              return <li key={`${item.key}:${row.generation}:${row.mutationToken}`} className="px-4 py-4 sm:px-5">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted"><span className="font-semibold">{setAsideReturnLabel(row)}</span><span>{setAsideItemSource(item)}</span><ProjectLabelTag label={projectOf(item)} link /></div>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm text-body font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="min-w-0 flex-1 line-clamp-2 whitespace-pre-wrap group-open:line-clamp-none">{title}</span><ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden /></summary>
                      <div className="mt-2 space-y-2 text-small text-muted">
                        {detail && detail !== title && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{detail}</p>}
                        {setAsideItemDate(item) && <p>Asked {new Date(setAsideItemDate(item)).toLocaleString()}</p>}
                        {item.target === 'question' && item.row.unavailableReason && <p>{item.row.unavailableReason}</p>}
                      </div>
                    </details>
                    {target && <Link to={target.href} className="mt-2 inline-flex min-h-9 items-center text-small font-medium text-primary hover:underline">{target.label}</Link>}
                  </div>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void restore(item)} aria-label={`Restore ${item.target === 'question' ? 'question' : 'item'}: ${title}`}><RotateCcw className="h-4 w-4" aria-hidden />{busy === item.key ? 'Restoring…' : 'Restore'}</Button>
                </div>
              </li>;
            })}
          </ul>}
      </>}
  </section>;
}
