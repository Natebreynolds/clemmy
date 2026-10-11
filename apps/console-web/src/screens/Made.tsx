/**
 * Made — the dated archive of finished work. Home shows a handful; this is
 * every folder, grouped by day. Click a folder to see the drafts and files.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, ExternalLink, FileText, Globe, Mail, MessageCircle, RotateCw, Search, Table2 } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import {
  artifactCountLabel,
  dayHeading,
  deliveredConversationId,
  deliveredFileRef,
  folderHref,
  groupArtifacts,
  groupKinds,
  isEmailTarget,
  isHttpTarget,
  listDelivered,
  latestDeliveredGroups,
  matchesDeliveredSearch,
  matchingDeliveredFile,
  type DeliveredArtifact,
  type DeliveredGroup,
} from '@/lib/delivered';
import { unifiedChatSessionId } from '@/lib/last-session';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { ArtifactWorkspace, useFileDock } from '@/components/artifacts/ArtifactWorkspace';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'email', label: 'Emails' },
  { id: 'sheets', label: 'Sheets' },
  { id: 'files', label: 'Files' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

function matchesFilter(group: DeliveredGroup, filter: FilterId): boolean {
  if (filter === 'all') return true;
  const kinds = groupKinds(group);
  if (filter === 'email') return kinds.has('draft') || kinds.has('send');
  if (filter === 'sheets') return kinds.has('external_doc') || Boolean(group.url?.includes('docs.google.com'));
  if (filter === 'files') return kinds.has('file');
  return true;
}

function ArtifactGlyph({ artifact }: { artifact: DeliveredArtifact }) {
  const Icon = artifact.kind === 'draft' || artifact.kind === 'send'
    ? Mail
    : artifact.kind === 'external_doc'
      ? Table2
      : artifact.kind === 'url' || isHttpTarget(artifact.target)
        ? Globe
        : FileText;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />;
}

function askClem(group: DeliveredGroup) {
  const pointer = group.filePath ?? group.url ?? group.title;
  return `/chat?prompt=${encodeURIComponent(`About "${group.title}" you delivered (${pointer}): `)}`;
}

function runAgain(group: DeliveredGroup) {
  return `/chat?prompt=${encodeURIComponent(
    `I want to run the same work again that produced "${group.title}" (original ask: ${group.why.slice(0, 280)}). `
    + 'Confirm the inputs with me first if anything should change, then run it.',
  )}`;
}

function FolderRow({ group, query = '' }: { group: DeliveredGroup; query?: string }) {
  const dock = useFileDock();
  const latestFile = matchingDeliveredFile(group, query);
  const fileRef = latestFile ? deliveredFileRef(latestFile) : null;
  return (
    <div className="flex items-center gap-2 border-t border-border first:border-t-0">
      <Link to={folderHref(group)} className="min-w-0 flex-1 px-4 py-3 transition-colors hover:bg-hover">
        <span className="block truncate text-body font-medium text-fg" title={group.title}>{group.title}</span>
        <span className="block truncate text-caption text-muted">{artifactCountLabel(group)}{latestFile ? ` · ${latestFile.fileRef?.name ?? latestFile.title}` : ''}</span>
      </Link>
      {fileRef && dock ? <button type="button" className="mr-2 inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-small font-medium text-primary hover:bg-primary-tint" aria-label={`Open ${fileRef.name}`} onClick={() => dock.open({ kind: 'file', ref: fileRef, conversationSessionId: deliveredConversationId(group, latestFile) ?? undefined })}>Open</button> : null}
    </div>
  );
}

export function MadeArchive() {
  return <ArtifactWorkspace scopeKey="made:archive" returnLabel="Made"><MadeArchiveContent /></ArtifactWorkspace>;
}

function MadeArchiveContent() {
  const delivered = usePoll(['delivered-archive'], () => listDelivered(50), 30_000);
  const [filter, setFilter] = useState<FilterId>('all');
  const [search, setSearch] = useState('');
  const groups = useMemo(
    () => latestDeliveredGroups(delivered.data ?? []).filter((g) => matchesFilter(g, filter) && matchesDeliveredSearch(g, search)),
    [delivered.data, filter, search],
  );
  const recent = !search.trim() && filter === 'all' ? groups.slice(0, 3) : [];
  const sections = useMemo(() => {
    const byDay = new Map<string, DeliveredGroup[]>();
    for (const group of groups.slice(recent.length)) {
      const heading = dayHeading(group.createdAt) || 'Earlier';
      const list = byDay.get(heading) ?? [];
      list.push(group);
      byDay.set(heading, list);
    }
    return [...byDay.entries()];
  }, [groups, recent.length]);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6 animate-fade-in sm:px-10">
      <div>
        <h1 className="text-h1 text-fg">Made</h1>
        <p className="mt-1 text-body text-muted">Pick up a finished file, or open a folder to see everything from that work.</p>
      </div>
      <label className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted">
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search Made by title or filename" placeholder="Search titles and filenames" className="min-w-0 flex-1 bg-transparent py-2 text-body text-fg placeholder:text-muted" />
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter made work">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'min-h-9 rounded-full px-3 py-1 text-small font-medium transition-colors cursor-pointer',
              filter === f.id ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {delivered.isLoading ? (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : delivered.isError && !delivered.data ? (
        <QueryUnavailable
          title="Made is unavailable"
          description="Clementine couldn’t load the archive, so this is not an empty one. Nothing you made has been lost."
          onRetry={() => { void delivered.refetch(); }}
        />
      ) : groups.length === 0 ? (
        <p className="text-body text-muted">{search.trim() || filter !== 'all' ? 'No finished work matches. Try another title, filename, or filter.' : 'Nothing made yet — drafts, files, and sheets land here when Clem finishes them.'}</p>
      ) : (
        <>
        {recent.length > 0 ? <section className="flex flex-col gap-2"><h2 className="text-body font-semibold text-fg">Recent work</h2><div className="overflow-hidden rounded-lg border border-border bg-surface">{recent.map(group => <FolderRow key={group.id} group={group} />)}</div></section> : null}
        {sections.map(([heading, rows]) => (
          <section key={heading} className="flex flex-col gap-2">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-faint">{heading}</h2>
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              {rows.map((group) => <FolderRow key={group.id} group={group} query={search} />)}
            </div>
          </section>
        ))}
        </>
      )}
    </div>
  );
}

export function MadeFolder() {
  const { groupId } = useParams();
  return <ArtifactWorkspace scopeKey={`made:${groupId ?? 'unknown'}`} returnLabel="Made"><MadeFolderContent groupId={groupId} /></ArtifactWorkspace>;
}

function MadeFolderContent({ groupId }: { groupId?: string }) {
  const navigate = useNavigate();
  const dock = useFileDock();
  const delivered = usePoll(['delivered-archive'], () => listDelivered(50), 30_000);
  const group = (delivered.data ?? []).find((g) => String(g.id) === groupId);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState('');

  const copyPath = async (target: string) => {
    setCopyProblem('');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(target);
      setCopied(target);
      window.setTimeout(() => setCopied((cur) => (cur === target ? null : cur)), 1500);
    } catch { setCopyProblem('This location could not be copied. Open the conversation to find the original.'); }
  };

  if (delivered.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-10">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-40" />
      </div>
    );
  }
  if (delivered.isError && !delivered.data) {
    return <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-10"><QueryUnavailable title="This work could not be loaded" description="Try loading the archive again." onRetry={() => { void delivered.refetch(); }} /></div>;
  }
  if (!group) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-10">
        <p className="text-body text-muted">That work isn’t in the latest archive entries.</p>
        <Link to="/made" className="mt-3 inline-block text-small font-semibold text-primary hover:underline">All made</Link>
      </div>
    );
  }

  const conversationId = deliveredConversationId(group);
  const chatHref = conversationId ? `/chat/${encodeURIComponent(unifiedChatSessionId(conversationId))}` : null;
  const artifacts = groupArtifacts(group);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6 animate-fade-in sm:px-10">
      <div>
        <button
          type="button"
          onClick={() => navigate('/made')}
          className="inline-flex items-center gap-1 text-caption font-semibold text-faint transition-colors hover:text-fg cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All made
        </button>
        <h1 className="mt-2 text-h1 text-fg">{group.title}</h1>
        {group.why && <p className="mt-1 text-body text-muted">“{group.why}”</p>}
        <p className="mt-1 text-caption text-faint">
          {dayHeading(group.createdAt)} · {artifactCountLabel(group)}
          {chatHref && (
            <>
              {' · '}
              <Link to={chatHref} className="font-semibold text-primary hover:underline">Open conversation</Link>
            </>
          )}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {artifacts.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted">
            {group.artifactCount > 0
              ? 'The individual drafts and files aren’t listed here. Open the conversation to get to them.'
              : 'No artifacts recorded for this work.'}
          </p>
        ) : artifacts.map((artifact) => {
          const http = isHttpTarget(artifact.target);
          const email = isEmailTarget(artifact.target);
          const fileGone = artifact.kind === 'file' && artifact.stillExists === false;
          const fileRef = deliveredFileRef(artifact);
          return (
            <div key={artifact.target} className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
              <ArtifactGlyph artifact={artifact} />
              <span className="min-w-0 flex-1 text-body text-fg"><span className="block truncate" title={artifact.target}>{artifact.title}</span>{artifact.kind === 'file' && (!fileRef || fileRef.name !== artifact.title.trim()) ? <span className="block truncate text-caption text-muted">{fileRef?.name ?? (fileGone ? 'File moved or unavailable' : chatHref ? 'Open the conversation for the original file' : 'A preview is unavailable for this entry')}</span> : null}</span>
              {fileGone && <StatusPill tone="warning">unavailable</StatusPill>}
              {fileRef && dock ? <button type="button" onClick={() => dock.open({ kind: 'file', ref: fileRef, conversationSessionId: deliveredConversationId(group, artifact) ?? undefined })} aria-label={`Open ${fileRef.name}`} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-small font-medium text-primary hover:bg-primary-tint"><FileText className="h-3.5 w-3.5" aria-hidden /> Open</button> : http && artifact.openable ? (
                <button
                  type="button"
                  onClick={() => window.open(artifact.target, '_blank', 'noopener,noreferrer')}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint cursor-pointer"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                </button>
              ) : artifact.target ? (
                <button
                  type="button"
                  onClick={() => void copyPath(artifact.target)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint cursor-pointer"
                  title={artifact.target}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied === artifact.target ? 'Copied' : email ? 'Copy address' : http ? 'Copy link' : 'Copy path'}
                </button>
              ) : (
                <span className="text-caption text-faint">No link</span>
              )}
            </div>
          );
        })}
      </div>
      {copyProblem ? <p role="alert" className="text-small text-muted">{copyProblem}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => navigate(askClem(group))}>
          <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Ask Clem
        </Button>
        {group.rerunnable && (
          <Button variant="ghost" size="sm" onClick={() => navigate(runAgain(group))}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Run again
          </Button>
        )}
      </div>
    </div>
  );
}
