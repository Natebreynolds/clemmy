import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  requestAutomationRecurrenceActivation,
  type RequestAutomationRecurrenceActivationResultV1,
} from '../execution/automation-recurrence-runtime.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

const EXACT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;
const MAX_RESULT_CHARS = 32_000;

export interface AutomationRecurrenceToolOptions {
  acceptedSource?: () => { sessionId: string; sourceUserSeq: number } | undefined;
  request?: typeof requestAutomationRecurrenceActivation;
}

function acceptedSource(
  override?: AutomationRecurrenceToolOptions['acceptedSource'],
): { sessionId: string; sourceUserSeq: number } | undefined {
  const supplied = override?.();
  const context = supplied ?? harnessRunContextStorage.getStore();
  const sourceUserSeq = context?.sourceUserSeq;
  if (
    !context
    || !EXACT_REF_RE.test(context.sessionId)
    || !Number.isSafeInteger(sourceUserSeq)
    || (sourceUserSeq ?? 0) < 1
  ) return undefined;
  return { sessionId: context.sessionId, sourceUserSeq: sourceUserSeq! };
}

function renderResult(value: RequestAutomationRecurrenceActivationResultV1) {
  if (!value.ok) {
    return textResult(JSON.stringify(value), { maxChars: MAX_RESULT_CHARS, isError: true });
  }
  return textResult(JSON.stringify({
    ok: true,
    activation: {
      activationId: value.activation.activationId,
      status: value.activation.status,
      workflowId: value.activation.workflowId,
    },
    preview: {
      previewId: value.preview.previewId,
      previewDigest: value.preview.previewDigest,
      workflowId: value.preview.workflowId,
      interval: value.preview.interval,
      firstFireAt: value.preview.firstFireAt,
      effect: 'read',
      externalWrites: false,
      sends: false,
      configurationOnly: true,
    },
    approval: {
      approvalId: value.approval.approvalId,
      status: value.approval.status,
      expiresAt: value.approval.expiresAt,
    },
    approvalCreated: value.approvalCreated,
    cardCreated: value.cardCreated,
    recurrenceAuthority: 'none_until_formal_approval_and_exact_reconciliation',
    nextBoundary: 'formal_recurrence_consent',
  }), { maxChars: MAX_RESULT_CHARS });
}

/** Chat-facing staging surface after a clean pilot. The tool cannot approve its
 * own card, enable arbitrary workflow bytes, queue an occurrence, or execute a
 * provider call; all of those remain separate durable boundaries. */
export function registerAutomationRecurrenceTools(
  server: McpServer,
  options: AutomationRecurrenceToolOptions = {},
): void {
  const request = options.request ?? requestAutomationRecurrenceActivation;
  server.tool(
    'automation_recurrence_request',
    'Turn one exact successful read-pilot run into a disabled interval preview and separate formal recurrence-consent card. This tool cannot approve, activate, schedule, queue, execute, write externally, or send.',
    {
      pilot_run_id: z.string().regex(EXACT_REF_RE),
      every: z.number().int().min(1).max(1_000_000),
      unit: z.enum(['minute', 'hour', 'day']),
      overlap_policy: z.enum(['skip', 'queue_one']),
      catch_up_policy: z.enum(['skip', 'run_once']),
    },
    async ({ pilot_run_id, every, unit, overlap_policy, catch_up_policy }) => {
      const source = acceptedSource(options.acceptedSource);
      if (!source) {
        return textResult(JSON.stringify({
          ok: false,
          code: 'accepted_source_required',
          reason: 'An exact accepted chat source must own the formal recurrence request.',
        }), { maxChars: MAX_RESULT_CHARS, isError: true });
      }
      let requested: RequestAutomationRecurrenceActivationResultV1;
      try {
        requested = request({
          pilotRunId: pilot_run_id,
          approvalSessionId: source.sessionId,
          cadence: {
            every,
            unit,
            overlapPolicy: overlap_policy,
            catchUpPolicy: catch_up_policy,
          },
        });
      } catch (error) {
        requested = {
          ok: false,
          code: 'recurrence_request_failed',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      return renderResult(requested);
    },
  );
}
