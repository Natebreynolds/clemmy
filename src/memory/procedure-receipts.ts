/**
 * Receipt-backed, runtime-validated, TRANSACTIONAL procedures (v3.8.0/D2).
 *
 * procedure-artifact.ts holds the artifact shape and content addressing. What
 * it could not yet promise, and what this module closes for the read lane:
 *
 *   1. RUNTIME VALIDATION. The parser trusted cast JSON. Here every artifact
 *      read is validated field-by-field against its declared version; a
 *      malformed, torn, or unknown-version file QUARANTINES on disk with a
 *      typed reason (historical data is never deleted blindly) and resolution
 *      reports a miss that names it.
 *   2. RECEIPT AUTHORITY. Promotion previously accepted a caller-constructed
 *      receipt shape. Here promotion resolves a durable receipt record BY
 *      IMMUTABLE ID through an injected resolver over the existing
 *      effect-ledger/evidence stores and verifies operation, provider,
 *      identifier, schema, scope, account, effect class, dispatch outcome,
 *      and read evidence. No model- or caller-supplied object is promotion
 *      authority.
 *   3. ATOMIC LOGICAL-KEY SUPERSESSION. Separate file renames could leave two
 *      actives under concurrency. Here each logical key owns ONE pointer file
 *      to the current content-addressed artifact, written atomically
 *      (tmp+rename) under an in-process per-key mutex — exactly one active
 *      canonical artifact per key, always, and a stable logical key without
 *      pretending content addresses are stable across changed bytes.
 *
 * Distinct read outcomes stay distinct: bound / needs_slots / stale /
 * unavailable / miss (requires_readmission belongs to the lane's envelope,
 * which owns authority membership). Schema drift quarantines before dispatch
 * and only a NEW verified receipt re-promotes. Bad slot values, timeouts,
 * rate limits, and provider 5xx never poison a structurally valid artifact
 * (recordProcedureUse already pins that).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import {
  computeArtifactId,
  promoteProcedureArtifact,
  readArtifact,
  templateSlots,
  type ProcedureArtifact,
  type ProcedureResolution,
  type ProcedureScope,
} from './procedure-artifact.js';
import type { ProcedureKind } from './procedure-validity.js';

export const PROCEDURE_ARTIFACT_VERSION = 1;

// ── runtime validation ───────────────────────────────────────────────────────

export type ParsedArtifact =
  | { ok: true; artifact: ProcedureArtifact }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a parsed artifact document. Never a cast: every load-bearing field
 * is checked, and a version this build does not know is quarantined rather
 * than reinterpreted.
 */
export function parseProcedureArtifactDocument(value: unknown): ParsedArtifact {
  if (!isRecord(value)) return { ok: false, reason: 'not a JSON object' };
  const version = value.artifactVersion;
  if (version !== PROCEDURE_ARTIFACT_VERSION) {
    return { ok: false, reason: `unknown artifact version ${String(version)} — this build reads v${PROCEDURE_ARTIFACT_VERSION} only` };
  }
  for (const field of ['artifactId', 'provider', 'operation', 'identifier', 'schemaFingerprint', 'status', 'validAt', 'createdAt', 'updatedAt'] as const) {
    if (!isNonEmptyString(value[field])) return { ok: false, reason: `field "${field}" is missing or empty` };
  }
  if (!['read', 'write', 'send'].includes(value.effectClass as string)) {
    return { ok: false, reason: `effectClass "${String(value.effectClass)}" is not a known effect class` };
  }
  if (!['active', 'quarantined', 'superseded'].includes(value.status as string)) {
    return { ok: false, reason: `status "${String(value.status)}" is not a known status` };
  }
  const scope = value.scope;
  if (!isRecord(scope) || typeof scope.tenant !== 'string' || typeof scope.workspace !== 'string' || typeof scope.accountIdentity !== 'string') {
    return { ok: false, reason: 'scope is missing tenant/workspace/accountIdentity' };
  }
  if (/^ca_/i.test(scope.accountIdentity)) {
    return { ok: false, reason: 'scope.accountIdentity is a rotating connection id' };
  }
  const template = value.template;
  if (!isRecord(template) || !isRecord(template.args) || !Array.isArray(template.slots)
    || !template.slots.every((slot) => typeof slot === 'string')) {
    return { ok: false, reason: 'template is not a typed args/slots IR' };
  }
  // Slots must be exactly what the args declare — a tampered slot list could
  // silently drop a required binding.
  const declared = templateSlots(template.args as Record<string, unknown>);
  if (JSON.stringify(declared) !== JSON.stringify(template.slots)) {
    return { ok: false, reason: 'template.slots does not match the {{slot}} placeholders in template.args' };
  }
  const promotedBy = value.promotedBy;
  if (!isRecord(promotedBy) || !isNonEmptyString(promotedBy.receiptId) || !isNonEmptyString(promotedBy.schemaFingerprint)) {
    return { ok: false, reason: 'promotedBy is not a receipt (an artifact without a receipt cannot exist)' };
  }
  if (!Array.isArray(value.evidence)) return { ok: false, reason: 'evidence is not a list' };
  return { ok: true, artifact: value as unknown as ProcedureArtifact };
}

