import { projectPagePlace, projectPages, projectPageTitle, type ProjectOverview, type ProjectPageView } from '@clem/chat-engine';
import { artifactCountLabel, deliveredFileRef, groupArtifacts, type DeliveredGroup } from './delivered';
import type { SessionFileRef } from './session-files';

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** A historical association is useful for results, but never a promise that
 * continuing that conversation will still work inside this project. */
export function projectResumeConversation(overview: Pick<ProjectOverview, 'conversations'>) {
  return overview.conversations.filter(conversation => conversation.current)
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0] ?? null;
}

export function projectConversationIds(overview: Pick<ProjectOverview, 'conversations'>): string[] {
  return [...new Set(overview.conversations.map(conversation => conversation.sessionId).filter(Boolean))].sort();
}

/** Only explicit resource relationships are Spaces. A matching name, file
 * path, or conversation title does not establish a link. */
export function projectResumeSpaces(overview: Pick<ProjectOverview, 'resources'>) {
  const seen = new Set<string>();
  return overview.resources.flatMap(resource => {
    if (resource.kind !== 'space' || !resource.ref?.trim() || seen.has(resource.ref)) return [];
    seen.add(resource.ref);
    return [{ id: resource.ref, title: resource.label?.trim() || resource.ref }];
  });
}

interface ResultRow { key: string; title: string; detail: string; createdAt: string; conversationSessionId?: string }
export type ProjectResumeResult = ResultRow & (
  | { kind: 'page'; page: ProjectPageView }
  | { kind: 'file'; fileRef: SessionFileRef }
  | { kind: 'group'; group: DeliveredGroup }
);

/** `groups` must come from the session-scoped delivered query. Its server
 * follows recorded worker lineage, so producing IDs may differ from
 * the root conversations. Task text and status never fabricate results. */
export function projectResumeResults(overview: Pick<ProjectOverview, 'pages' | 'conversations'>, groups: readonly DeliveredGroup[]): ProjectResumeResult[] {
  const members = new Set(projectConversationIds(overview));
  const rows: ProjectResumeResult[] = projectPages(overview).map(page => ({
    key: `page:${page.id}`, kind: 'page', page,
    title: projectPageTitle(page), detail: projectPagePlace(page), createdAt: page.madeAt,
    conversationSessionId: page.sessionId && members.has(page.sessionId) ? page.sessionId : undefined,
  }));
  const seen = new Set<string>();
  for (const group of [...groups].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))) {
    const artifacts = groupArtifacts(group);
    const files = artifacts.filter(artifact => deliveredFileRef(artifact));
    for (const artifact of files) {
      const ref = deliveredFileRef(artifact)!;
      const key = `file:${ref.fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const origin = artifact.conversationSessionId !== undefined ? artifact.conversationSessionId : group.conversationSessionId;
      const conversationSessionId = origin === undefined ? (group.sessionId && members.has(group.sessionId) ? group.sessionId : undefined) : origin ?? undefined;
      rows.push({ key, kind: 'file', fileRef: ref, conversationSessionId, title: artifact.title?.trim() || ref.name,
        detail: group.title, createdAt: artifact.createdAt || group.createdAt });
    }
    // Drafts, external documents and older records keep their real result
    // folder. A raw path is never turned into an invented local file ref.
    if (files.length < artifacts.length || artifacts.length === 0) {
      rows.push({ key: `group:${group.id}`, kind: 'group', group, title: group.title,
        conversationSessionId: group.conversationSessionId === undefined ? (group.sessionId && members.has(group.sessionId) ? group.sessionId : undefined) : group.conversationSessionId ?? undefined,
        detail: artifactCountLabel(group), createdAt: group.createdAt });
    }
  }
  return rows.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}
