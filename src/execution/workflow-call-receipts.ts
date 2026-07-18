import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';

/**
 * Correctness-critical receipt store for structured workflow mutations.
 *
 * This deliberately does NOT use workflow-events.jsonl: that log is
 * best-effort and may silently fail. Each phase is an immutable JSON file
 * written to a same-directory temporary file, fsynced, atomically renamed,
 * then followed by a directory fsync on platforms that support it. A mutation
 * is never dispatched unless both its exact intent and its `started` boundary
 * are durable.
 *
 * State machine:
 *
 *   intent -> started -> receipt -> commit
 *
 * - intent only: dispatch never reached its boundary, so retry is safe.
 * - started only: the provider may have committed before the process vanished;
 *   refuse to dispatch again.
 * - receipt without commit: the provider returned successfully and its result
 *   is durable; finish the local commit and replay without re-dispatching.
 * - commit: replay the durable result without re-dispatching.
 */

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowCallMutationInput {
  workflowSlug: string;
  runId: string;
  stepId: string;
  itemKey?: string;
  tool: string;
  account?: {
    connectionId?: string;
    identity?: string;
  };
  /** Args after gateway normalization and account resolution. */
  args: Record<string, unknown>;
}

export interface WorkflowCallMutationSlotInput {
  workflowSlug: string;
  runId: string;
  stepId: string;
  itemKey?: string;
}

interface MutationSlot {
  workflowSlug: string;
  runId: string;
  stepId: string;
  itemKey: string | null;
}

interface NormalizedMutationCall {
  tool: string;
  account: {
    connectionId: string | null;
    identity: string | null;
  };
  args: JsonValue;
}

interface MutationRecordBase {
  version: 1;
  recordedAt: string;
  fingerprint: string;
  slot: MutationSlot;
}

interface SlotClaimRecord {
  version: 1;
  recordedAt: string;
  fingerprint: string;
  slot: MutationSlot;
}

interface IntentRecord extends MutationRecordBase {
  phase: 'intent';
  call: NormalizedMutationCall;
}

interface StartedRecord extends MutationRecordBase {
  phase: 'started';
}

interface EncodedResult {
  kind: 'json' | 'undefined';
  value?: JsonValue;
}

interface ReceiptRecord extends MutationRecordBase {
  phase: 'receipt';
  result: EncodedResult;
}

interface FailedRecord extends MutationRecordBase {
  phase: 'failed';
  summary: string;
  result: EncodedResult;
}

interface CommitRecord extends MutationRecordBase {
  phase: 'commit';
  receiptSha256: string;
}

type MutationRecord = IntentRecord | StartedRecord | ReceiptRecord | FailedRecord | CommitRecord;

export type WorkflowCallMutationStatus = 'none' | 'intent' | 'ambiguous' | 'failed' | 'received' | 'committed';

export interface WorkflowCallMutationState {
  fingerprint: string;
  status: WorkflowCallMutationStatus;
  result?: unknown;
  failureSummary?: string;
}

export class WorkflowCallMutationAmbiguousError extends Error {
  readonly code = 'WORKFLOW_CALL_MUTATION_AMBIGUOUS';
  readonly fingerprint: string;

  constructor(input: WorkflowCallMutationInput, fingerprint: string, detail?: string) {
    const account = normalizedAccount(input.account);
    const owner = account.connectionId ?? account.identity ?? 'provider-default-account';
    super(
      `Structured workflow mutation "${input.tool}" for step "${input.stepId}" was already `
      + `started against ${owner}, but no durable success receipt was recorded. The call was `
      + `NOT dispatched again because the prior attempt may already have committed externally. `
      + (detail ? `Last observed failure: ${detail}. ` : '')
      + `Review the destination, then start a new run only after confirming a retry is safe `
      + `(mutation ${fingerprint.slice(0, 12)}).`,
    );
    this.name = 'WorkflowCallMutationAmbiguousError';
    this.fingerprint = fingerprint;
  }
}

export class WorkflowCallMutationConflictError extends Error {
  readonly code = 'WORKFLOW_CALL_MUTATION_CONFLICT';

  constructor(input: WorkflowCallMutationInput, existingFingerprint: string, requestedFingerprint: string) {
    super(
      `Structured workflow mutation slot "${input.stepId}${input.itemKey ? `:${input.itemKey}` : ''}" `
      + `already crossed the dispatch boundary with a different tool/account/argument fingerprint. `
      + `The changed call was NOT dispatched. Start a new workflow run after reviewing the prior `
      + `mutation (${existingFingerprint.slice(0, 12)} -> ${requestedFingerprint.slice(0, 12)}).`,
    );
    this.name = 'WorkflowCallMutationConflictError';
  }
}

export class WorkflowCallMutationProvenFailureError extends Error {
  readonly code = 'WORKFLOW_CALL_MUTATION_PROVEN_FAILURE';
  readonly fingerprint: string;

