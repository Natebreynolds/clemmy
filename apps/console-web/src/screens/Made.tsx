/**
 * Made — the dated archive of finished work. Home shows a handful; this is
 * every folder, grouped by day. Click a folder to see the drafts and files.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, ExternalLink, FileText, Globe, Mail, MessageCircle, RotateCw, Table2 } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import {
  artifactCountLabel,
  dayHeading,
  folderHref,
  groupArtifacts,
  groupKinds,
  isEmailTarget,
  isHttpTarget,
  listDelivered,
  type DeliveredArtifact,
  type DeliveredGroup,
} from '@/lib/delivered';
import { unifiedChatSessionId } from '@/lib/last-session';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

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

function openArtifact(artifact: DeliveredArtifact) {
  if (isHttpTarget(artifact.target)) {
    window.open(artifact.target, '_blank', 'noopener,noreferrer');
    return;
  }
  if (artifact.kind === 'file' && artifact.openable) {
    void navigator.clipboard?.writeText(artifact.target);
  }
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

function FolderRow({ group }: { group: DeliveredGroup }) {
  return (
    <Link
      to={folderHref(group)}
      className="flex items-center gap-3 border-t border-border px-4 py-3 transition-colors first:border-t-0 hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate text-body font-medium text-fg" title={group.title}>{group.title}</span>
      <span className="shrink-0 text-body text-muted">{artifactCountLabel(group)}</span>
    </Link>
  );
}

export function MadeArchive() {
  const delivered = usePoll(['delivered-archive'], () => listDelivered(50), 30_000);
  const [filter, setFilter] = useState<FilterId>('all');
  const groups = useMemo(
    () => (delivered.data ?? []).filter((g) => matchesFilter(g, filter)),
    [delivered.data, filter],
  );
  const sections = useMemo(() => {
    const byDay = new Map<string, DeliveredGroup[]>();
    for (const group of groups) {
      const heading = dayHeading(group.createdAt) || 'Earlier';
      const list = byDay.get(heading) ?? [];
      list.push(group);
      byDay.set(heading, list);
    }
    return [...byDay.entries()];
  }, [groups]);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6 animate-fade-in sm:px-10">
      <div>
        <p className="text-caption font-semibold uppercase tracking-wide text-faint">Home</p>
        <h1 className="text-h1 text-fg">Made</h1>
        <p className="mt-1 text-body text-muted">Finished work, by when it was made. Open a folder to see the drafts and files.</p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter made work">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-full px-3 py-1 text-small font-medium transition-colors cursor-pointer',
              filter === f.id ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {delivered.isLoading ? (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : sections.length === 0 ? (
        <p className="text-body text-muted">Nothing made yet — drafts, files, and sheets land here when Clem finishes them.</p>
      ) : (
        sections.map(([heading, rows]) => (
          <section key={heading} className="flex flex-col gap-2">
            <h2 className="text-caption font-semibold uppercase tracking-wide text-faint">{heading}</h2>
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              {rows.map((group) => <FolderRow key={group.id} group={group} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export function MadeFolder() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const delivered = usePoll(['delivered-archive'], () => listDelivered(50), 30_000);
  const group = (delivered.data ?? []).find((g) => String(g.id) === groupId);
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = (target: string) => {
    void navigator.clipboard?.writeText(target);
    setCopied(target);
    window.setTimeout(() => setCopied((cur) => (cur === target ? null : cur)), 1500);
  };

  if (delivered.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-10">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-40" />
      </div>
    );
  }
  if (!group) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-5 py-6 sm:px-10">
        <p className="text-body text-muted">That work is no longer in the archive.</p>
        <Link to="/made" className="mt-3 inline-block text-small font-semibold text-primary hover:underline">All made</Link>
      </div>
    );
  }

  const chatHref = group.sessionId ? `/chat/${encodeURIComponent(unifiedChatSessionId(group.sessionId))}` : null;
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
          return (
            <div key={artifact.target} className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
              <ArtifactGlyph artifact={artifact} />
              <span className="min-w-0 flex-1 truncate text-body text-fg" title={artifact.target}>{artifact.title}</span>
              {fileGone && <StatusPill tone="warning">file moved</StatusPill>}
              {http && artifact.openable ? (
                <button
                  type="button"
                  onClick={() => openArtifact(artifact)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint cursor-pointer"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                </button>
              ) : artifact.target ? (
                <button
                  type="button"
                  onClick={() => copyPath(artifact.target)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-primary hover:bg-primary-tint cursor-pointer"
                  title={artifact.target}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied === artifact.target ? 'Copied' : email ? 'Copy address' : 'Copy path'}
                </button>
              ) : (
                <span className="text-caption text-faint">No link</span>
              )}
            </div>
          );
        })}
      </div>

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
