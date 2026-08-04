/**
 * The receipt-backed procedure artifact (Clem 4 Stage 2).
 *
 * G3a made stored procedures VALIDATED — one validator on write and recall
 * refuses filler identifiers and undispatchable slugs. This module closes the
 * deeper half the charter names: the write path itself. A tool-choice memo is
 * still promoted by the model ASSERTING success. An artifact here is promoted
 * only from a VERIFIED DISPATCH RECEIPT: the canonical invocation that
 * actually ran, the schema fingerprint it ran against, and the receipt id that
 * proves it. Absence of failure language is not evidence; a receipt is.
 *
 * Three properties carry the contract:
 *
 *   1. CONTENT-ADDRESSED. The artifact id is the sha256 of its scope, logical
 *      key, carrier identity, and template IR. Two paraphrases of one proven
 *      operation converge on one artifact; a changed carrier is a different
 *      artifact that SUPERSEDES, never a conflicting duplicate.
 *   2. SCOPED. Ownership is tenant + workspace + logical account. Resolution
 *      inside one scope can never return another scope's artifact, whatever
 *      the provider and operation names have in common.
 *   3. HONESTLY TYPED AT READ. Resolution returns bound / needs_slots /
 *      stale / unavailable / miss — never prose. A `bound` result is an
 *      executable IR that bypasses discovery; `stale` names the exact drift;
 *      `miss` sends the caller to generic discovery with nothing half-true.
 *
 * What this module deliberately does NOT do (Stage 4 owns activation): no
 * production recall path calls this yet, and no advisory prose is deleted
 * until the shared capability resolver consumes the structural binding.
 *
 * Only reproducible structural defects mark an artifact stale. Bad slot
 * values, rate limits, timeouts, and transient 5xx attach outcome evidence
 * without poisoning an otherwise valid procedure.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import {
  composioSlugIsDispatchable,
  stripVolatileConnectionArgs,
} from '../tools/composio-carrier.js';
import { isPlaceholderToken, type ProcedureKind } from './procedure-validity.js';

// ── shapes ───────────────────────────────────────────────────────────────────

export interface ProcedureScope {
  /** Tenant/user identity. Single-tenant installs use 'local'. */
  tenant: string;
  /** Workspace identity, '' when the procedure is workspace-independent. */
  workspace: string;
  /** STABLE logical account identity (normalized email/handle) — never a
   *  rotating `ca_…` connection id. '' for accountless (CLI) procedures. */
  accountIdentity: string;
}

/**
 * Typed argument-template IR. Named slots stay explicit so the model fills
 * MEANING while the adapter owns field names and JSON encoding — the carrier
 * incident class (reinvented field names, double encoding) cannot recur
 * through an artifact because the artifact stores structure, not prose.
 */
export interface ProcedureTemplateIR {
  /** Literal argument entries. Values may contain `{{slot}}` placeholders. */
  args: Record<string, unknown>;
  /** Slot names that must be supplied at bind time, in template order. */
  slots: string[];
}

export interface DispatchReceipt {
  /** Caller-durable receipt id (effect ledger / evidence store). */
  receiptId: string;
  /** ISO-8601 of the verified dispatch. */
  at: string;
  /** Fingerprint of the live tool contract the dispatch ran against. */
  schemaFingerprint: string;
  /** For writes: the observation/commit reference. Reads may omit. */
  observationRef?: string;
}

export type ProcedureArtifactStatus = 'active' | 'quarantined' | 'superseded';

export interface ProcedureUseEvidence {
  useId: string;
  at: string;
  kind: 'success' | 'transient_failure' | 'structural_failure' | 'repair';
  detail?: string;
}

export interface ProcedureArtifact {
  /** Content digest over scope + logical key + carrier + template IR. */
  artifactId: string;
  scope: ProcedureScope;
  /** provider + operation + effect class — the logical key. */
  provider: string;
  operation: string;
  effectClass: 'read' | 'write' | 'send';
  kind: ProcedureKind;
  /** Carrier identity: the dispatchable identifier (slug/command/tool). */
  identifier: string;
  template: ProcedureTemplateIR;
  /** The contract fingerprint the artifact was PROVEN against. */
  schemaFingerprint: string;
  /** The receipt that promoted it. An artifact without one cannot exist. */
  promotedBy: DispatchReceipt;
  status: ProcedureArtifactStatus;
  /** Present when quarantined/superseded: the exact reason or successor id. */
  statusReason?: string;
  supersededBy?: string;
  validAt: string;
  invalidAt?: string;
  evidence: ProcedureUseEvidence[];
  createdAt: string;
  updatedAt: string;
}

export type ProcedureResolution =
  /** Executable now: IR + required slots + exact artifact identity. */
  | { outcome: 'bound'; artifact: ProcedureArtifact; requiredSlots: string[] }
  /** Valid procedure, missing request-specific slot values. */
  | { outcome: 'needs_slots'; artifact: ProcedureArtifact; missingSlots: string[] }
  /** Live contract drifted from the proven one. Quarantined, reason named. */
  | { outcome: 'stale'; artifactId: string; reason: string }
  /** The capability/account this artifact needs is not currently connected. */
  | { outcome: 'unavailable'; artifactId: string; reason: string }
  /** Nothing proven in scope — use generic discovery. Nothing half-true. */
  | { outcome: 'miss' };

