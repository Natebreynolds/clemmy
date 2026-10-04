/**
 * What a worker actually did, from the host's own ledger.
 *
 * A worker's reply is its own account of its item. The host records every call
 * the worker made: which business tools settled, how, and which were refused
 * before anything was sent. That record travels with the worker's result, so
 * the parent can tell a real outcome from a claimed one, and a success the
 * worker never backed with work is not kept for reuse.
 */
import { listEvents } from './eventlog.js';

export interface WorkerToolTally {
  succeeded: number;
  failed: number;
  refusedBeforeDispatch: number;
}

export interface WorkerCallRecord {
  byTool: Record<string, WorkerToolTally>;
  /** At least one business call settled successfully. */
  businessCallSucceeded: boolean;
  /** The worker tried business work: something settled or was refused. */
  businessCallAttempted: boolean;
}

const CARRIER_NAMES = new Set(['call_tool', 'work_call', 'composio_execute_tool']);

function innerToolName(call: { name?: unknown; argumentsJson?: unknown }): string {
  const name = typeof call.name === 'string' ? call.name : '';
  if (!CARRIER_NAMES.has(name) || typeof call.argumentsJson !== 'string') return name;
  try {
    const args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
    const inner = typeof args.name === 'string' ? args.name : typeof args.tool_slug === 'string' ? args.tool_slug : '';
    return inner || name;
  } catch {
    return name;
  }
}

/** The worker's calls for one accepted source of its session. */
export function workerCallRecord(sessionId: string, sourceUserSeq: number): WorkerCallRecord {
  const byTool: Record<string, WorkerToolTally> = {};
  const tally = (tool: string): WorkerToolTally => (byTool[tool] ??= { succeeded: 0, failed: 0, refusedBeforeDispatch: 0 });
  let businessCallSucceeded = false;
  for (const event of listEvents(sessionId, { sinceSeq: sourceUserSeq - 1, types: ['tool_attempt_settled', 'guardrail_tripped'] })) {
    const data = event.data;
    if (typeof data.sourceUserSeq === 'number' && data.sourceUserSeq !== sourceUserSeq) continue;
    if (event.type === 'tool_attempt_settled') {
      if (data.businessCall !== true || typeof data.tool !== 'string') continue;
      if (data.kind === 'succeeded') {
        tally(data.tool).succeeded += 1;
        businessCallSucceeded = true;
      } else {
        tally(data.tool).failed += 1;
      }
    } else if (data.kind === 'refused_pre_dispatch' && Array.isArray(data.calls)) {
      for (const call of data.calls as Array<{ name?: unknown; argumentsJson?: unknown }>) {
        const tool = innerToolName(call);
        if (tool) tally(tool).refusedBeforeDispatch += 1;
      }
    }
  }
  return { byTool, businessCallSucceeded, businessCallAttempted: Object.keys(byTool).length > 0 };
}

/** The record as the parent reads it beside the worker's own reply. */
export function renderWorkerCallRecord(record: WorkerCallRecord): string {
  const lines = Object.entries(record.byTool).map(([tool, t]) => {
    const parts = [
      `${t.succeeded} succeeded`,
      ...(t.failed > 0 ? [`${t.failed} failed`] : []),
      ...(t.refusedBeforeDispatch > 0 ? [`${t.refusedBeforeDispatch} refused before dispatch — no request reached the provider`] : []),
    ];
    return `- ${tool}: ${parts.join('; ')}`;
  });
  return [
    '[Host record of this worker\'s calls — written by Clementine, not the worker]',
    ...(lines.length > 0 ? lines : ['- No business tool ran.']),
    'Where the worker\'s account disagrees with this record, the record is right: rerun the item with a correction rather than relying on that account.',
  ].join('\n');
}