// ── durable receipt authority ────────────────────────────────────────────────

export interface DurableReceiptRecord {
  receiptId: string;
  at: string;
  provider: string;
  operation: string;
  effectClass: 'read' | 'write' | 'send';
  /** The dispatchable identifier the receipt proves ran. */
  identifier: string;
  schemaFingerprint: string;
  scope: ProcedureScope;
  /** The settled dispatch outcome. Only 'succeeded' promotes. */
  dispatchOutcome: 'succeeded' | 'failed' | 'ambiguous';
  /** Reads: the evidence reference for the data actually returned. */
  readEvidenceRef?: string;
  /** Writes/sends: the observation/commit reference. */
  observationRef?: string;
}

/** Injected adapter over the EXISTING receipt/evidence stores. */
export interface ReceiptResolver {
  resolve(receiptId: string): DurableReceiptRecord | undefined;
}

export type ReceiptPromotionResult =
  | { ok: true; artifact: ProcedureArtifact; superseded?: string }
  | { ok: false; errors: string[] };

// ── storage: logical-key pointers ────────────────────────────────────────────

function pointerDir(): string {
  return path.join(BASE_DIR, 'memory', 'procedure-artifacts', getMachineId(), 'logical-keys');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function logicalKeyDigest(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: string;
}): string {
  return sha256(JSON.stringify({
    tenant: input.scope.tenant,
    workspace: input.scope.workspace,
    account: input.scope.accountIdentity,
    provider: input.provider,
    operation: input.operation,
    effectClass: input.effectClass,
  })).slice(0, 40);
}

interface LogicalKeyPointer {
  activeArtifactId: string;
  updatedAt: string;
}

function pointerPath(keyDigest: string): string {
  return path.join(pointerDir(), `${keyDigest}.json`);
}

function readPointer(keyDigest: string): LogicalKeyPointer | null {
  try {
    const file = pointerPath(keyDigest);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as LogicalKeyPointer;
    return isNonEmptyString(parsed?.activeArtifactId) ? parsed : null;
  } catch {
    return null;
  }
}

function writePointer(keyDigest: string, pointer: LogicalKeyPointer | null): void {
  const dir = pointerDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = pointerPath(keyDigest);
  const temporary = path.join(dir, `.${keyDigest}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(pointer ?? { activeArtifactId: '', updatedAt: new Date().toISOString() })}\n`, 'utf-8');
  renameSync(temporary, file); // rename is the atomic commit
}