  constructor(input: WorkflowCallMutationInput, fingerprint: string, summary: string) {
    super(
      `Structured workflow mutation "${input.tool}" failed before a success receipt was recorded: ${summary} `
      + `(mutation ${fingerprint.slice(0, 12)}). The provider failure was durably recorded and was not reported as success.`,
    );
    this.name = 'WorkflowCallMutationProvenFailureError';
    this.fingerprint = fingerprint;
  }
}

export interface WorkflowCallMutationOptions<T> {
  /** Return a concise failure summary for an authoritative provider failure
   * envelope. Such a result is persisted as `failed`, never as success. */
  classifyFailure?: (result: T) => {
    summary: string;
    provenNoCommit: boolean;
  } | null | undefined;
  /** Narrow pre-provider/pre-dispatch throw classifier. Any unclassified throw
   * after `started` is ambiguous and is surfaced as such on the first attempt. */
  classifyThrownFailure?: (error: unknown) => string | null | undefined;
}

export class WorkflowCallMutationLedgerError extends Error {
  readonly code = 'WORKFLOW_CALL_MUTATION_LEDGER_ERROR';

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkflowCallMutationLedgerError';
  }
}

function normalizeJson(value: unknown, label: string): JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error(`${label} is not JSON-serializable`);
    }
    return JSON.parse(encoded) as JsonValue;
  } catch (err) {
    throw new WorkflowCallMutationLedgerError(
      `Cannot durably record structured workflow mutation ${label}.`,
      err,
    );
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
  return sorted;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function normalizedAccount(account: WorkflowCallMutationInput['account']): NormalizedMutationCall['account'] {
  const connectionId = account?.connectionId?.trim() || null;
  const identity = account?.identity?.trim().toLowerCase() || null;
  return { connectionId, identity };
}

function normalizedInput(input: WorkflowCallMutationInput): { slot: MutationSlot; call: NormalizedMutationCall } {
  const slot = normalizedSlotInput(input);
  const tool = input.tool.trim();
  if (!tool) {
    throw new WorkflowCallMutationLedgerError(
      'Cannot durably record a structured workflow mutation with a blank workflow, run, step, or tool; dispatch refused.',
    );
  }
  return {
    slot,
    call: {
      tool,
      account: normalizedAccount(input.account),
      args: normalizeJson(input.args, 'arguments'),
    },
  };
}

function normalizedSlotInput(input: WorkflowCallMutationSlotInput): MutationSlot {
  const workflowSlug = input.workflowSlug.trim();
  const runId = input.runId.trim();
  const stepId = input.stepId.trim();
  if (!workflowSlug || !runId || !stepId) {
    throw new WorkflowCallMutationLedgerError(
      'Cannot inspect a structured workflow mutation with a blank workflow, run, or step.',
    );
  }
  return { workflowSlug, runId, stepId, itemKey: input.itemKey?.trim() || null };
}

/** Stable SHA-256 over run/step/item/tool/resolved account/normalized args. */
export function workflowCallMutationFingerprint(input: WorkflowCallMutationInput): string {
  const normalized = normalizedInput(input);
  return normalizedMutationFingerprint(normalized);
}

function normalizedMutationFingerprint(normalized: { slot: MutationSlot; call: NormalizedMutationCall }): string {
  return createHash('sha256')
    .update(stableJson(normalizeJson(normalized, 'fingerprint input')))
    .digest('hex');
}

function runMutationDir(input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>): string {
  return path.join(WORKFLOWS_DIR, input.workflowSlug, 'runs', input.runId, 'call-mutations');
}

function operationDir(input: WorkflowCallMutationInput, fingerprint: string): string {
  return path.join(runMutationDir(input), fingerprint);
}

function slotClaimRoot(input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>): string {
  return path.join(runMutationDir(input), '.slot-claims');
}

function slotClaimDir(input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>, slot: MutationSlot): string {
  const slotHash = createHash('sha256')
    .update(stableJson(normalizeJson(slot, 'mutation slot')))
    .digest('hex');
  return path.join(slotClaimRoot(input), slotHash);
}

function phasePath(dir: string, phase: MutationRecord['phase']): string {
  return path.join(dir, `${phase}.json`);
}

function startedClaimPath(dir: string): string {
  return path.join(dir, '.started-claim');
}

function syncDirectory(dir: string): void {
  // Windows rejects opening/fsyncing a directory. The phase file itself is
  // still fsynced and installed with a same-directory atomic rename there.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectoryDurably(dir: string): void {
  const missing: string[] = [];
  let cursor = dir;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (missing.length > 0) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Fsync the whole workflow-relative chain even when directories already
  // existed: another best-effort writer may have just created `runs/<runId>`
  // without persisting its parent entry.
  let syncCursor = dir;
  // Include parent(BASE_DIR): syncing BASE_DIR itself persists its contents,
  // while syncing the parent persists BASE_DIR's own entry on a fresh install.
  const stop = path.dirname(BASE_DIR);
  while (true) {
    syncDirectory(syncCursor);
    if (syncCursor === stop) break;
    const parent = path.dirname(syncCursor);
    if (parent === syncCursor) break;
    syncCursor = parent;
  }
}

function ensureOperationDir(input: WorkflowCallMutationInput, fingerprint: string): string {
  const dir = operationDir(input, fingerprint);
  try {
    ensureDirectoryDurably(dir);
    return dir;
  } catch (err) {
    throw new WorkflowCallMutationLedgerError(
      `Could not create and fsync the structured workflow mutation ledger; dispatch refused (${input.stepId}).`,
      err,
    );
  }
}

function readSlotClaim(file: string): SlotClaimRecord {
  try {
    const value = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SlotClaimRecord>;
    if (
      value.version !== 1
      || typeof value.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(value.recordedAt))
      || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
      || !validMutationSlot(value.slot)
    ) {
      throw new Error('invalid slot claim shape');
    }
    return value as SlotClaimRecord;
  } catch (err) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation slot claim is corrupt at ${file}; dispatch refused.`,
      err,
    );
  }
}

function existingSlotClaim(
  input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>,
  slot: MutationSlot,
): SlotClaimRecord | null {
  const dir = slotClaimDir(input, slot);
  if (!existsSync(dir)) return null;
  const file = path.join(dir, 'claim.json');
  if (!existsSync(file)) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation slot claim is incomplete at ${dir}; dispatch refused.`,
    );
  }
  const claim = readSlotClaim(file);
  if (!slotsEqual(claim.slot, slot)) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation slot claim does not match its directory at ${dir}; dispatch refused.`,
    );
  }
  return claim;
}

/** Atomically bind one run/step/item slot to one exact call fingerprint.
 * `mkdir` is the cross-process compare-and-set: competing fingerprints cannot
 * both own the same slot even when they race before either intent is visible. */
function claimSlotFingerprintDurably(
  input: WorkflowCallMutationInput,
  fingerprint: string,
  slot: MutationSlot,
): void {
  const existing = existingSlotClaim(input, slot);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new WorkflowCallMutationConflictError(input, existing.fingerprint, fingerprint);
    }
    return;
  }

  const root = slotClaimRoot(input);
  const dir = slotClaimDir(input, slot);
  try {
    ensureDirectoryDurably(root);
    mkdirSync(dir, { mode: 0o700 });
    syncDirectory(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const winner = existingSlotClaim(input, slot);
      if (!winner) {
        throw new WorkflowCallMutationLedgerError(
          `Structured workflow mutation slot claim disappeared during acquisition; dispatch refused.`,
          err,
        );
      }
      if (winner.fingerprint !== fingerprint) {
        throw new WorkflowCallMutationConflictError(input, winner.fingerprint, fingerprint);
      }
      return;
    }
    throw new WorkflowCallMutationLedgerError(
      `Could not durably claim the structured workflow mutation slot; dispatch refused (${input.stepId}).`,
      err,
    );
  }

  const claimFile = path.join(dir, 'claim.json');
  let fd: number | undefined;
  try {
    fd = openSync(claimFile, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({
      version: 1,
      recordedAt: new Date().toISOString(),
      fingerprint,
      slot,
    } satisfies SlotClaimRecord)}\n`, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    syncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
    // Keep an incomplete claim directory as a fail-closed sentinel. Removing
    // it could let a competing process dispatch while ownership is uncertain.
    throw new WorkflowCallMutationLedgerError(
      `Could not durably persist the structured workflow mutation slot claim; dispatch refused (${input.stepId}).`,
      err,
    );
  }
}

