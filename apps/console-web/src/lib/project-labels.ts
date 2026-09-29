/**
 * Which project a waiting item belongs to.
 *
 * Needs you and the Inbox list approvals, questions and plans by the session
 * that asked. One read per screen turns those session ids into project
 * labels (lib/projects). A session in no project has no label, and the item
 * is drawn exactly as it always was.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { projectLabelsBySession, type SessionProjectLabel } from '@clem/chat-engine';
import { getProjectLabels } from './projects';

export type { SessionProjectLabel } from '@clem/chat-engine';

/** What a waiting item may say about where it came from. */
export interface LabelSource {
  sessionId?: string | null;
  targetSessionId?: string | null;
  /** A background task's id; its run session is `background:<id>`. */
  taskId?: string | null;
}

/** The session id as the server keeps it: without the list's `harness:` prefix. */
export function labelSessionId(sessionId: string | null | undefined): string {
  const id = (sessionId ?? '').trim();
  return id.startsWith('harness:') ? id.slice('harness:'.length) : id;
}

/** Every session an item could be labelled by, the asking session first. */
export function labelCandidates(source: LabelSource): string[] {
  const ids = [labelSessionId(source.sessionId), labelSessionId(source.targetSessionId)];
  const task = (source.taskId ?? '').trim();
  if (task) ids.push(task.startsWith('background:') ? task : `background:${task}`);
  return [...new Set(ids.filter(Boolean))];
}

/** The ids to ask about, once each, in a stable order so the same screen asks the same question. */
export function labelSessionIds(sources: readonly LabelSource[], max = 200): string[] {
  return [...new Set(sources.flatMap(labelCandidates))].sort().slice(0, max);
}

/** The label for one item; undefined when it belongs to no project. */
export function labelFor(source: LabelSource, labels: ReadonlyMap<string, SessionProjectLabel>): SessionProjectLabel | undefined {
  for (const id of labelCandidates(source)) {
    const label = labels.get(id);
    if (label) return label;
  }
  return undefined;
}

const NO_LABELS: ReadonlyMap<string, SessionProjectLabel> = new Map();

/**
 * Labels for what a screen lists. A failed read labels nothing: the items
 * are still the items, and a label is never guessed.
 */
export function useProjectLabels(sources: readonly LabelSource[]) {
  const ids = labelSessionIds(sources);
  const key = ids.join(',');
  const query = useQuery({
    queryKey: ['project-records', 'labels', key],
    queryFn: () => getProjectLabels(ids),
    enabled: ids.length > 0,
    staleTime: 30_000,
    retry: false,
    // The list keeps its labels while a changed list is asked about.
    placeholderData: (previous) => previous,
  });
  const labels = useMemo(() => (query.data ? projectLabelsBySession(query.data) : NO_LABELS), [query.data]);
  return (source: LabelSource) => labelFor(source, labels);
}