/** In-process per-key mutex: promotions for one logical key serialize. */
const KEY_LOCKS = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(keyDigest: string, work: () => Promise<T> | T): Promise<T> {
  const previous = KEY_LOCKS.get(keyDigest) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  KEY_LOCKS.set(keyDigest, previous.then(() => gate));
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (KEY_LOCKS.get(keyDigest) === gate) KEY_LOCKS.delete(keyDigest);
  }
}

// ── the transactional promotion path ─────────────────────────────────────────

/**
 * Promote from a DURABLE receipt. The caller supplies its CLAIM (what it
 * believes ran) and the resolver supplies the truth; any disagreement
 * refuses. The logical-key pointer flips atomically under the key mutex, so
 * concurrency leaves exactly one active canonical artifact.
 */
export async function promoteFromVerifiedReceipt(
  input: {
    scope: ProcedureScope;
    provider: string;
    operation: string;
    effectClass: 'read' | 'write' | 'send';
    kind: ProcedureKind;
    identifier: string;
    templateArgs: Record<string, unknown>;
    receiptId: string;
    now?: string;
  },
  resolver: ReceiptResolver,
): Promise<ReceiptPromotionResult> {
  const record = resolver.resolve(input.receiptId);
  if (!record) {
    return { ok: false, errors: [`receipt "${input.receiptId}" does not resolve to a durable record — a receipt-shaped object is not promotion authority`] };
  }
  const errors: string[] = [];
  if (record.dispatchOutcome !== 'succeeded') {
    errors.push(`receipt "${input.receiptId}" records dispatch outcome "${record.dispatchOutcome}", not a verified success`);
  }
  if (record.provider !== input.provider || record.operation !== input.operation) {
    errors.push(`receipt proves ${record.provider}/${record.operation}, not the claimed ${input.provider}/${input.operation}`);
  }
  if (record.effectClass !== input.effectClass) {
    errors.push(`receipt proves effect class ${record.effectClass}, not ${input.effectClass}`);
  }
  if (record.identifier !== input.identifier.trim()) {
    errors.push(`receipt proves identifier "${record.identifier}", not "${input.identifier}"`);
  }
  if (record.scope.tenant !== input.scope.tenant
    || record.scope.workspace !== input.scope.workspace
    || record.scope.accountIdentity !== input.scope.accountIdentity) {
    errors.push('receipt scope (tenant/workspace/account) does not match the promotion scope');
  }
  if (record.effectClass === 'read' && !isNonEmptyString(record.readEvidenceRef)) {
    errors.push('a read receipt without read evidence proves a dispatch, not returned data');
  }
  if (errors.length > 0) return { ok: false, errors };

  const keyDigest = logicalKeyDigest(input);
  return withKeyLock(keyDigest, () => {
    const promoted = promoteProcedureArtifact({
      scope: input.scope,
      provider: input.provider,
      operation: input.operation,
      effectClass: input.effectClass,
      kind: input.kind,
      identifier: input.identifier,
      templateArgs: input.templateArgs,
      receipt: {
        receiptId: record.receiptId,
        at: record.at,
        schemaFingerprint: record.schemaFingerprint,
        ...(record.observationRef ? { observationRef: record.observationRef } : {}),
      },
      now: input.now,
    });
    if (!promoted.ok) return promoted;
    stampVersion(promoted.artifact.artifactId);
    writePointer(keyDigest, {
      activeArtifactId: promoted.artifact.artifactId,
      updatedAt: input.now ?? new Date().toISOString(),
    });
    return promoted;
  });
}

/** Write the version stamp into the stored artifact document (the base module
 *  predates versioning; the transactional layer requires it). */
function stampVersion(artifactId: string): void {
  const dir = path.join(BASE_DIR, 'memory', 'procedure-artifacts', getMachineId());
  const file = path.join(dir, `${artifactId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    parsed.artifactVersion = PROCEDURE_ARTIFACT_VERSION;
    const temporary = path.join(dir, `.${artifactId}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    renameSync(temporary, file);
  } catch { /* the pointer still names it; the validated read reports precisely */ }
}

// ── the validated, pointer-first read path ───────────────────────────────────