function writePhaseDurably(dir: string, record: MutationRecord): void {
  const target = phasePath(dir, record.phase);
  const payload = `${JSON.stringify(record)}\n`;
  if (existsSync(target)) {
    const prior = readRecord(target, record.phase);
    if (prior.fingerprint !== record.fingerprint) {
      throw new WorkflowCallMutationLedgerError(`Mutation ledger phase ${record.phase} has a conflicting fingerprint.`);
    }
    return;
  }

  const temp = path.join(dir, `.${record.phase}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, payload, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    syncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw new WorkflowCallMutationLedgerError(
      `Could not durably persist mutation phase "${record.phase}"; external dispatch ${record.phase === 'intent' || record.phase === 'started' ? 'refused' : 'is now uncertain'}.`,
      err,
    );
  }
}

/** Cross-process dispatch ownership. The directory creation is atomic; once it
 * exists, every other executor must treat the call as potentially dispatched.
 * A crash before `started.json` is written remains conservative and visible as
 * ambiguous instead of reopening the provider boundary. */
function claimStartedBoundaryDurably(dir: string, record: StartedRecord): boolean {
  try {
    mkdirSync(startedClaimPath(dir), { mode: 0o700 });
    syncDirectory(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw new WorkflowCallMutationLedgerError(
      `Could not durably claim the structured workflow mutation dispatch boundary; dispatch refused.`,
      err,
    );
  }
  writePhaseDurably(dir, record);
  return true;
}

function readRecord(file: string, expectedPhase: MutationRecord['phase']): MutationRecord {
  try {
    const value = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MutationRecord>;
    if (
      value.version !== 1
      || value.phase !== expectedPhase
      || typeof value.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(value.recordedAt))
      || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
      || !validMutationSlot(value.slot)
    ) {
      throw new Error('invalid record shape');
    }
    if (expectedPhase === 'intent') {
      const call = (value as Partial<IntentRecord>).call;
      if (
        !call
        || typeof call.tool !== 'string'
        || !call.tool.trim()
        || !call.account
        || (call.account.connectionId !== null && typeof call.account.connectionId !== 'string')
        || (call.account.identity !== null && typeof call.account.identity !== 'string')
        || !isJsonObject(call.args)
      ) {
        throw new Error('invalid intent call');
      }
    }
    if (expectedPhase === 'receipt') {
      const result = (value as Partial<ReceiptRecord>).result;
      if (!validEncodedResult(result)) throw new Error('invalid receipt result');
    }
    if (expectedPhase === 'failed') {
      const failed = value as Partial<FailedRecord>;
      if (
        typeof failed.summary !== 'string'
        || !failed.summary.trim()
        || !validEncodedResult(failed.result)
      ) {
        throw new Error('invalid failed result');
      }
    }
    if (expectedPhase === 'commit' && !/^[a-f0-9]{64}$/.test((value as Partial<CommitRecord>).receiptSha256 ?? '')) {
      throw new Error('invalid commit receipt hash');
    }
    return value as MutationRecord;
  } catch (err) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation ledger is corrupt at ${file}; dispatch refused.`,
      err,
    );
  }
}

