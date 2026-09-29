/**
 * Which project a conversation works in.
 *
 * A conversation has one current project, or none, and it can change at any
 * time, the way its agent can. The change takes effect on the next turn: a
 * project's context is read when a turn starts, so a turn already running
 * keeps the project it started with. Which project each turn worked in is
 * recorded on that turn's own route marker; this module only moves the
 * pointer and remembers which projects the conversation has worked in.
 *
 * A project grants nothing: every gate downstream runs as it does for a
 * conversation outside any project.
 */
import { getSession, openEventLog } from '../runtime/harness/eventlog.js';
import { composeSession } from '../runtime/harness/session-composition.js';
import { getProject } from './project-record.js';
import { sessionProjectState, type SessionProjectState } from './session-project-state.js';

export { sessionProjectState, type SessionProjectState };

export type SessionProjectSetBy = 'owner' | 'clem';

export type SetSessionProjectResult =
  | { ok: true; changed: boolean; projectId: string | null; projectName: string | null }
  | { ok: false; reason: 'session_not_found' | 'project_not_found' | 'project_archived' | 'not_a_conversation' };

/**
 * Point a conversation at a project (by id), or at none with null. Setting
 * the project it already has is a no-op that still answers ok, so a client
 * may repeat the call safely before a send.
 */
export function setSessionProject(
  sessionId: string,
  projectId: string | null,
  opts: { by: SessionProjectSetBy },
): SetSessionProjectResult {
  const row = getSession(sessionId);
  if (!row) return { ok: false, reason: 'session_not_found' };
  // A Space dock, a workflow step or a background execution has its own
  // composition; a delegated task is given its project when it is created.
  if (composeSession({ sessionId, sessionKind: row.kind, metadata: row.metadata }).kind !== 'chat') {
    return { ok: false, reason: 'not_a_conversation' };
  }
  const wanted = typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
  const project = wanted ? getProject(wanted) : null;
  if (wanted && !project) return { ok: false, reason: 'project_not_found' };
  if (project && project.status !== 'active') return { ok: false, reason: 'project_archived' };
  const current = sessionProjectState(row.metadata);

  if ((project?.id ?? null) === current.projectId) {
    return { ok: true, changed: false, projectId: current.projectId, projectName: project?.name ?? current.projectName };
  }

  const db = openEventLog();
  const now = new Date().toISOString();
  // Touch only these keys, atomically: a running turn may be writing its own
  // bookkeeping into the same metadata column.
  if (project) {
    const projectIds = current.projectIds.includes(project.id) ? current.projectIds : [...current.projectIds, project.id];
    db.prepare(
      `UPDATE sessions SET
         metadata_json = json_set(COALESCE(metadata_json, '{}'),
           '$.projectId', ?, '$.projectName', ?, '$.projectIds', json(?), '$.projectSetBy', ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(project.id, project.name, JSON.stringify(projectIds), opts.by, now, sessionId);
  } else {
    db.prepare(
      `UPDATE sessions SET
         metadata_json = json_set(
           json_remove(COALESCE(metadata_json, '{}'), '$.projectId', '$.projectName'),
           '$.projectIds', json(?), '$.projectSetBy', ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(current.projectIds), opts.by, now, sessionId);
  }
  return { ok: true, changed: true, projectId: project?.id ?? null, projectName: project?.name ?? null };
}

/**
 * One line for a turn after the conversation moved between projects: what
 * was said earlier may have been about other work. Empty when the project
 * did not change since the previous turn. Per-turn text: it belongs after
 * the cache boundary, never in the stable prefix.
 */
export function projectHandoffNote(sessionId: string | null | undefined, sourceUserSeq?: number): string {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || Number(sourceUserSeq) <= 0) return '';
  let state: SessionProjectState;
  try {
    state = sessionProjectState(getSession(sessionId)?.metadata);
    const previous = openEventLog().prepare(`
      SELECT data_json FROM events
      WHERE session_id = ? AND type = 'turn_model_routed'
        AND json_extract(data_json, '$.sourceUserSeq') > 0
        AND json_extract(data_json, '$.sourceUserSeq') < ?
      ORDER BY seq DESC LIMIT 1
    `).get(sessionId, sourceUserSeq) as { data_json: string } | undefined;
    if (!previous) return '';
    const route = JSON.parse(previous.data_json) as { projectId?: unknown; projectName?: unknown };
    const previousId = typeof route.projectId === 'string' && route.projectId.trim() ? route.projectId.trim() : null;
    if (previousId === state.projectId) return '';
    const before = previousId
      ? `the project ${typeof route.projectName === 'string' && route.projectName.trim() ? route.projectName.trim() : 'this conversation was in before'}`
      : 'no project';
    const now = state.projectId
      ? `This turn works in the project ${state.projectName ?? 'named above'}; its context above applies from here.`
      : 'This turn works in no project.';
    return `[project-handoff] Earlier replies in this conversation were written in ${before}. ${now} `
      + 'Do not carry an earlier project\'s accounts, terms or decisions into this one unless the owner says they apply.';
  } catch {
    return '';
  }
}