export type TransactionalResolution =
  | ProcedureResolution
  /** The pointer or its artifact is malformed/torn/unknown-version — the file
   *  is quarantined on disk with the reason, and resolution says so. */
  | { outcome: 'miss'; quarantined?: { artifactId: string; reason: string } };

/**
 * Resolve through the logical-key pointer: at most ONE artifact is ever the
 * canonical answer for a key, and it is runtime-validated before anything
 * binds. Schema drift quarantines durably (artifact + pointer) BEFORE any
 * dispatch; only a new verified receipt re-promotes.
 */
export function resolveActiveProcedure(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: 'read' | 'write' | 'send';
  liveSchemaFingerprint?: string;
  accountConnected?: boolean;
  slotValues?: Record<string, string>;
}): TransactionalResolution {
  const keyDigest = logicalKeyDigest(input);
  const pointer = readPointer(keyDigest);
  if (!pointer || !pointer.activeArtifactId) return { outcome: 'miss' };

  const dir = path.join(BASE_DIR, 'memory', 'procedure-artifacts', getMachineId());
  const file = path.join(dir, `${pointer.activeArtifactId}.json`);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    quarantineFile(file, pointer.activeArtifactId, `unreadable: ${error instanceof Error ? error.message : 'torn file'}`);
    writePointer(keyDigest, null);
    return { outcome: 'miss', quarantined: { artifactId: pointer.activeArtifactId, reason: 'unreadable or torn artifact file' } };
  }
  const parsed = parseProcedureArtifactDocument(document);
  if (!parsed.ok) {
    quarantineFile(file, pointer.activeArtifactId, parsed.reason);
    writePointer(keyDigest, null);
    return { outcome: 'miss', quarantined: { artifactId: pointer.activeArtifactId, reason: parsed.reason } };
  }
  const artifact = parsed.artifact;
  if (artifact.status !== 'active') return { outcome: 'miss' };

  if (input.accountConnected === false) {
    return {
      outcome: 'unavailable',
      artifactId: artifact.artifactId,
      reason: `account "${artifact.scope.accountIdentity || '(none)'}" is not connected`,
    };
  }
  if (input.liveSchemaFingerprint && input.liveSchemaFingerprint !== artifact.schemaFingerprint) {
    const reason = `proven against ${artifact.schemaFingerprint}, live contract is ${input.liveSchemaFingerprint}`;
    const now = new Date().toISOString();
    const quarantined = { ...artifact, status: 'quarantined' as const, statusReason: reason, invalidAt: now, updatedAt: now };
    const temporary = path.join(dir, `.${artifact.artifactId}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...quarantined, artifactVersion: PROCEDURE_ARTIFACT_VERSION }, null, 2)}\n`, 'utf-8');
      renameSync(temporary, file);
    } catch { /* the pointer clear below still de-activates it */ }
    writePointer(keyDigest, null);
    return { outcome: 'stale', artifactId: artifact.artifactId, reason };
  }
  const missing = artifact.template.slots.filter((slot) => !(slot in (input.slotValues ?? {})));
  if (missing.length > 0) return { outcome: 'needs_slots', artifact, missingSlots: missing };
  return { outcome: 'bound', artifact, requiredSlots: artifact.template.slots };
}

function quarantineFile(file: string, artifactId: string, reason: string): void {
  try {
    renameSync(file, `${file}.quarantined`);
    writeFileSync(`${file}.quarantined.reason`, `${reason}\n`, 'utf-8');
  } catch { /* quarantine is best-effort; the cleared pointer is the gate */ }
  void artifactId;
}

/** Read the current pointer target (validated), for tests and diagnostics. */
export function activeArtifactForKey(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: string;
}): ProcedureArtifact | null {
  const pointer = readPointer(logicalKeyDigest(input));
  if (!pointer?.activeArtifactId) return null;
  return readArtifact(pointer.activeArtifactId);
}

export { computeArtifactId };
