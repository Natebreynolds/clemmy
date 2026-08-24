/**
 * Host bindings from certified workflow memory.
 *
 * Tool-choice pins and prior successful step outputs already exist. They were
 * injected as prompt flavor ("try this first"), so a model still rediscovered
 * a URL twelve clean runs had already certified. This module is the last
 * mile: the host binds a stable identity output, or dispatches a proven
 * read pin, instead of asking a brain to re-earn it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { peekToolChoice } from './tool-choice-store.js';
import type { WorkflowStepOutputContract } from './workflow-store.js';

/** Same 3-run invariant the contract-evidence store uses before tightening. */
export const CERTIFIED_STEP_OUTPUT_MIN_RUNS = 3;

const SETTLED_PIN_RESULT_CHARS = 24_000;

export function workflowStepPinIntent(workflowName: string, stepId: string): string {
  return `workflow:${workflowName}:${stepId}`;
}

export function identityKeysFromContract(contract: WorkflowStepOutputContract | undefined): string[] {
  const keys = contract?.verify?.url_present;
  if (!Array.isArray(keys)) return [];
  return keys.map((key) => key.trim()).filter((key) => key.length > 0);
}

export function coerceStepOutputRecord(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return coerceStepOutputRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.blocked === true) return null;
  if (rec.__clementine_context_ref === true) return null;
  return rec;
}