function validMutationSlot(value: unknown): value is MutationSlot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const slot = value as Partial<MutationSlot>;
  return typeof slot.workflowSlug === 'string'
    && slot.workflowSlug.trim().length > 0
    && typeof slot.runId === 'string'
    && slot.runId.trim().length > 0
    && typeof slot.stepId === 'string'
    && slot.stepId.trim().length > 0
    && (slot.itemKey === null || (typeof slot.itemKey === 'string' && slot.itemKey.trim().length > 0));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

function validEncodedResult(value: unknown): value is EncodedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<EncodedResult>;
  if (result.kind === 'undefined') return result.value === undefined;
  return result.kind === 'json' && 'value' in result && isJsonValue(result.value);
}

function assertRecordMatchesIntent(record: MutationRecord, intent: IntentRecord, file: string): void {
  if (record.fingerprint !== intent.fingerprint || !slotsEqual(record.slot, intent.slot)) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation ledger phase at ${file} does not match its durable intent; dispatch refused.`,
    );
  }
}

function verifyCommittedReceipt(commit: CommitRecord, receipt: ReceiptRecord): void {
  const actual = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  if (actual !== commit.receiptSha256) {
    throw new WorkflowCallMutationLedgerError('Mutation success receipt does not match its durable commit; dispatch refused.');
  }
}

function slotsEqual(a: MutationSlot, b: MutationSlot): boolean {
  return a.workflowSlug === b.workflowSlug
    && a.runId === b.runId
    && a.stepId === b.stepId
    && a.itemKey === b.itemKey;
}

function assertNoCrossFingerprintConflict(input: WorkflowCallMutationInput, fingerprint: string, slot: MutationSlot): void {
  const root = runMutationDir(input);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === fingerprint || entry.name === '.slot-claims') continue;
    if (!/^[a-f0-9]{64}$/.test(entry.name)) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation ledger contains an invalid operation directory (${entry.name}); dispatch refused.`,
      );
    }
    const dir = path.join(root, entry.name);
    const intentFile = phasePath(dir, 'intent');
    if (!existsSync(intentFile)) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation ledger contains an incomplete operation directory (${entry.name}); dispatch refused.`,
      );
    }
    const intent = readRecord(intentFile, 'intent') as IntentRecord;
    if (
      intent.fingerprint !== entry.name
      || intent.slot.workflowSlug !== input.workflowSlug.trim()
      || intent.slot.runId !== input.runId.trim()
      || normalizedMutationFingerprint({ slot: intent.slot, call: intent.call }) !== intent.fingerprint
    ) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation intent at ${intentFile} does not match its path or fingerprint; dispatch refused.`,
      );
    }
    const claim = existingSlotClaim(input, intent.slot);
    if (!claim || claim.fingerprint !== intent.fingerprint) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation intent at ${intentFile} has no matching slot claim; dispatch refused.`,
      );
    }
    if (!slotsEqual(intent.slot, slot)) continue;
    const crossedBoundary = existsSync(phasePath(dir, 'started'))
      || existsSync(startedClaimPath(dir))
      || existsSync(phasePath(dir, 'failed'))
      || existsSync(phasePath(dir, 'receipt'))
      || existsSync(phasePath(dir, 'commit'));
    if (crossedBoundary) {
      throw new WorkflowCallMutationConflictError(input, intent.fingerprint, fingerprint);
    }
  }
}

function recordBase(fingerprint: string, slot: MutationSlot): MutationRecordBase {
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    fingerprint,
    slot,
  };
}

function encodeResult(result: unknown): EncodedResult {
  if (result === undefined) return { kind: 'undefined' };
  return { kind: 'json', value: normalizeJson(result, 'success receipt') };
}

function decodeResult(result: EncodedResult): unknown {
  return result.kind === 'undefined' ? undefined : result.value;
}

function inspectExactState(input: WorkflowCallMutationInput, fingerprint: string): WorkflowCallMutationState {
  const normalized = normalizedInput(input);
  const dir = operationDir(input, fingerprint);
  if (!existsSync(dir)) return { fingerprint, status: 'none' };
  const intentFile = phasePath(dir, 'intent');
  if (!existsSync(intentFile)) {
    throw new WorkflowCallMutationLedgerError('Mutation operation directory exists without a durable intent; dispatch refused.');
  }
  const intent = readRecord(intentFile, 'intent') as IntentRecord;
  if (intent.fingerprint !== fingerprint) {
    throw new WorkflowCallMutationLedgerError('Mutation intent fingerprint does not match its operation directory; dispatch refused.');
  }
  if (!slotsEqual(intent.slot, normalized.slot)) {
    throw new WorkflowCallMutationLedgerError('Mutation intent slot does not match the requested workflow run/step/item; dispatch refused.');
  }
  if (normalizedMutationFingerprint({ slot: intent.slot, call: intent.call }) !== fingerprint) {
    throw new WorkflowCallMutationLedgerError('Mutation intent contents do not match its fingerprint; dispatch refused.');
  }
  const claim = existingSlotClaim(input, normalized.slot);
  if (!claim || claim.fingerprint !== fingerprint) {
    throw new WorkflowCallMutationLedgerError('Mutation intent does not match a durable slot claim; dispatch refused.');
  }

  const startedFile = phasePath(dir, 'started');
  const started = existsSync(startedFile) || existsSync(startedClaimPath(dir));
  const failedFile = phasePath(dir, 'failed');
  const receiptFile = phasePath(dir, 'receipt');
  const commitFile = phasePath(dir, 'commit');
  const hasFailed = existsSync(failedFile);
  const hasReceipt = existsSync(receiptFile);
  const hasCommit = existsSync(commitFile);

  if (existsSync(startedFile)) {
    const startedRecord = readRecord(startedFile, 'started');
    assertRecordMatchesIntent(startedRecord, intent, startedFile);
  }

  if (hasCommit && !hasReceipt) {
    throw new WorkflowCallMutationLedgerError('Mutation commit exists without its success receipt; dispatch refused.');
  }
  if (hasReceipt && !started) {
    throw new WorkflowCallMutationLedgerError('Mutation receipt exists without a started dispatch boundary; dispatch refused.');
  }
  if (hasFailed && (!started || hasReceipt || hasCommit)) {
    throw new WorkflowCallMutationLedgerError('Mutation failed proof conflicts with its dispatch/success phases; dispatch refused.');
  }
  if (hasCommit) {
    const commit = readRecord(commitFile, 'commit') as CommitRecord;
    const receipt = readRecord(receiptFile, 'receipt') as ReceiptRecord;
    assertRecordMatchesIntent(receipt, intent, receiptFile);
    assertRecordMatchesIntent(commit, intent, commitFile);
    verifyCommittedReceipt(commit, receipt);
    return { fingerprint, status: 'committed', result: decodeResult(receipt.result) };
  }
  if (hasReceipt) {
    const receipt = readRecord(receiptFile, 'receipt') as ReceiptRecord;
    assertRecordMatchesIntent(receipt, intent, receiptFile);
    return { fingerprint, status: 'received', result: decodeResult(receipt.result) };
  }
  if (hasFailed) {
    const failed = readRecord(failedFile, 'failed') as FailedRecord;
    assertRecordMatchesIntent(failed, intent, failedFile);
    return {
      fingerprint,
      status: 'failed',
      result: decodeResult(failed.result),
      failureSummary: failed.summary,
    };
  }
  if (started) {
    return { fingerprint, status: 'ambiguous' };
  }
  return { fingerprint, status: 'intent' };
}

/** Read-only inspection used by recovery logic and focused safety tests. */
export function inspectWorkflowCallMutation(input: WorkflowCallMutationInput): WorkflowCallMutationState {
  const normalized = normalizedInput(input);
  const fingerprint = workflowCallMutationFingerprint(input);
  assertNoCrossFingerprintConflict(input, fingerprint, normalized.slot);
  const claim = existingSlotClaim(input, normalized.slot);
  if (claim && claim.fingerprint !== fingerprint) {
    throw new WorkflowCallMutationConflictError(input, claim.fingerprint, fingerprint);
  }
  return inspectExactState(input, fingerprint);
}

function runIntentRecords(input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>): IntentRecord[] {
  const workflowSlug = input.workflowSlug.trim();
  const runId = input.runId.trim();
  if (!workflowSlug || !runId) {
    throw new WorkflowCallMutationLedgerError('Cannot inspect structured workflow mutations with a blank workflow or run.');
  }
  const root = runMutationDir(input);
  if (!existsSync(root)) return [];
  const matches: IntentRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.slot-claims') continue;
    if (!/^[a-f0-9]{64}$/.test(entry.name)) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation ledger contains an invalid operation directory (${entry.name}); dispatch refused.`,
      );
    }
    const intentFile = phasePath(path.join(root, entry.name), 'intent');
    if (!existsSync(intentFile)) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation ledger contains an operation without intent (${entry.name}); dispatch refused.`,
      );
    }
    const intent = readRecord(intentFile, 'intent') as IntentRecord;
    if (
      intent.fingerprint !== entry.name
      || intent.slot.workflowSlug !== workflowSlug
      || intent.slot.runId !== runId
      || normalizedMutationFingerprint({ slot: intent.slot, call: intent.call }) !== intent.fingerprint
    ) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation intent at ${intentFile} does not match its path or fingerprint; dispatch refused.`,
      );
    }
    const claim = existingSlotClaim(input, intent.slot);
    if (!claim || claim.fingerprint !== intent.fingerprint) {
      throw new WorkflowCallMutationLedgerError(
        `Structured workflow mutation intent at ${intentFile} has no matching slot claim; dispatch refused.`,
      );
    }
    matches.push(intent);
  }
  return matches;
}

