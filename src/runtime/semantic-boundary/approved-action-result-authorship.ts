/** Optional display authorship only. These nominal objects grant no tool,
 * completion, account or effect authority. */
import { createHash } from 'node:crypto';
import pino from 'pino';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { completedStandaloneModelResponseReceipt } from '../harness/model-transport-observation.js';
import { modelUsageAttributionStorage, standaloneModelAccountingJobFromContext, standaloneModelAccountingJobBinding } from '../usage-log.js';
import { normalizeApprovedActionResultProjectionAuthorshipData,
  type ApprovedActionResultProjectionAuthorshipData } from '../harness/approved-action-result-projection-data.js';

export interface ApprovedActionResultProjectionResponse { readonly kind: 'approved_action_result_response' }
export interface ApprovedActionResultProjectionAuthorship { readonly kind: 'approved_action_result_authorship' }
type Receipt = Omit<ApprovedActionResultProjectionAuthorshipData, 'textDigest'>;
const logger = pino({ name: 'clementine.approved-action-result-authorship' });
const responses = new WeakMap<ApprovedActionResultProjectionResponse, { receipt: Receipt; raw: string }>();
const authorships = new WeakMap<ApprovedActionResultProjectionAuthorship, {
  evidenceDigest: string; message: string; data: Readonly<ApprovedActionResultProjectionAuthorshipData>;
}>();
const boundedJson = (value: unknown) => closedCanonicalJson(value,
  { maxDepth: 8, maxNodes: 128, maxStringBytes: 4_096, maxTotalBytes: 8_192 });

/** Only the actual SDK original, completed under this exact job, can bind the
 * structured final output. A clone, supplied IDs or aggregate prose cannot. */
export function captureApprovedActionResultProjectionResponse(rawResponses: readonly unknown[] | undefined,
  raw: unknown): ApprovedActionResultProjectionResponse | undefined {
  // Diagnostics only: which shape check kept the model's words off the card.
  const why = (reason: string): undefined => {
    logger.warn({ reason, responses: rawResponses?.length ?? 0 }, 'approval result response could not be captured');
    return undefined;
  };
  try {
    if (!rawResponses || rawResponses.length !== 1) return why('not_one_response');
    const original = rawResponses[0]; const receipt = completedStandaloneModelResponseReceipt(original);
    const job = standaloneModelAccountingJobFromContext(modelUsageAttributionStorage.getStore());
    const current = job && standaloneModelAccountingJobBinding(job);
    if (!receipt || receipt.operation !== 'approval_result_projection' || !current
      || current.operation !== receipt.operation || current.usageJobId !== receipt.usageJobId
      || current.operationId !== receipt.operationId || current.revisionDigest !== receipt.revisionDigest) return why(!receipt ? 'no_completed_receipt' : !current ? 'no_accounting_job' : 'receipt_job_mismatch');
    const output = (original as { output?: unknown }).output;
    if (!Array.isArray(output) || output.length > 16 || output.some(row => !row || typeof row !== 'object'
      || (row.type !== 'message' && row.type !== 'reasoning'))) return why('output_shape');
    const messages = output.filter(row => row.type === 'message');
    if (messages.length !== 1) return why('not_one_message');
    const message = messages[0] as { type?: unknown; role?: unknown; status?: unknown; content?: unknown };
    if (message.type !== 'message' || message.role !== 'assistant' || message.status !== 'completed'
      || !Array.isArray(message.content) || message.content.length !== 1) return why('message_shape');
    const part = message.content[0] as { type?: unknown; text?: unknown };
    if (part.type !== 'output_text' || typeof part.text !== 'string' || Buffer.byteLength(part.text) > 8_192
      || boundedJson(JSON.parse(part.text)) !== boundedJson(raw)) return why('text_part_mismatch');
    const token = Object.freeze({ kind: 'approved_action_result_response' as const });
    const { operation: _, ...data } = receipt;
    responses.set(token, { receipt: Object.freeze(data), raw: boundedJson(raw) });
    return token;
  } catch (error) { return why(error instanceof Error ? error.message : String(error)); }
}

export function bindApprovedActionResultProjectionAuthorship(response: ApprovedActionResultProjectionResponse | undefined,
  raw: unknown, message: string | null, evidenceDigest: string): ApprovedActionResultProjectionAuthorship | undefined {
  // Diagnostics only: which check kept Clem's words off the card. Live 10-20
  // (DeepSeek brain, Windows tester on a different brain): the job rejected
  // the wording as "authorship_unbound" and nothing said which of these it was.
  const why = (reason: string): undefined => {
    logger.warn({ reason, messageLength: typeof message === 'string' ? message.length : null }, 'approval result authorship could not be bound');
    return undefined;
  };
  try {
    const captured = response && responses.get(response);
    if (!captured) return why('response_not_captured');
    if (typeof message !== 'string' || !message.trim()) return why('no_message');
    if (message.length > 600) return why('message_too_long');
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) return why('evidence_digest_shape');
    if (captured.receipt.revisionDigest !== evidenceDigest) return why('revision_digest_mismatch');
    if (captured.raw !== boundedJson(raw)) return why('raw_mismatch');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof (raw as { message?: unknown }).message !== 'string') return why('raw_message_shape');
    if ((raw as { message: string }).message.trim() !== message) return why('message_mismatch');
    const data = normalizeApprovedActionResultProjectionAuthorshipData({ ...captured.receipt,
      textDigest: createHash('sha256').update(message).digest('hex') });
    if (!data) return why('authorship_data_shape');
    const token = Object.freeze({ kind: 'approved_action_result_authorship' as const });
    authorships.set(token, { message, evidenceDigest, data: Object.freeze(data) });
    return token;
  } catch (error) { return why(error instanceof Error ? error.message : String(error)); }
}

export function approvedActionResultProjectionAuthorship(result: {
  message: string | null; evidenceDigest: string; authorship?: ApprovedActionResultProjectionAuthorship;
}): Readonly<ApprovedActionResultProjectionAuthorshipData> | undefined {
  const value = result.authorship && authorships.get(result.authorship);
  return value && value.message === result.message && value.evidenceDigest === result.evidenceDigest ? value.data : undefined;
}
