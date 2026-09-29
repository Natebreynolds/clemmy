/**
 * What a task takes from the conversation it was started in, when nothing
 * was said about who should do it: the conversation's project, and the
 * conversation's own agent when that agent is assigned to the project (or
 * when there is no project). Nobody is chosen here; the router is asked
 * only where a caller delegates on purpose.
 *
 * Every path that moves a conversation's work into the background comes
 * through one place, and that place asks this. Without it, work the owner
 * started inside a project ran outside it: as Clem, with no project context,
 * and what it learned was kept for everywhere.
 */
import { getAgentRecord } from '../agents/agent-record.js';
import { sessionAgentState } from '../agents/session-agent-state.js';
import type { BackgroundTaskDelegation } from '../execution/background-tasks.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { getAssignment, getProject } from './project-record.js';
import { sessionProjectState } from './session-project-state.js';

export function inheritedTaskDelegation(
  sessionId: string | null | undefined,
  sourceUserSeq?: number,
): BackgroundTaskDelegation | null {
  if (!sessionId) return null;
  try {
    const row = getSession(sessionId);
    if (!row || row.kind !== 'chat') return null;
    const metadata = row.metadata ?? {};
    const projectId = sessionProjectState(metadata).projectId;
    const found = projectId ? getProject(projectId) : null;
    const project = found && found.status === 'active' ? found : null;
    const current = sessionAgentState(metadata);
    const saved = current.agentId ? getAgentRecord(current.agentId) : null;
    const agent = saved && (!project || getAssignment(project.id, saved.id)) ? saved : null;
    if (!project && !agent) return null;
    return {
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      agentCreatedAt: agent?.createdAt ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      assignedBy: agent && metadata.agentSetBy !== 'clem' ? 'owner' : 'clem',
      ...(typeof sourceUserSeq === 'number' && Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0
        ? { originSourceUserSeq: sourceUserSeq } : {}),
    };
  } catch {
    return null;
  }
}