function slotIntentRecords(input: WorkflowCallMutationSlotInput): IntentRecord[] {
  const slot = normalizedSlotInput(input);
  return runIntentRecords(input).filter((intent) => slotsEqual(intent.slot, slot));
}

export interface WorkflowRunMutationRequeueAssessment {
  safeToFreshRun: boolean;
  blocking: Array<{
    stepId: string;
    itemKey?: string;
    status: Extract<WorkflowCallMutationStatus, 'ambiguous' | 'received' | 'committed'>;
    fingerprint: string;
  }>;
}

/** A fresh run id cannot replay a source run's exact-call receipt. Only
 * pre-dispatch intents and proven-no-commit failures are safe to retry fresh;
 * ambiguous or successful mutations require operator verification/targeted
 * continuation instead of a whole-graph rerun. */
export function assessWorkflowRunMutationRequeue(
  input: Pick<WorkflowCallMutationSlotInput, 'workflowSlug' | 'runId'>,
): WorkflowRunMutationRequeueAssessment {
  const blocking: WorkflowRunMutationRequeueAssessment['blocking'] = [];
  for (const intent of runIntentRecords(input)) {
    const exactInput: WorkflowCallMutationInput = {
      workflowSlug: intent.slot.workflowSlug,
      runId: intent.slot.runId,
      stepId: intent.slot.stepId,
      ...(intent.slot.itemKey ? { itemKey: intent.slot.itemKey } : {}),
      tool: intent.call.tool,
      account: {
        ...(intent.call.account.connectionId ? { connectionId: intent.call.account.connectionId } : {}),
        ...(intent.call.account.identity ? { identity: intent.call.account.identity } : {}),
      },
      args: intent.call.args as Record<string, unknown>,
    };
    const state = inspectExactState(exactInput, intent.fingerprint);
    if (state.status === 'ambiguous' || state.status === 'received' || state.status === 'committed') {
      blocking.push({
        stepId: intent.slot.stepId,
        ...(intent.slot.itemKey ? { itemKey: intent.slot.itemKey } : {}),
        status: state.status,
        fingerprint: intent.fingerprint,
      });
    }
  }
  return { safeToFreshRun: blocking.length === 0, blocking };
}

