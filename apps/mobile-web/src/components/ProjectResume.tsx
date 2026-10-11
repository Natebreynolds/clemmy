import { useState } from 'preact/hooks';
import { projectPages, projectPageTitle, type ProjectOverview, type ProjectPageView } from '@clem/chat-engine';
import { listDelivered, type DeliveredArtifact, type DeliveredGroup } from '../lib/api';
import { haptic } from '../lib/native-bridge';
import { useScreenData } from '../lib/use-screen-data';
import type { SessionFileRef } from '../lib/session-files';
import type { ChatHandoff } from '../screens/Chats';
import { SavedFileSheet } from './CompletedFiles';
import { relativeTime } from './Approvals';

const Arrow = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
const stamp = (value: string) => Date.parse(value) || 0;
type Result = { key: string; title: string; at: string; source?: string } & (
  | { kind: 'page'; page: ProjectPageView }
  | { kind: 'file'; ref: SessionFileRef }
  | { kind: 'record'; url?: string; count: number }
);

function sourceOf(group: DeliveredGroup, members: Set<string>, artifact?: DeliveredArtifact): string | undefined {
  const source = artifact?.conversationSessionId !== undefined ? artifact.conversationSessionId : group.conversationSessionId;
  return source === undefined ? (group.sessionId && members.has(group.sessionId) ? group.sessionId : undefined) : source ?? undefined;
}

/** Reads only explicitly requested project conversations and their server-
 * recorded worker descendants. It never falls back to the global shelf. */
async function loadResults(ids: string[]): Promise<DeliveredGroup[]> {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += 50) batches.push(ids.slice(index, index + 50));
  const found = new Map<number, DeliveredGroup>();
  for (const response of await Promise.all(batches.map(sessionIds => listDelivered(24, { sessionIds })))) {
    for (const group of response.groups) found.set(group.id, group);
  }
  return [...found.values()].sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt));
}

