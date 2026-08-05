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
import { createHash } from 'node:crypto';
import {
  clearPointer,
  loadArtifactRow,
  loadPointer,
  promoteTransactionally,
  updateArtifactRow,
} from './procedure-store.js';
import {
  computeArtifactId,
  templateSlots,
  type ProcedureArtifact,
  type ProcedureResolution,
  type ProcedureScope,
} from './procedure-artifact.js';
import { isPlaceholderToken, type ProcedureKind } from './procedure-validity.js';
import { composioSlugIsDispatchable, stripVolatileConnectionArgs } from '../tools/composio-carrier.js';

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

// ── the transactional promotion path ─────────────────────────────────────────

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

function isNonEmptyStringLocal(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Promote from a DURABLE receipt. The caller supplies its CLAIM (what it
 * believes ran) and the resolver supplies the truth; any disagreement
 * refuses — including a schema the acquisition never proved (F23). The
 * artifact insert, supersession, and pointer swap are ONE SQLite/WAL
 * transaction (F28): cross-process concurrency and crashes leave exactly
 * one active canonical artifact.
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
    /** The schema the ACQUISITION proved. When present, the receipt must
     *  prove the same contract — never promote under undischarged drift. */
    acquiredSchemaFingerprint?: string;
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
  if (record.effectClass === 'read' && !isNonEmptyStringLocal(record.readEvidenceRef)) {
    errors.push('a read receipt without read evidence proves a dispatch, not returned data');
  }
  if (input.acquiredSchemaFingerprint !== undefined
    && record.schemaFingerprint !== input.acquiredSchemaFingerprint) {
    errors.push(`receipt proves schema ${record.schemaFingerprint}, but the acquisition bound ${input.acquiredSchemaFingerprint} — a promotion under undischarged drift is refused`);
  }
  const identifier = input.identifier.trim();
  if (isPlaceholderToken(identifier)) errors.push(`identifier "${identifier}" is filler, not a tool`);
  else if (input.kind === 'composio' && !composioSlugIsDispatchable(identifier)) {
    errors.push(`identifier "${identifier}" cannot name a provider action`);
  }
  if (/^ca_/i.test(input.scope.accountIdentity)) {
    errors.push('scope.accountIdentity is a rotating connection id; use the stable account identity');
  }
  if (errors.length > 0) return { ok: false, errors };

  const { args } = stripVolatileConnectionArgs(input.templateArgs);
  const template = { args, slots: templateSlots(args) };
  const now = input.now ?? new Date().toISOString();
  const artifactId = computeArtifactId({
    scope: input.scope, provider: input.provider, operation: input.operation,
    effectClass: input.effectClass, kind: input.kind, identifier, template,
  });
  const artifact: ProcedureArtifact & { artifactVersion: number } = {
    artifactVersion: PROCEDURE_ARTIFACT_VERSION,
    artifactId,
    scope: { ...input.scope },
    provider: input.provider,
    operation: input.operation,
    effectClass: input.effectClass,
    kind: input.kind,
    identifier,
    template,
    schemaFingerprint: record.schemaFingerprint,
    promotedBy: {
      receiptId: record.receiptId,
      at: record.at,
      schemaFingerprint: record.schemaFingerprint,
      ...(record.observationRef ? { observationRef: record.observationRef } : {}),
    },
    status: 'active',
    validAt: now,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };
  const { superseded } = promoteTransactionally({
    keyDigest: logicalKeyDigest(input), artifact, now,
  });
  return superseded ? { ok: true, artifact, superseded } : { ok: true, artifact };
}

// ── the validated, pointer-first read path ───────────────────────────────────

export type TransactionalResolution =
  | ProcedureResolution
  /** The pointer's artifact is malformed/torn/tampered/unknown-version — it
   *  is quarantined in the store with the reason, and resolution says so. */
  | { outcome: 'miss'; quarantined?: { artifactId: string; reason: string } };

function quarantineRow(artifact: ProcedureArtifact, keyDigest: string, reason: string): void {
  const now = new Date().toISOString();
  updateArtifactRow({
    ...artifact,
    status: 'quarantined',
    statusReason: reason,
    invalidAt: now,
    updatedAt: now,
    artifactVersion: PROCEDURE_ARTIFACT_VERSION,
  } as ProcedureArtifact & { artifactVersion: number });
  clearPointer(keyDigest);
}