/** Whether this exact run/step/item already opted into the durable receipt
 * protocol. Upgrade recovery uses this to keep legacy in-flight mutations on
 * the old conservative halt path instead of assuming a new empty ledger is
 * proof that the prior build never dispatched. */
export function workflowCallMutationSlotHasLedger(input: WorkflowCallMutationSlotInput): boolean {
  const slot = normalizedSlotInput(input);
  if (existsSync(slotClaimDir(input, slot))) {
    // A bare/incomplete/corrupt slot directory is a fail-closed sentinel, not
    // proof that this exact slot safely opted into the protocol. Validate the
    // durable claim before recovery is allowed to rely on it.
    return existingSlotClaim(input, slot) !== null;
  }
  return slotIntentRecords(input).length > 0;
}

/** Replay terminal exact-call truth before mutable gateway preflight. Account
 * disconnects, schema drift, or constraint changes after a committed mutation
 * must not turn a durable success into a recovery failure. */
export function replayWorkflowCallMutationSlot(
  input: WorkflowCallMutationSlotInput,
): { replayed: false } | { replayed: true; result: unknown } {
  const intents = slotIntentRecords(input);
  if (intents.length === 0) return { replayed: false };
  if (intents.length > 1) {
    throw new WorkflowCallMutationLedgerError(
      `Structured workflow mutation slot "${input.stepId}" has multiple durable intents; dispatch refused.`,
    );
  }
  const intent = intents[0];
  const exactInput: WorkflowCallMutationInput = {
    workflowSlug: intent.slot.workflowSlug,
    runId: intent.slot.runId,
    stepId: intent.slot.stepId,
    ...(intent.slot.itemKey ? { itemKey: intent.slot.itemKey } : {}),
    tool: intent.call.tool,
    account: {
      ...(intent.call.account.connectionId ? { connectionId: intent.call.account.connectionId } : {}),
      ...(intent.call.account.identity ? { identity: intent.call.account.identity } : {}),
    },
    args: intent.call.args as Record<string, unknown>,
  };
  const state = inspectExactState(exactInput, intent.fingerprint);
  if (state.status === 'committed') return { replayed: true, result: state.result };
  if (state.status === 'received') {
    const receipt = readRecord(
      phasePath(operationDir(exactInput, intent.fingerprint), 'receipt'),
      'receipt',
    ) as ReceiptRecord;
    persistCommit(exactInput, intent.fingerprint, intent.slot, receipt);
    return { replayed: true, result: state.result };
  }
  if (state.status === 'failed') {
    // Proven no-commit: there is no committed result to replay, and a retry is
    // safe. Report "nothing replayed" so the normal dispatch path (which owns
    // the archive-and-retry rotation) proceeds instead of stranding the slot.
    return { replayed: false };
  }
  if (state.status === 'ambiguous') {
    throw new WorkflowCallMutationAmbiguousError(exactInput, intent.fingerprint);
  }
  return { replayed: false };
}