export function ProjectResume({ overview, onOpenChat, onOpenSpace, onOpenPage }: {
  overview: ProjectOverview;
  onOpenChat: (handoff: ChatHandoff) => void;
  onOpenSpace: (id: string) => void;
  onOpenPage: (page: ProjectPageView) => void;
}) {
  const ids = [...new Set(overview.conversations.map(conversation => conversation.sessionId).filter(Boolean))].sort();
  const members = new Set(ids);
  const results = useScreenData(() => loadResults(ids), { intervalMs: 30_000, resourceKey: `project-results:${overview.project.id}:${ids.join(',')}`, disabled: ids.length === 0 });
  const latest = overview.conversations.filter(conversation => conversation.current).sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt))[0];
  const [file, setFile] = useState<SessionFileRef | null>(null);
  const [allResults, setAllResults] = useState(false);
  const [allSpaces, setAllSpaces] = useState(false);
  const seen = new Set<string>();
  const spaces = overview.resources.filter(resource => {
    if (resource.kind !== 'space' || !resource.ref?.trim() || seen.has(resource.ref)) return false;
    seen.add(resource.ref);
    return true;
  });
  const rows: Result[] = projectPages(overview).map(page => ({ key: `page:${page.id}`, kind: 'page', page, title: projectPageTitle(page), at: page.madeAt, source: page.sessionId && members.has(page.sessionId) ? page.sessionId : undefined }));
  seen.clear();
  for (const group of results.data ?? []) {
    let previewCount = 0;
    for (const artifact of group.artifacts ?? []) {
      const ref = artifact.fileRef;
      if (artifact.kind !== 'file' || artifact.stillExists === false || !ref?.fileId || !ref.sessionId || !ref.name || typeof ref.folder !== 'string') continue;
      previewCount += 1;
      if (seen.has(ref.fileId)) continue;
      seen.add(ref.fileId);
      rows.push({ key: `file:${ref.fileId}`, kind: 'file', ref, title: artifact.title || ref.name, at: artifact.createdAt || group.createdAt, source: sourceOf(group, members, artifact) });
    }
    if (previewCount < (group.artifacts?.length ?? 0) || !group.artifacts?.length) {
      const target = group.url || group.artifacts?.find(artifact => /^https?:\/\//i.test(artifact.target))?.target;
      rows.push({ key: `result:${group.id}`, kind: 'record', title: group.title, at: group.createdAt, count: group.artifactCount, source: sourceOf(group, members), url: target && /^https?:\/\//i.test(target) ? target : undefined });
    }
  }
  rows.sort((a, b) => stamp(b.at) - stamp(a.at));
  const archived = overview.project.status === 'archived';
  const start = () => { haptic('light'); onOpenChat({ projectId: overview.project.id, projectName: overview.project.name }); };

  return <div class="project-resume">
    {latest ? <button type="button" class="project-resume-continue" onClick={() => { haptic('light'); onOpenChat({ sessionId: latest.sessionId, title: latest.title ?? undefined }); }}>
      <span><strong>{archived ? 'Open' : 'Continue'} {latest.title?.trim() || 'the latest conversation'}</strong><span>With {latest.agentName || 'Clem'} · {relativeTime(latest.updatedAt)}</span></span><Arrow />
    </button> : !archived ? <button type="button" class="project-resume-continue" onClick={start}><span><strong>Start a conversation in {overview.project.name}</strong><span>Conversations and finished results stay together here.</span></span><Arrow /></button> : null}
    {latest && !archived ? <button type="button" class="project-resume-new" onClick={start}>New conversation</button> : null}
    <section id="project-results" aria-labelledby="project-results-title">
      <h2 id="project-results-title" class="section-head">Recent results</h2>
      {results.loading ? <p class="section-empty" role="status">Loading finished results…</p> : null}
      {results.error ? <p class="project-hint" role="alert">Finished files could not be loaded. <button type="button" class="link-btn" onClick={() => void results.refresh()}>Retry</button></p> : null}
      {!results.loading && !results.error && rows.length === 0 ? <p class="section-empty">No finished results recorded here yet.</p> : null}
      <ul class="project-resume-list">{(allResults ? rows : rows.slice(0, 3)).map(row => <li key={row.key}>
        {row.kind === 'record' ? row.url ? <a class="project-resume-result" href={row.url} target="_blank" rel="noopener noreferrer"><span><strong>{row.title}</strong><span>{row.count} {row.count === 1 ? 'item' : 'items'} · {relativeTime(row.at)}</span></span><Arrow /></a> : <div class="project-resume-result"><span><strong>{row.title}</strong><span>{row.count} {row.count === 1 ? 'item' : 'items'} · {relativeTime(row.at)}</span></span></div> : <button type="button" class="project-resume-result" onClick={() => { haptic('light'); if (row.kind === 'page') onOpenPage(row.page); else setFile(row.ref); }}><span><strong>{row.title}</strong><span>{relativeTime(row.at)}</span></span><span class="project-resume-open">Open</span></button>}
        {row.source ? <button type="button" class="project-resume-source" onClick={() => { haptic('light'); onOpenChat({ sessionId: row.source }); }}>Source conversation</button> : null}
      </li>)}</ul>
      {rows.length > 3 ? <button type="button" class="project-resume-new" aria-expanded={allResults} onClick={() => setAllResults(value => !value)}>{allResults ? 'Show recent results' : `Show more results (${rows.length})`}</button> : null}
    </section>
    <section aria-labelledby="project-spaces-title">
      <h2 id="project-spaces-title" class="section-head">Linked Spaces</h2>
      {spaces.length === 0 ? <p class="section-empty">No Spaces are linked to this project.</p> : <ul class="project-resume-list">{(allSpaces ? spaces : spaces.slice(0, 3)).map(space => <li key={space.id}><button type="button" class="project-resume-result" onClick={() => { haptic('light'); onOpenSpace(space.ref!); }}><span><strong>{space.label || space.ref}</strong></span><Arrow /></button></li>)}</ul>}
      {spaces.length > 3 ? <button type="button" class="project-resume-new" aria-expanded={allSpaces} onClick={() => setAllSpaces(value => !value)}>{allSpaces ? 'Show fewer Spaces' : `Show all Spaces (${spaces.length})`}</button> : null}
    </section>
    <SavedFileSheet fileRef={file} onClose={() => setFile(null)} returnLabel="Project" />
  </div>;
}
