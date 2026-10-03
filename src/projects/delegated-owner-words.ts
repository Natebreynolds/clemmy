/**
 * In a job Clem handed to an agent, the run's input is the job Clem wrote,
 * not the owner's words. What the owner allowed or refused comes from the
 * message they sent when they asked for the job. Undefined when this run is
 * not such a job, or that message cannot be read, so the caller keeps its
 * ordinary reading and no refusal the owner gave is lost.
 */
import { getSession, listEvents } from '../runtime/harness/eventlog.js';

export async function delegatedJobOwnerWords(sessionId: string | null | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  try {
    const taskId = (getSession(sessionId)?.metadata as Record<string, unknown> | null | undefined)?.delegatedTaskId;
    if (typeof taskId !== 'string' || !taskId) return undefined;
    const { getBackgroundTask } = await import('../execution/background-tasks.js');
    const task = getBackgroundTask(taskId);
    const origin = task?.originSessionId;
    const seq = task?.delegation?.originSourceUserSeq;
    if (!origin || typeof seq !== 'number' || seq <= 0) return undefined;
    const source = listEvents(origin, { sinceSeq: seq - 1, types: ['user_input_received'], limit: 1 })
      .find((event) => event.seq === seq && event.role === 'user');
    return typeof source?.data?.text === 'string' ? source.data.text : undefined;
  } catch { return undefined; }
}
