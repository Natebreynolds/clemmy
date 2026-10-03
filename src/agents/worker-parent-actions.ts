/**
 * Outside actions a worker was refused because only its parent may run them
 * (compose-only). Recorded where the refusal happens, as host facts, so the
 * worker's result can say what was not done there whatever the worker wrote.
 */
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';

const EVENT = 'worker_compose_only';

export function recordWorkerComposeOnly(tool: string): void {
  const run = harnessRunContextStorage.getStore();
  if (!run?.workerScope || !run.sessionId) return;
  try {
    appendEvent({ sessionId: run.sessionId, turn: 0, role: 'system', type: EVENT, data: {
      tool: tool.slice(0, 160),
      ...(run.behaviorScopeId ? { scopeId: run.behaviorScopeId } : {}),
      ...(run.sourceUserSeq ? { sourceUserSeq: run.sourceUserSeq } : {}),
    } });
  } catch { /* the refusal itself stands; this record is what the result reports */ }
}

/** The latest event seq in a session, to read a worker's refusals from after it. */
export function sessionHighWater(sessionId: string): number {
  try { return listEvents(sessionId, { limit: 1, desc: true }).at(0)?.seq ?? 0; } catch { return 0; }
}

/** The tools a worker was refused in a session since a point, for one worker scope when given. */
export function workerComposeOnlyActions(input: { sessionId: string; sinceSeq: number; scopeId?: string | null }): string[] {
  try {
    return listEvents(input.sessionId, { sinceSeq: input.sinceSeq, types: [EVENT] })
      .filter((event) => event.seq > input.sinceSeq && (!input.scopeId || event.data.scopeId === input.scopeId))
      .map((event) => String(event.data.tool ?? '')).filter(Boolean);
  } catch { return []; }
}

/** The host's own line about those actions, added to the worker's result. */
export function parentActionsNote(tools: readonly string[]): string {
  if (tools.length === 0) return '';
  const names = [...new Set(tools)].slice(0, 8).join(', ');
  return `[Host record] ${tools.length} outside action${tools.length === 1 ? ' was' : 's were'} refused in this worker because only `
    + `the parent may run ${tools.length === 1 ? 'it' : 'them'}: ${names}. Unless the result above includes their exact payloads, `
    + `${tools.length === 1 ? 'it was' : 'they were'} not done; nothing was sent.`;
}