export function normalizeCertifiedIdentityValue(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimmed;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function certifiedIdentityFromOutput(
  output: Record<string, unknown>,
  identityKeys: string[],
): Record<string, string> | null {
  if (identityKeys.length === 0) return null;
  const identity: Record<string, string> = {};
  for (const key of identityKeys) {
    const value = output[key];
    if (typeof value !== 'string' || !value.trim()) return null;
    identity[key] = normalizeCertifiedIdentityValue(value);
  }
  return identity;
}

export interface CertifiedStepOutputBinding {
  output: Record<string, unknown>;
  identity: Record<string, string>;
  sourceCount: number;
}

export interface CertifiedStepOutputRequest {
  sideEffectClass: 'read' | 'write' | 'send';
  outputContract?: WorkflowStepOutputContract;
  forEach?: string;
  deterministic?: boolean;
  hasCallNode?: boolean;
  priorSuccessfulOutputs: unknown[];
}

/**
 * Bind the newest certified output when a read step's identity URLs have
 * been identical across N successful runs and the contract does not demand
 * a fresh collection (`non_empty` / `min_items`).
 */
export function resolveCertifiedStepOutput(
  request: CertifiedStepOutputRequest,
): CertifiedStepOutputBinding | null {
  if (request.sideEffectClass !== 'read') return null;
  if (request.deterministic) return null;
  if (request.hasCallNode) return null;
  if (typeof request.forEach === 'string' && request.forEach.trim()) return null;
  const nonEmpty = request.outputContract?.non_empty;
  if (Array.isArray(nonEmpty) && nonEmpty.some((key) => String(key).trim())) return null;
  const minItems = request.outputContract?.min_items;
  if (minItems && Object.keys(minItems).length > 0) return null;
  const identityKeys = identityKeysFromContract(request.outputContract);
  if (identityKeys.length === 0) return null;

  const parsed: Array<{ output: Record<string, unknown>; identity: Record<string, string> }> = [];
  for (const raw of request.priorSuccessfulOutputs) {
    const output = coerceStepOutputRecord(raw);
    if (!output) continue;
    const identity = certifiedIdentityFromOutput(output, identityKeys);
    if (!identity) continue;
    parsed.push({ output, identity });
  }
  if (parsed.length < CERTIFIED_STEP_OUTPUT_MIN_RUNS) return null;
  const window = parsed.slice(0, CERTIFIED_STEP_OUTPUT_MIN_RUNS);
  const [newest, ...rest] = window;
  if (!newest) return null;
  const signature = JSON.stringify(newest.identity);
  if (rest.some((entry) => JSON.stringify(entry.identity) !== signature)) return null;
  return {
    output: newest.output,
    identity: newest.identity,
    sourceCount: window.length,
  };
}

export interface WorkflowStepPinDispatch {
  slug: string;
  args: Record<string, unknown>;
  successCount: number;
}

export function pinDispatchFromChoice(
  choice: { kind?: string; identifier?: string; invocationTemplate?: string; successCount?: number; failureCount?: number } | null | undefined,
  sideEffectClass: 'read' | 'write' | 'send' = 'read',
): WorkflowStepPinDispatch | null {
  if (sideEffectClass !== 'read') return null;
  if (!choice || choice.kind !== 'composio' || !choice.identifier) return null;
  if ((choice.failureCount ?? 0) > (choice.successCount ?? 0)) return null;
  if (isIrreversibleSendSlug(choice.identifier)) return null;
  const template = choice.invocationTemplate?.trim();
  if (!template) return null;
  let args: unknown;
  try {
    args = JSON.parse(template);
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return {
    slug: choice.identifier,
    args: args as Record<string, unknown>,
    successCount: choice.successCount ?? 0,
  };
}

/** Proven composio pin for a read step — host-dispatchable, not prompt flavor. */
export function resolveWorkflowStepPinDispatch(
  workflowName: string,
  stepId: string,
  sideEffectClass: 'read' | 'write' | 'send' = 'read',
): WorkflowStepPinDispatch | null {
  return pinDispatchFromChoice(peekToolChoice(workflowStepPinIntent(workflowName, stepId))?.choice, sideEffectClass);
}

export function formatSettledStepPinBlock(input: {
  slug: string;
  args: Record<string, unknown>;
  result: unknown;
}): string {
  let rendered: string;
  try {
    rendered = typeof input.result === 'string' ? input.result : JSON.stringify(input.result, null, 2);
  } catch {
    rendered = String(input.result);
  }
  if (rendered.length > SETTLED_PIN_RESULT_CHARS) {
    rendered = `${rendered.slice(0, SETTLED_PIN_RESULT_CHARS)}\n…[truncated]`;
  }
  return [
    '=== HOST SETTLED READ (authoritative) ===',
    `The runtime already executed the proven call for this step (${input.slug}).`,
    `args: ${JSON.stringify(input.args)}`,
    'result:',
    rendered,
    '=== END HOST SETTLED READ ===',
  ].join('\n');
}

function runRecordSucceeded(record: Record<string, unknown>): boolean {
  if (record.terminalOutcome === 'succeeded') return true;
  return record.status === 'completed' && record.goalOutcome === 'satisfied';
}

function runMatchesWorkflow(record: Record<string, unknown>, workflowSlug: string, workflowName?: string): boolean {
  const slug = typeof record.workflowSlug === 'string' ? record.workflowSlug : '';
  const name = typeof record.workflow === 'string' ? record.workflow : '';
  return slug === workflowSlug || name === workflowSlug || (!!workflowName && (slug === workflowName || name === workflowName));
}

/** Newest-first successful outputs for one step, skipping the in-flight run. */
export function loadPriorSuccessfulStepOutputs(input: {
  workflowSlug: string;
  workflowName?: string;
  stepId: string;
  currentRunId: string;
  scanLimit?: number;
}): unknown[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const scanLimit = input.scanLimit ?? 40;
  const files = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json') && !entry.startsWith('trigger-receipt'));
  const records: Array<{ finishedAt: string; record: Record<string, unknown> }> = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    if (id === input.currentRunId) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!runMatchesWorkflow(record, input.workflowSlug, input.workflowName)) continue;
    if (!runRecordSucceeded(record)) continue;
    const finishedAt = typeof record.finishedAt === 'string'
      ? record.finishedAt
      : typeof record.startedAt === 'string'
        ? record.startedAt
        : '';
    records.push({ finishedAt, record });
  }
  records.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const outputs: unknown[] = [];
  for (const { record } of records.slice(0, scanLimit)) {
    const stepOutputs = record.stepOutputs;
    if (!stepOutputs || typeof stepOutputs !== 'object' || Array.isArray(stepOutputs)) continue;
    const raw = (stepOutputs as Record<string, unknown>)[input.stepId];
    if (raw === undefined) continue;
    outputs.push(raw);
    if (outputs.length >= CERTIFIED_STEP_OUTPUT_MIN_RUNS) break;
  }
  return outputs;
}
