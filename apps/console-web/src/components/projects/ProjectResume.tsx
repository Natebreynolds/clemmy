import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, FileText, LayoutDashboard, MessageSquare } from 'lucide-react';
import { useFileDock } from '@/components/chat/FileDock';
import { usePoll } from '@/lib/poll';
import { folderHref, listDelivered, type DeliveredGroup } from '@/lib/delivered';
import { relativeTime } from '@/lib/inbox';
import { conversationPath, type ProjectOverview } from '@/lib/projects';
import { projectConversationIds, projectResumeConversation, projectResumeResults, projectResumeSpaces, type ProjectResumeResult } from '@/lib/project-resume';
import { workPath } from '@/lib/work-navigation';
import { ProjectSection } from './ProjectSection';
import { useStartProjectConversation } from './ProjectConversations';

const ROW = 'flex min-h-16 w-full items-center gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

async function readResults(sessionIds: string[]): Promise<DeliveredGroup[]> {
  const batches: string[][] = [];
  for (let index = 0; index < sessionIds.length; index += 50) batches.push(sessionIds.slice(index, index + 50));
  const results = await Promise.all(batches.map(ids => listDelivered(24, { sessionIds: ids })));
  const found = new Map<number, DeliveredGroup>();
  for (const group of results.flat()) found.set(group.id, group);
  return [...found.values()];
}

export function ProjectResume({ overview }: { overview: ProjectOverview }) {
  const latest = projectResumeConversation(overview);
  const start = useStartProjectConversation(overview.project);
  const when = latest ? relativeTime(latest.updatedAt) : '';
  return <div className="space-y-7">
    {latest ? <Link to={conversationPath(latest.sessionId)} className="group flex items-center gap-4 border-y border-border py-5 transition-colors hover:text-primary">
      <MessageSquare className="h-5 w-5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-h3 text-fg group-hover:text-primary">{overview.project.status === 'archived' ? 'Open' : 'Continue'} {latest.title?.trim() || 'the latest conversation'}</span>
        <span className="mt-1 block text-small text-muted">With {latest.agentName || 'Clem'}{when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}</span>
      </span>
      <ArrowRight className="h-5 w-5 shrink-0 text-muted group-hover:text-primary" aria-hidden />
    </Link> : overview.project.status !== 'archived' ? <button type="button" onClick={start} className="group flex w-full items-center gap-4 border-y border-border py-5 text-left transition-colors hover:text-primary">
      <MessageSquare className="h-5 w-5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1"><span className="block text-h3">Start a conversation in {overview.project.name}</span><span className="mt-1 block text-small text-muted">Your conversations and finished results will be kept here.</span></span>
      <ArrowRight className="h-5 w-5 shrink-0" aria-hidden />
    </button> : null}
    <div className="flex min-w-0 flex-wrap gap-x-8 gap-y-7">
      <RecentResults overview={overview} />
      <LinkedSpaces overview={overview} />
    </div>
  </div>;
}

function RecentResults({ overview }: { overview: ProjectOverview }) {
  const ids = projectConversationIds(overview);
  const delivered = usePoll(['delivered', 'project', overview.project.id, ids], () => readResults(ids), 30_000, { enabled: ids.length > 0 });
  const rows = projectResumeResults(overview, delivered.data ?? []);
  const [all, setAll] = useState(false);
  return <div id="project-results" className="min-w-0 flex-[1.5_1_24rem] scroll-mt-5"><ProjectSection title="Recent results">
    {rows.length > 0 ? <ul className="-mx-2 divide-y divide-border">{(all ? rows : rows.slice(0, 3)).map(row => <li key={row.key}><ResultRow row={row} projectId={overview.project.id} />{row.conversationSessionId ? <Link to={conversationPath(row.conversationSessionId)} className="mb-2 ml-9 inline-flex min-h-7 items-center text-caption font-semibold text-muted hover:text-primary hover:underline">Source conversation</Link> : null}</li>)}</ul> : null}
    {delivered.isLoading && ids.length > 0 ? <p className="text-small text-muted" role="status">Loading finished results…</p> : null}
    {delivered.isError ? <p className="text-small text-muted" role="alert">Finished files could not be loaded. <button type="button" className="font-semibold text-primary hover:underline" onClick={() => { void delivered.refetch(); }}>Retry</button></p> : null}
    {rows.length === 0 && !delivered.isError && !(delivered.isLoading && ids.length > 0) ? <p className="text-small text-muted">No finished results recorded here yet.</p> : null}
    {rows.length > 3 ? <button type="button" className="self-start text-small font-semibold text-primary hover:underline" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show recent results' : `Show more results (${rows.length})`}</button> : null}
  </ProjectSection></div>;
}

function ResultRow({ row, projectId }: { row: ProjectResumeResult; projectId: string }) {
  const dock = useFileDock();
  const when = relativeTime(row.createdAt);
  const content = <><FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-body font-semibold text-fg" title={row.title}>{row.title}</span><span className="block truncate text-caption text-muted" title={row.detail}>{row.detail}{when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}</span></span><span className="shrink-0 text-small font-semibold text-primary">Open</span></>;
  if (row.kind === 'group') return <Link to={folderHref(row.group)} className={ROW}>{content}</Link>;
  return <button type="button" className={ROW} onClick={() => dock?.open(row.kind === 'page' ? { kind: 'page', projectId, page: row.page } : { kind: 'file', ref: row.fileRef, conversationSessionId: row.conversationSessionId })}>{content}</button>;
}

function LinkedSpaces({ overview }: { overview: ProjectOverview }) {
  const spaces = projectResumeSpaces(overview);
  const [all, setAll] = useState(false);
  return <ProjectSection title="Linked Spaces" className="min-w-0 flex-[1_1_16rem]">
    {spaces.length ? <ul className="-mx-2 divide-y divide-border">{(all ? spaces : spaces.slice(0, 3)).map(space => <li key={space.id}><Link className={ROW} to={workPath('space', space.id)}><LayoutDashboard className="h-4 w-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 flex-1 truncate text-body font-semibold" title={space.title}>{space.title}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted" aria-hidden /></Link></li>)}</ul> : <p className="text-small text-muted">No Spaces are linked to this project.</p>}
    {spaces.length > 3 ? <button type="button" className="self-start text-small font-semibold text-primary hover:underline" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show fewer Spaces' : `Show all Spaces (${spaces.length})`}</button> : null}
  </ProjectSection>;
}
