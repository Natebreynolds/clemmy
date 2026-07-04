import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  PENDING_ACTION_KINDS,
  PENDING_ACTION_STATUSES,
  formatPendingAction,
  getPendingAction,
  listPendingActions,
  parsePendingActionPayloadJson,
  queuePendingAction,
  recordPendingActionResult,
  type PendingActionKind,
  type PendingActionStatus,
} from '../runtime/harness/pending-actions.js';
import { textResult } from './shared.js';

const statusEnum = z.enum(PENDING_ACTION_STATUSES);
const kindEnum = z.enum(PENDING_ACTION_KINDS);

function currentSessionId(explicit?: string | null): string | null {
  const clean = explicit?.trim();
  if (clean) return clean;
  return getToolOutputContext()?.sessionId ?? null;
}

function maybeLog(sessionId: string | null, type: 'queued' | 'result', data: Record<string, unknown>): void {
  if (!sessionId) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: { kind: `pending_action_${type}`, ...data },
    });
  } catch {
    // Pending action state is the source of truth; event-log mirroring is best-effort.
  }
}

export function registerPendingActionTools(server: McpServer): void {
  server.tool(
    'pending_action_queue',
    [
      'Queue a fully prepared action payload before an irreversible external write/send/deploy or other approval-bound execution.',
      'This tool DOES NOT execute anything. Use it after you have gathered the facts, selected the exact tool, and built the exact payload.',
      'Then ask once at the write boundary, usually with request_approval({pendingActionId:<id>, ...}).',
      'After approval, execute the exact queued payload with the named tool, then call pending_action_record_result.',
    ].join(' '),
    {
      title: z.string().min(3).max(160),
      summary: z.string().min(8).max(2000).describe('Plain-language summary of what is queued and why.'),
      kind: kindEnum.describe('The action class. external_send/external_write/deployment are approval-bound in normal operation.'),
      toolName: z.string().min(1).max(160).describe('The exact tool to call after approval, e.g. composio_execute_tool or run_shell_command.'),
      payloadJson: z.string().min(2).max(100000).describe('Exact JSON payload for the execution tool. Use the tool schema shape, not prose.'),
      targetSummary: z.string().max(1000).optional().describe('Human-readable destination/recipient/resource.'),
      preview: z.string().max(8000).optional().describe('Human-reviewable content preview: email body, rows to update, command, deploy target, etc.'),
      risk: z.string().max(1000).optional().describe('Main risk/blast radius in plain language.'),
      rollback: z.string().max(1000).optional().describe('Undo/rollback note if available.'),
      sessionId: z.string().optional().describe('Optional session id. Defaults to the current harness session.'),
      createdBy: z.string().max(120).optional(),
    },
    async (input) => {
      let payload: unknown;
      try {
        payload = parsePendingActionPayloadJson(input.payloadJson);
      } catch (err) {
        return textResult(`pending_action_queue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const sessionId = currentSessionId(input.sessionId);
      const record = queuePendingAction({
        title: input.title,
        summary: input.summary,
        kind: input.kind as PendingActionKind,
        toolName: input.toolName,
        payload,
        targetSummary: input.targetSummary,
        preview: input.preview,
        risk: input.risk,
        rollback: input.rollback,
        sessionId,
        createdBy: input.createdBy ?? 'clementine',
      });
      maybeLog(sessionId, 'queued', {
        pendingActionId: record.id,
        toolName: record.toolName,
        kind: record.kind,
        payloadHash: record.payloadHash,
        targetSummary: record.targetSummary,
      });
      return textResult([
        `Pending action queued: ${record.id}`,
        formatPendingAction(record, { verbose: true }),
        '',
        'Next step: ask the user whether to execute this queued action. For a formal approval card, call request_approval with pendingActionId set to this id and include a concise preview. Do not execute the target tool until approval is granted.',
      ].join('\n'));
    },
  );

  server.tool(
    'pending_action_list',
    'List durable pending actions. Use before executing a user approval like "yes, send it" so you execute the queued payload, not a reconstructed guess.',
    {
      status: statusEnum.or(z.literal('all')).optional(),
      sessionId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ status, sessionId, limit }) => {
      const records = listPendingActions({
        status: (status ?? 'all') as PendingActionStatus | 'all',
        sessionId: currentSessionId(sessionId),
        limit,
      });
      if (records.length === 0) return textResult('No pending actions match.');
      return textResult(records.map((record) => formatPendingAction(record)).join('\n\n'));
    },
  );

  server.tool(
    'pending_action_get',
    'Read one queued action with its exact payload, status, approval id, preview, and result history.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const record = getPendingAction(id);
      if (!record) return textResult(`No pending action found with id ${id}.`);
      return textResult(`${formatPendingAction(record, { verbose: true })}\n\nPayload:\n${JSON.stringify(record.payload, null, 2)}`);
    },
  );

  server.tool(
    'pending_action_record_result',
    'After executing or cancelling a queued action, record the outcome so Clementine can report back and avoid duplicate sends/writes.',
    {
      id: z.string().min(1),
      status: z.enum(['executed', 'failed', 'cancelled']),
      resultSummary: z.string().min(1).max(4000),
    },
    async ({ id, status, resultSummary }) => {
      const updated = recordPendingActionResult(id, status, resultSummary);
      if (!updated) return textResult(`No pending action found with id ${id}.`);
      maybeLog(updated.sessionId, 'result', {
        pendingActionId: updated.id,
        status: updated.status,
        resultSummary: updated.resultSummary,
      });
      return textResult(`Pending action ${updated.id} marked ${updated.status}.\n${formatPendingAction(updated, { verbose: true })}`);
    },
  );
}