/**
 * A `failed` phase is written ONLY for a proven-no-commit failure (a transient
 * client error such as HTTP 429 that the classifier proved never committed).
 * The provider demonstrably did not mutate, so the slot is safe to re-dispatch
 * — treating it as terminal permanently stranded retryable rate-limits within a
 * run (crash-resume, parked-run resume, in-run item retry all reuse the slot;
 * 2026-07-17 final-wave review #5/#10). Archive the failed attempt's boundary
 * and proof immutably for audit, release the started-claim, and reset the
 * operation directory to its durable `intent` so a fresh attempt can re-cross
 * the boundary. Renaming failed.json is the cross-process CAS: exactly one
 * retrier rotates; a loser sees ENOENT and re-inspects. Ambiguous failures are
 * never persisted as `failed`, so they can never reach this path.
 */
function rotateProvenNoCommitFailure(dir: string): boolean {
  const failedFile = phasePath(dir, 'failed');
  if (!existsSync(failedFile)) return false;
  const archiveDir = path.join(dir, 'archived-attempts');
  ensureDirectoryDurably(archiveDir);
  const seq = readdirSync(archiveDir).filter((name) => name.startsWith('failed-')).length;
  try {
    renameSync(failedFile, path.join(archiveDir, `failed-${seq}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false; // a peer rotated first
    throw new WorkflowCallMutationLedgerError(
      'Could not archive a proven-no-commit failure for retry; dispatch refused.',
      err,
    );
  }
  // The started boundary and its claim belong to the archived attempt. Move the
  // started proof alongside the failure and release the claim directory so a new
  // attempt can re-cross the boundary. intent.json stays — same fingerprint.
  const startedFile = phasePath(dir, 'started');
  if (existsSync(startedFile)) {
    try { renameSync(startedFile, path.join(archiveDir, `started-${seq}.json`)); } catch { /* audit copy is best-effort */ }
  }
  try { rmdirSync(startedClaimPath(dir)); } catch { /* already released or never present */ }
  syncDirectory(dir);
  return true;
}

function persistCommit(
  input: WorkflowCallMutationInput,
  fingerprint: string,
  slot: MutationSlot,
  receipt: ReceiptRecord,
): void {
  const dir = ensureOperationDir(input, fingerprint);
  const receiptSha256 = createHash('sha256')
    .update(JSON.stringify(receipt))
    .digest('hex');
  writePhaseDurably(dir, {
    ...recordBase(fingerprint, slot),
    phase: 'commit',
    receiptSha256,
  });
}

/**
 * Execute one externally-mutating structured call exactly once per run slot.
 * The supplied thunk MUST begin at the provider dispatch boundary: resolution,
 * validation, and account selection happen before it; the external call happens
 * inside it.
 */
export async function executeWorkflowCallMutation<T>(
  input: WorkflowCallMutationInput,
  dispatch: () => Promise<T>,
  options: WorkflowCallMutationOptions<T> = {},
): Promise<T> {
  const normalized = normalizedInput(input);
  const fingerprint = workflowCallMutationFingerprint(input);
  // Scan legacy ledgers before claiming so an old, already-started fingerprint
  // wins instead of a changed recovery call accidentally seizing the new lock.
  assertNoCrossFingerprintConflict(input, fingerprint, normalized.slot);
  claimSlotFingerprintDurably(input, fingerprint, normalized.slot);
  let state = inspectExactState(input, fingerprint);

  if (state.status === 'committed') return state.result as T;
  if (state.status === 'received') {
    const receipt = readRecord(phasePath(operationDir(input, fingerprint), 'receipt'), 'receipt') as ReceiptRecord;
    persistCommit(input, fingerprint, normalized.slot, receipt);
    return state.result as T;
  }
  if (state.status === 'ambiguous') {
    throw new WorkflowCallMutationAmbiguousError(input, fingerprint);
  }
  if (state.status === 'failed') {
    // Proven no-commit: safe to retry. Archive the failed attempt and re-inspect
    // — the slot resets to `intent` and falls through to a fresh dispatch below.
    rotateProvenNoCommitFailure(operationDir(input, fingerprint));
    state = inspectExactState(input, fingerprint);
  }

  const dir = ensureOperationDir(input, fingerprint);
  if (state.status === 'none') {
    writePhaseDurably(dir, {
      ...recordBase(fingerprint, normalized.slot),
      phase: 'intent',
      call: normalized.call,
    });
    state = { fingerprint, status: 'intent' };
  }

  // This is the last local instruction before the supplied thunk crosses into
  // the provider. If the process dies after this fsync, recovery is
  // intentionally conservative and refuses a second dispatch.
  const startedRecord: StartedRecord = {
    ...recordBase(fingerprint, normalized.slot),
    phase: 'started',
  };
  if (!claimStartedBoundaryDurably(dir, startedRecord)) {
    // A competing process owns the provider boundary. It may already have
    // committed; replay only if that proof is visible, otherwise fail closed.
    state = inspectExactState(input, fingerprint);
    if (state.status === 'committed') return state.result as T;
    if (state.status === 'received') {
      const receipt = readRecord(phasePath(dir, 'receipt'), 'receipt') as ReceiptRecord;
      persistCommit(input, fingerprint, normalized.slot, receipt);
      return state.result as T;
    }
    if (state.status === 'failed') {
      throw new WorkflowCallMutationProvenFailureError(
        input,
        fingerprint,
        state.failureSummary ?? 'provider reported failure',
      );
    }
    throw new WorkflowCallMutationAmbiguousError(input, fingerprint);
  }

  let result: T;
  try {
    result = await dispatch();
  } catch (err) {
    const provenSummary = options.classifyThrownFailure?.(err)?.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (provenSummary) {
      writePhaseDurably(dir, {
        ...recordBase(fingerprint, normalized.slot),
        phase: 'failed',
        summary: provenSummary,
        result: encodeResult({ error: provenSummary }),
      });
      throw new WorkflowCallMutationProvenFailureError(input, fingerprint, provenSummary);
    }
    const detail = err instanceof Error ? err.message.replace(/\s+/g, ' ').trim().slice(0, 500) : String(err).slice(0, 500);
    throw new WorkflowCallMutationAmbiguousError(input, fingerprint, detail);
  }
  try {
    const failure = options.classifyFailure?.(result);
    const failureSummary = failure?.summary.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (failureSummary && failure?.provenNoCommit) {
      writePhaseDurably(dir, {
        ...recordBase(fingerprint, normalized.slot),
        phase: 'failed',
        summary: failureSummary,
        result: encodeResult(result),
      });
      throw new WorkflowCallMutationProvenFailureError(input, fingerprint, failureSummary);
    }
    if (failureSummary) {
      throw new WorkflowCallMutationAmbiguousError(input, fingerprint, failureSummary);
    }
    const receipt: ReceiptRecord = {
      ...recordBase(fingerprint, normalized.slot),
      phase: 'receipt',
      result: encodeResult(result),
    };
    writePhaseDurably(dir, receipt);
    persistCommit(input, fingerprint, normalized.slot, receipt);
    return result;
  } catch (err) {
    if (
      err instanceof WorkflowCallMutationProvenFailureError
      || err instanceof WorkflowCallMutationAmbiguousError
    ) {
      throw err;
    }
    const detail = err instanceof Error
      ? err.message.replace(/\s+/g, ' ').trim().slice(0, 500)
      : String(err).slice(0, 500);
    throw new WorkflowCallMutationAmbiguousError(
      input,
      fingerprint,
      `Provider returned after dispatch, but its durable receipt could not be completed${detail ? `: ${detail}` : ''}`,
    );
  }
}
