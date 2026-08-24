/**
 * Host-owned, no-tools authoring dispatcher for retained pilot requests.
 *
 * This is deliberately a single model step, not an agent loop. The model can
 * return only a typed contract candidate. Exact output-schema admission and
 * the advancement saga's claim/CAS gates run before any full pilot card is
 * staged; the model cannot approve, queue, invoke, schedule, or choose a
 * Workspace/provider.
 */
import type { Model, ModelRequest } from '@openai/agents';

import {
  admitModelStep,
  codexOneStep,
} from '../runtime/harness/codex-one-step.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  blockAutomationPilotAuthoringRequest,
  claimAutomationPilotAuthoringRequest,
  listAutomationPilotAdvancements,
  loadAutomationPilotAdvancement,
  recordAutomationPilotAuthoringAttemptFailure,
  submitAutomationPilotAuthoringResult,
  type AutomationPilotAuthoringRequestV1,
  type AutomationPilotAuthoringResultV1,
} from './automation-pilot-advancement-control-plane.js';
import {
  attestAutomationPilotOutputShape,
  automationPilotAuthoringPrompt,
  validateAutomationPilotAuthoringOutputShape,
  type AutomationPilotOutputShapeReceiptV1,
} from './automation-pilot-output-shape-contract.js';

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

const AUTHORING_OUTPUT_TYPE: Exclude<ModelRequest['outputType'], 'text'> = {
  type: 'json_schema',
  name: 'automation_pilot_contract_candidate',
  // Provider transports should enforce JSON framing. The exact dynamic-key
  // contract remains host-validated against both schemas after the response.
  strict: false,
  schema: {
    type: 'object',
    properties: {
      version: { type: 'integer', const: 1 },
      requestId: { type: 'string' },
      requestDigest: { type: 'string' },
      contract: { type: 'object' },
      workflowInputs: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['version', 'requestId', 'requestDigest', 'contract', 'workflowInputs'],
    additionalProperties: false,
  },
};

export interface AutomationPilotAuthoringPortV1 {
  author(input: {
    request: AutomationPilotAuthoringRequestV1;
    requestDigest: string;
    outputShape: AutomationPilotOutputShapeReceiptV1;
    prompt: string;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export interface ProductionAutomationPilotAuthoringPortOptions {
  /** Exact external model-transport seam for isolated vertical proofs. The
   * production host omits this and resolves through the configured
   * model adapter and credential router. */
  resolveModel?: (modelId?: string) => Promise<Model> | Model;
}

export type ReconcileAutomationPilotAuthoringDispatchResult =
  | {
      ok: true;
      state: 'not_required' | 'busy' | 'retry' | 'submitted' | 'blocked';
      advancementId: string;
      detail?: string;
    }
  | { ok: false; code: string; reason: string; advancementId: string };

export interface ReconcileAutomationPilotAuthoringDispatchesResult {
  scanned: number;
  busy: number;
  retry: number;
  submitted: number;
  blocked: number;
  failed: number;
}

function canonicalCandidate(value: unknown): AutomationPilotAuthoringResultV1 {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return JSON.parse(closedCanonicalJson(parsed, {
    maxDepth: 48,
    maxNodes: 250_000,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 4_194_304,
  })) as AutomationPilotAuthoringResultV1;
}

export function createProductionAutomationPilotAuthoringPort(
  options: ProductionAutomationPilotAuthoringPortOptions = {},
): AutomationPilotAuthoringPortV1 {
  return {
    async author(input) {
      const model = resolveRoleModel('brain');
      const step = await codexOneStep({
        modelId: model.modelId,
        systemInstructions: [
          'You are a constrained workflow-contract authoring node.',
          'Return only the requested JSON candidate. You have no tools and no execution or approval authority.',
          'Never infer paths from names or descriptions; use only the supplied exact schemas.',
        ].join(' '),
        input: input.prompt,
        tools: [],
        outputType: AUTHORING_OUTPUT_TYPE,
        modelSettings: {
          temperature: 0,
          maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          toolChoice: 'none',
        },
        signal: input.signal,
        stream: true,
        ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
      });
      const admitted = admitModelStep(step);
      if (!admitted.admitted) {
        throw new Error(`authoring model response blocked: ${admitted.reason}`);
      }
      if (admitted.kind !== 'completed' || admitted.frame.kind !== 'completed') {
        throw new Error('authoring model returned an actionable frame despite an empty tool surface');
      }
      return canonicalCandidate(admitted.frame.text);
    },
  };
}

function failureDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 8_192) || 'Automatic pilot authoring failed.';
}

async function boundedAuthor(input: {
  port: AutomationPilotAuthoringPortV1;
  request: AutomationPilotAuthoringRequestV1;
  requestDigest: string;
  outputShape: AutomationPilotOutputShapeReceiptV1;
  prompt: string;
  timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('automatic pilot authoring deadline exceeded'));
      reject(new Error('automatic pilot authoring deadline exceeded'));
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([
      input.port.author({
        request: structuredClone(input.request),
        requestDigest: input.requestDigest,
        outputShape: structuredClone(input.outputShape),
        prompt: input.prompt,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function reconcileAutomationPilotAuthoringDispatch(input: {
  advancementId: string;
  port?: AutomationPilotAuthoringPortV1;
  workerId?: string;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  nowMs?: number;
}): Promise<ReconcileAutomationPilotAuthoringDispatchResult> {
  const workerId = input.workerId ?? 'host.automation-pilot-authoring';
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const nowMs = input.nowMs ?? Date.now();
  if (
    !ID_RE.test(input.advancementId)
    || !ID_RE.test(workerId)
    || !Number.isSafeInteger(leaseMs)
    || leaseMs < 5_000
    || leaseMs > 30 * 60_000
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs + 5_000 > leaseMs
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 10
    || !Number.isSafeInteger(nowMs)
    || nowMs < 1
  ) {
    return { ok: false, code: 'authoring_dispatch_invalid', reason: 'The authoring dispatch bounds are invalid.', advancementId: input.advancementId };
  }
  const current = loadAutomationPilotAdvancement(input.advancementId);
  if (!current) {
    return { ok: false, code: 'advancement_missing', reason: 'The exact advancement was not found.', advancementId: input.advancementId };
  }
  if (current.stage !== 'authoring_required' || !current.authoringRequest || !current.authoringRequestDigest) {
    return { ok: true, state: 'not_required', advancementId: current.advancementId };
  }
  const activeClaim = current.authoringClaim
    && Date.parse(current.authoringClaim.expiresAt) > nowMs;
  if (!activeClaim && (current.authoringAttemptCount ?? 0) >= maxAttempts) {
    const detail = `Automatic pilot authoring exhausted ${current.authoringAttemptCount} bounded attempt${current.authoringAttemptCount === 1 ? '' : 's'} before a valid result was durably submitted.`;
    const blocked = blockAutomationPilotAuthoringRequest({
      advancementId: current.advancementId,
      expectedStateRevision: current.stateRevision,
      expectedStateDigest: current.stateDigest,
      code: 'authoring_attempt_budget_exhausted',
      detail,
    });
    if (!blocked.ok) {
      return { ok: false, code: blocked.code, reason: blocked.reason, advancementId: current.advancementId };
    }
    return { ok: true, state: 'blocked', advancementId: current.advancementId, detail };
  }
  const attested = attestAutomationPilotOutputShape({
    request: current.authoringRequest,
    requestDigest: current.authoringRequestDigest,
  });
  if (!attested.ok) {
    const blocked = blockAutomationPilotAuthoringRequest({
      advancementId: current.advancementId,
      expectedStateRevision: current.stateRevision,
      expectedStateDigest: current.stateDigest,
      code: attested.code,
      detail: attested.reason,
    });
    if (!blocked.ok) {
      return { ok: false, code: blocked.code, reason: blocked.reason, advancementId: current.advancementId };
    }
    return { ok: true, state: 'blocked', advancementId: current.advancementId, detail: attested.reason };
  }
  const claimed = claimAutomationPilotAuthoringRequest({
    advancementId: current.advancementId,
    expectedStateRevision: current.stateRevision,
    expectedStateDigest: current.stateDigest,
    workerId,
    leaseMs,
    nowMs,
  });
  if (!claimed.ok) {
    if (claimed.code === 'authoring_already_claimed' || claimed.code === 'authoring_claim_invalid') {
      return { ok: true, state: 'busy', advancementId: current.advancementId, detail: claimed.reason };
    }
    return { ok: false, code: claimed.code, reason: claimed.reason, advancementId: current.advancementId };
  }
  const failAttempt = (code: string, detail: string): ReconcileAutomationPilotAuthoringDispatchResult => {
    const failed = recordAutomationPilotAuthoringAttemptFailure({
      advancementId: claimed.projection.advancementId,
      expectedStateRevision: claimed.projection.stateRevision,
      expectedStateDigest: claimed.projection.stateDigest,
      claimId: claimed.claim.claimId,
      code,
      detail,
      maxAttempts,
      nowMs: Math.max(nowMs, Date.now()),
    });
    if (!failed.ok) {
      return { ok: false, code: failed.code, reason: failed.reason, advancementId: current.advancementId };
    }
    return {
      ok: true,
      state: failed.projection.stage === 'blocked' ? 'blocked' : 'retry',
      advancementId: current.advancementId,
      detail,
    };
  };
  let candidate: AutomationPilotAuthoringResultV1;
  try {
    const raw = await boundedAuthor({
      port: input.port ?? createProductionAutomationPilotAuthoringPort(),
      request: claimed.request,
      requestDigest: claimed.requestDigest,
      outputShape: attested.receipt,
      prompt: automationPilotAuthoringPrompt({
        request: claimed.request,
        requestDigest: claimed.requestDigest,
        receipt: attested.receipt,
      }),
      timeoutMs,
    });
    candidate = canonicalCandidate(raw);
  } catch (error) {
    return failAttempt('authoring_transport_or_json_failure', failureDetail(error));
  }
  const shape = validateAutomationPilotAuthoringOutputShape({
    receipt: attested.receipt,
    result: candidate,
  });
  if (!shape.ok) return failAttempt(shape.code, shape.reason);
  const submitted = submitAutomationPilotAuthoringResult({
    advancementId: claimed.projection.advancementId,
    expectedStateRevision: claimed.projection.stateRevision,
    expectedStateDigest: claimed.projection.stateDigest,
    claimId: claimed.claim.claimId,
    result: candidate,
    nowMs: Math.max(nowMs, Date.now()),
  });
  if (!submitted.ok) {
    if (submitted.code === 'authoring_result_invalid') {
      return failAttempt(submitted.code, submitted.reason);
    }
    return { ok: false, code: submitted.code, reason: submitted.reason, advancementId: current.advancementId };
  }
  return { ok: true, state: 'submitted', advancementId: current.advancementId };
}

export async function reconcileAutomationPilotAuthoringDispatches(input: {
  limit?: number;
  port?: AutomationPilotAuthoringPortV1;
  workerId?: string;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
} = {}): Promise<ReconcileAutomationPilotAuthoringDispatchesResult> {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('authoring dispatch limit must be from 1 through 100');
  }
  const result: ReconcileAutomationPilotAuthoringDispatchesResult = {
    scanned: 0,
    busy: 0,
    retry: 0,
    submitted: 0,
    blocked: 0,
    failed: 0,
  };
  for (const row of listAutomationPilotAdvancements({ stage: 'authoring_required', limit })) {
    result.scanned += 1;
    try {
      const dispatched = await reconcileAutomationPilotAuthoringDispatch({
        advancementId: row.advancementId,
        ...(input.port ? { port: input.port } : {}),
        ...(input.workerId ? { workerId: input.workerId } : {}),
        ...(input.leaseMs ? { leaseMs: input.leaseMs } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
      });
      if (!dispatched.ok) result.failed += 1;
      else if (dispatched.state === 'busy') result.busy += 1;
      else if (dispatched.state === 'retry') result.retry += 1;
      else if (dispatched.state === 'submitted') result.submitted += 1;
      else if (dispatched.state === 'blocked') result.blocked += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export const automationPilotAuthoringDispatcherDefaults = Object.freeze({
  leaseMs: DEFAULT_LEASE_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
});