// ── storage ──────────────────────────────────────────────────────────────────

const ARTIFACTS_ROOT = path.join(BASE_DIR, 'memory', 'procedure-artifacts');

function artifactDir(): string {
  return path.join(ARTIFACTS_ROOT, getMachineId());
}

function artifactPath(artifactId: string): string {
  return path.join(artifactDir(), `${artifactId}.json`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Extract `{{slot}}` names from the template args, in first-appearance order. */
export function templateSlots(args: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
        const slot = match[1]!;
        if (!seen.has(slot)) { seen.add(slot); out.push(slot); }
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(args);
  return out;
}

/** The content address. Everything that makes two procedures "the same". */
export function computeArtifactId(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: string;
  kind: ProcedureKind;
  identifier: string;
  template: ProcedureTemplateIR;
}): string {
  return `pa_${sha256(stableJson(input)).slice(0, 40)}`;
}

// ── promotion (the ONE write path) ───────────────────────────────────────────

export type PromotionResult =
  | { ok: true; artifact: ProcedureArtifact; superseded?: string }
  | { ok: false; errors: string[] };

/**
 * Promote a verified dispatch into an artifact. The only write path — there
 * is deliberately no "remember" that takes prose, and no promotion without a
 * receipt whose schema fingerprint is present. Volatile connection identity
 * is stripped from the template; a stored rotating id silently breaks a whole
 * toolkit when it rotates, so it can never travel.
 */
export function promoteProcedureArtifact(input: {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: 'read' | 'write' | 'send';
  kind: ProcedureKind;
  identifier: string;
  templateArgs: Record<string, unknown>;
  receipt: DispatchReceipt;
  now?: string;
}): PromotionResult {
  const errors: string[] = [];
  const identifier = input.identifier.trim();
  if (isPlaceholderToken(identifier)) errors.push(`identifier "${identifier}" is filler, not a tool`);
  else if (input.kind === 'composio' && !composioSlugIsDispatchable(identifier)) {
    errors.push(`identifier "${identifier}" cannot name a provider action`);
  }
  if (!input.receipt.receiptId.trim()) errors.push('a promotion requires a verified dispatch receipt');
  if (!input.receipt.schemaFingerprint.trim()) {
    errors.push('a receipt without a schema fingerprint cannot prove what the dispatch ran against');
  }
  if (input.effectClass !== 'read' && !input.receipt.observationRef) {
    errors.push(`a ${input.effectClass} promotion requires the observation/commit reference, not just a dispatch`);
  }
  if (!input.provider.trim()) errors.push('provider is required');
  if (!input.operation.trim()) errors.push('operation is required');
  if (/^ca_/i.test(input.scope.accountIdentity)) {
    errors.push('scope.accountIdentity is a rotating connection id; use the stable account identity');
  }
  if (errors.length > 0) return { ok: false, errors };

  const { args } = stripVolatileConnectionArgs(input.templateArgs);
  const template: ProcedureTemplateIR = { args, slots: templateSlots(args) };
  const now = input.now ?? new Date().toISOString();
  const artifactId = computeArtifactId({
    scope: input.scope,
    provider: input.provider,
    operation: input.operation,
    effectClass: input.effectClass,
    kind: input.kind,
    identifier,
    template,
  });

  const existing = readArtifact(artifactId);
  if (existing) {
    // Same content address = the same procedure re-proven. Refresh the proof,
    // reactivate if quarantined (a fresh receipt IS the re-promotion path),
    // keep evidence history.
    const refreshed: ProcedureArtifact = {
      ...existing,
      schemaFingerprint: input.receipt.schemaFingerprint,
      promotedBy: input.receipt,
      status: 'active',
      statusReason: undefined,
      supersededBy: undefined,
      invalidAt: undefined,
      validAt: now,
      updatedAt: now,
    };
    writeArtifact(refreshed);
    return { ok: true, artifact: refreshed };
  }

  // A DIFFERENT artifact for the same logical key supersedes the old one —
  // one canonical procedure per logical operation, never conflicting
  // active duplicates.
  const priorForKey = listArtifacts().find((candidate) =>
    candidate.status === 'active'
    && sameScope(candidate.scope, input.scope)
    && candidate.provider === input.provider
    && candidate.operation === input.operation
    && candidate.effectClass === input.effectClass);

  const artifact: ProcedureArtifact = {
    artifactId,
    scope: { ...input.scope },
    provider: input.provider,
    operation: input.operation,
    effectClass: input.effectClass,
    kind: input.kind,
    identifier,
    template,
    schemaFingerprint: input.receipt.schemaFingerprint,
    promotedBy: input.receipt,
    status: 'active',
    validAt: now,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };
  writeArtifact(artifact);

  if (priorForKey && priorForKey.artifactId !== artifactId) {
    writeArtifact({
      ...priorForKey,
      status: 'superseded',
      statusReason: `superseded by ${artifactId}`,
      supersededBy: artifactId,
      invalidAt: now,
      updatedAt: now,
    });
    return { ok: true, artifact, superseded: priorForKey.artifactId };
  }
  return { ok: true, artifact };
}

// ── resolution (the ONE read path) ───────────────────────────────────────────

export interface ResolveProcedureInput {
  scope: ProcedureScope;
  provider: string;
  operation: string;
  effectClass: 'read' | 'write' | 'send';
  /** The live tool contract fingerprint, when the caller has it. Absent means
   *  the caller could not know — resolution stays bound and the dispatch
   *  boundary revalidates. Present-and-different is drift. */
  liveSchemaFingerprint?: string;
  /** Whether the capability/account is currently connected. Defaults true. */
  accountConnected?: boolean;
  /** Slot values available from the request, keyed by slot name. */
  slotValues?: Record<string, string>;
}

/**
 * Resolve the proven procedure for a logical operation within a scope.
 *
 * Scope isolation is structural: candidates are filtered by exact scope
 * before anything else, so a cross-tenant/workspace/account lookup cannot
 * reuse an artifact no matter how well the names match. Drift quarantines
 * durably at read time — the next resolution reports the quarantine rather
 * than re-detecting it, and a fresh receipt is the only way back.
 */
export function resolveProcedureArtifact(input: ResolveProcedureInput): ProcedureResolution {
  const candidate = listArtifacts().find((artifact) =>
    artifact.status === 'active'
    && sameScope(artifact.scope, input.scope)
    && artifact.provider === input.provider
    && artifact.operation === input.operation
    && artifact.effectClass === input.effectClass);
  if (!candidate) return { outcome: 'miss' };

  if (input.accountConnected === false) {
    return {
      outcome: 'unavailable',
      artifactId: candidate.artifactId,
      reason: `account "${candidate.scope.accountIdentity || '(none)'}" is not connected`,
    };
  }

  if (input.liveSchemaFingerprint && input.liveSchemaFingerprint !== candidate.schemaFingerprint) {
    const reason = `proven against ${candidate.schemaFingerprint}, live contract is ${input.liveSchemaFingerprint}`;
    writeArtifact({
      ...candidate,
      status: 'quarantined',
      statusReason: reason,
      invalidAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { outcome: 'stale', artifactId: candidate.artifactId, reason };
  }

  const missing = candidate.template.slots.filter((slot) => !(slot in (input.slotValues ?? {})));
  if (missing.length > 0) {
    return { outcome: 'needs_slots', artifact: candidate, missingSlots: missing };
  }
  return { outcome: 'bound', artifact: candidate, requiredSlots: candidate.template.slots };
}

// ── outcome attribution (exact use, never broad credit) ──────────────────────

/**
 * Attach an outcome to the EXACT artifact used. Only a reproducible
 * structural failure quarantines; transient provider trouble and bad slot
 * values are evidence, not poison. Success on a quarantined artifact does
 * not reactivate it — only a fresh receipt does, through promotion.
 */
export function recordProcedureUse(
  artifactId: string,
  outcome: ProcedureUseEvidence['kind'],
  detail?: string,
): ProcedureArtifact | null {
  const artifact = readArtifact(artifactId);
  if (!artifact) return null;
  const now = new Date().toISOString();
  const next: ProcedureArtifact = {
    ...artifact,
    evidence: [...artifact.evidence, { useId: `use_${randomUUID()}`, at: now, kind: outcome, detail }].slice(-200),
    updatedAt: now,
  };
  if (outcome === 'structural_failure' && artifact.status === 'active') {
    next.status = 'quarantined';
    next.statusReason = detail ?? 'reproducible structural failure';
    next.invalidAt = now;
  }
  writeArtifact(next);
  return next;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function sameScope(a: ProcedureScope, b: ProcedureScope): boolean {
  return a.tenant === b.tenant && a.workspace === b.workspace && a.accountIdentity === b.accountIdentity;
}

export function readArtifact(artifactId: string): ProcedureArtifact | null {
  try {
    const file = artifactPath(artifactId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as ProcedureArtifact;
  } catch {
    // A torn or hand-edited file degrades to "no artifact", never a crash in
    // the resolution path.
    return null;
  }
}

export function listArtifacts(): ProcedureArtifact[] {
  try {
    const dir = artifactDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readArtifact(name.slice(0, -'.json'.length)))
      .filter((artifact): artifact is ProcedureArtifact => artifact !== null);
  } catch {
    return [];
  }
}

function writeArtifact(artifact: ProcedureArtifact): void {
  const dir = artifactDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = artifactPath(artifact.artifactId);
  const temporary = path.join(dir, `.${artifact.artifactId}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  renameSync(temporary, file);
}