/**
 * Resolve through the logical-key pointer: at most ONE artifact is ever the
 * canonical answer for a key, runtime-validated AND content-verified before
 * anything binds. Content identity is recomputed on every load (F27): a
 * tampered document whose logical fields changed cannot resolve as bound,
 * because both the recomputed content address and the requested logical key
 * are compared against what the document actually says. Schema drift
 * quarantines durably BEFORE dispatch; only a new verified receipt
 * re-promotes.
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
  const activeId = loadPointer(keyDigest);
  if (!activeId) return { outcome: 'miss' };

  const document = loadArtifactRow(activeId);
  if (document === undefined) {
    clearPointer(keyDigest);
    return { outcome: 'miss', quarantined: { artifactId: activeId, reason: 'pointer names a missing artifact row' } };
  }
  const parsed = parseProcedureArtifactDocument(document);
  if (!parsed.ok) {
    clearPointer(keyDigest);
    return { outcome: 'miss', quarantined: { artifactId: activeId, reason: parsed.reason } };
  }
  const artifact = parsed.artifact;

  // F27: recompute the content address from the DOCUMENT's own fields and
  // compare it to the id the pointer named, then compare the document's
  // logical key to the REQUESTED one. Tampering either way de-activates.
  const recomputed = computeArtifactId({
    scope: artifact.scope,
    provider: artifact.provider,
    operation: artifact.operation,
    effectClass: artifact.effectClass,
    kind: artifact.kind,
    identifier: artifact.identifier,
    template: artifact.template,
  });
  if (recomputed !== artifact.artifactId || artifact.artifactId !== activeId) {
    quarantineRow(artifact, keyDigest, 'content identity mismatch — the stored document does not hash to its own id');
    return { outcome: 'miss', quarantined: { artifactId: activeId, reason: 'content identity mismatch' } };
  }
  if (artifact.provider !== input.provider
    || artifact.operation !== input.operation
    || artifact.effectClass !== input.effectClass
    || artifact.scope.tenant !== input.scope.tenant
    || artifact.scope.workspace !== input.scope.workspace
    || artifact.scope.accountIdentity !== input.scope.accountIdentity) {
    quarantineRow(artifact, keyDigest, 'logical-key mismatch — the pointer names an artifact for a different operation or scope');
    return { outcome: 'miss', quarantined: { artifactId: activeId, reason: 'logical-key mismatch' } };
  }
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
    quarantineRow(artifact, keyDigest, reason);
    return { outcome: 'stale', artifactId: artifact.artifactId, reason };
  }
  const missing = artifact.template.slots.filter((slot) => !(slot in (input.slotValues ?? {})));
  if (missing.length > 0) return { outcome: 'needs_slots', artifact, missingSlots: missing };
  return { outcome: 'bound', artifact, requiredSlots: artifact.template.slots };
}

/** Record a successful warm use by exact artifact id (credit, not prose). */
export function recordWarmProcedureUse(artifactId: string): void {
  const document = loadArtifactRow(artifactId);
  if (document === undefined) return;
  const parsed = parseProcedureArtifactDocument(document);
  if (!parsed.ok) return;
  const now = new Date().toISOString();
  updateArtifactRow({
    ...parsed.artifact,
    evidence: [...parsed.artifact.evidence, {
      useId: `use_${now}_${parsed.artifact.evidence.length}`, at: now, kind: 'success' as const,
    }].slice(-200),
    updatedAt: now,
    artifactVersion: PROCEDURE_ARTIFACT_VERSION,
  } as ProcedureArtifact & { artifactVersion: number });
}

/** Read the current pointer target (validated), for tests and diagnostics. */
export function activeArtifactForKey(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: string;
}): ProcedureArtifact | null {
  const activeId = loadPointer(logicalKeyDigest(input));
  if (!activeId) return null;
  const parsed = parseProcedureArtifactDocument(loadArtifactRow(activeId));
  return parsed.ok ? parsed.artifact : null;
}

export { computeArtifactId };
