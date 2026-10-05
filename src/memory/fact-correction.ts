/** Atomic literal correction of one observed fact. Call admission remains host-owned. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { openMemoryDb, type ConsolidatedFactRow, type MemoryEpisodeRow } from './db.js';
import { currentMemoryReadScope, scopeVisible, stampMemoryScope, type MemoryScope } from './memory-scope.js';
import { syncMemoryPolicyForFact } from './temporal-memory.js';
import { retainFactEntityLinks } from './retained-fact-entities.js';
import {
  applyExactFactPatches, createFactObservation, factCorrectionPatchesSchema,
  factObservationSchema, parseFactObservation, type FactCorrectionPatch, type FactObservationV1,
} from './fact-observation.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown): string => hash(JSON.stringify(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const ownerSchema = z.object({
  sessionId: z.string().min(1), sourceUserSeq: positive, sourceEventId: z.string().min(1),
  sourceContextDigest: digest, logicalToolCallId: z.string().min(1), argumentsDigest: digest,
  assessmentDigest: digest, ownerText: z.string().min(1), occurredAt: z.string().datetime(),
}).strict();
export type FactCorrectionOwner = z.infer<typeof ownerSchema>;
const proofOwnerSchema = ownerSchema.omit({ ownerText: true }).extend({ ownerTextDigest: digest }).strict();
const proofSchema = z.object({
  protocol: z.literal('fact_correction_v1'), version: z.literal(1), episodeId: z.string().min(1),
  targetId: positive, expectedObservationDigest: digest,
  patches: factCorrectionPatchesSchema, patchesDigest: digest,
  before: factObservationSchema, after: factObservationSchema,
  owner: proofOwnerSchema, occurredAt: z.string().datetime(),
  retainedEntityLinkCount: z.number().int().nonnegative(),
  preservedEvidenceRefs: z.array(z.object({ factId: positive, episodeId: z.string().min(1), ordinal: z.number().int().nonnegative() }).strict()),
  historicalResourceLinkCount: z.number().int().nonnegative(),
}).strict();
export type FactCorrectionProofV1 = z.infer<typeof proofSchema>;
export interface CorrectFactExactInput {
  targetId: number;
  expectedObservationDigest: string;
  patches: readonly FactCorrectionPatch[];
  /** Host-owned exact accepted source/call and retained positive semantic assessment. */
  owner: FactCorrectionOwner;
  /** Never a model argument. Tool admission must authorize AND surface the rule change. */
  allowProtectedCorrection?: true;
  /** Synchronous host lease/source check after the write lock is acquired. */
  assertCurrent?: () => void;
}
export type FactCorrectionResult =
  | { status: 'corrected' | 'replayed'; proof: FactCorrectionProofV1; current: FactObservationV1 | null; currentStateMatches: boolean }
  | { status: 'already_current'; observation: FactObservationV1 }
  | { status: 'refused'; reason: string };

function scopeInDatabase(db: Database.Database, id: number | string, kind: 'fact' | 'episode' = 'fact'): MemoryScope {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_scopes'").get()) {
    throw new Error('Stored fact scope is unavailable.');
  }
  const row = db.prepare("SELECT scope_project_id, scope_agent_key FROM memory_scopes WHERE target_kind=? AND target_id=?")
    .get(kind, String(id)) as { scope_project_id: string | null; scope_agent_key: string | null } | undefined;
  return { projectId: row?.scope_project_id ?? null, agentKey: row?.scope_agent_key ?? null };
}
function observationInDatabase(db: Database.Database, id: number, visible = true): FactObservationV1 | null {
  const row = db.prepare('SELECT * FROM consolidated_facts WHERE id=?').get(id) as ConsolidatedFactRow | undefined;
  if (!row) return null;
  const scope = scopeInDatabase(db, id);
  if (visible && !scopeVisible(scope, currentMemoryReadScope())) return null;
  if (![0, 1].includes(row.active) || ![0, 1].includes(row.pinned)) throw new Error('Invalid fact lifecycle state.');
  return createFactObservation({ version: 1, id: row.id, kind: row.kind, content: row.content, scope,
    active: row.active === 1, pinned: row.pinned === 1, createdAt: row.created_at,
    validFrom: row.valid_from, validTo: row.valid_to, supersededByFactId: row.superseded_by_fact_id,
    provenance: {
      sourceSessionId: row.source_session_id, sourcePath: row.source_path, sourceApp: row.source_app,
      derivedFromSessionId: row.derived_from_session_id, derivedFromCallId: row.derived_from_call_id,
      derivedFromTool: row.derived_from_tool, derivedFromFactIds: row.derived_from_fact_ids === null ? null : JSON.parse(row.derived_from_fact_ids),
      derivationDepth: row.derivation_depth, trustLevel: row.trust_level, confidence: row.confidence,
      extractedAt: row.extracted_at,
    } });
}
/** Full content, exact stored scope. No ranking/access-score mutation. */
export function readFactObservation(id: number): FactObservationV1 | null {
  positive.parse(id);
  const db = openMemoryDb();
  return db.transaction(() => observationInDatabase(db, id))();
}
function correctionCall(owner: Pick<FactCorrectionOwner, 'sourceUserSeq' | 'logicalToolCallId'>): string {
  return `fact-correction:${owner.sourceUserSeq}:${owner.logicalToolCallId}`;
}
function correctionEpisode(owner: Pick<FactCorrectionOwner, 'sessionId' | 'sourceUserSeq' | 'logicalToolCallId'>): string {
  return `call:${hash(`${owner.sessionId}:${correctionCall(owner)}`).slice(0, 24)}`;
}
function proofOwner(owner: FactCorrectionOwner): FactCorrectionProofV1['owner'] {
  const { ownerText, ...identity } = owner;
  return { ...identity, ownerTextDigest: hash(ownerText) };
}
function parseProof(value: unknown): FactCorrectionProofV1 {
  const proof = proofSchema.parse(value);
  parseFactObservation(proof.before); parseFactObservation(proof.after);
  if (proof.targetId !== proof.before.id || proof.expectedObservationDigest !== proof.before.digest
    || proof.patchesDigest !== jsonHash(proof.patches) || proof.episodeId !== correctionEpisode(proof.owner)
    || proof.occurredAt !== proof.owner.occurredAt || proof.after.validFrom !== proof.occurredAt
    || !proof.before.active || !proof.after.active || proof.after.validTo !== null || proof.after.supersededByFactId !== null
    || proof.after.id === proof.before.id || proof.after.kind !== proof.before.kind || proof.after.pinned !== proof.before.pinned
    || JSON.stringify(proof.after.scope) !== JSON.stringify(proof.before.scope)
    || applyExactFactPatches(proof.before.content, proof.patches).content !== proof.after.content) {
    throw new Error('Correction proof is inconsistent.');
  }
  return proof;
}
function readProofInDatabase(db: Database.Database, episodeId: string): FactCorrectionProofV1 | null {
  const row = db.prepare('SELECT * FROM memory_episodes WHERE id=?').get(episodeId) as MemoryEpisodeRow | undefined;
  if (!row) return null;
  const metadata: unknown = JSON.parse(row.metadata_json);
  const parsed = z.object({ factCorrection: proofSchema }).strict().parse(metadata);
  const proof = parseProof(parsed.factCorrection);
  if (row.id !== proof.episodeId || row.session_id !== proof.owner.sessionId || row.call_id !== correctionCall(proof.owner)
    || row.kind !== 'user_turn' || row.subtype !== 'fact_correction_v1' || row.status !== 'available'
    || row.occurred_at !== proof.occurredAt || !row.evidence_excerpt || row.content_hash !== hash(row.evidence_excerpt)
    || JSON.stringify(scopeInDatabase(db, row.id, 'episode')) !== JSON.stringify(proof.before.scope)) {
    throw new Error('Correction episode is inconsistent.');
  }
  // Evidence must survive; an episode alone is not a committed operation.
  const evidence = db.prepare('SELECT excerpt FROM fact_evidence WHERE fact_id=? AND episode_id=? AND ordinal=0')
    .get(proof.after.id, proof.episodeId) as { excerpt: string } | undefined;
  if (evidence?.excerpt !== row.evidence_excerpt) throw new Error('Correction evidence is unavailable.');
  return proof;
}
/** Historical operation only. Consumers must separately re-read actual current state. */
export function readFactCorrectionProof(episodeId: string): FactCorrectionProofV1 | null {
  const db = openMemoryDb();
  return db.transaction(() => readProofInDatabase(db, episodeId))();
}
function currentMatches(db: Database.Database, proof: FactCorrectionProofV1): { current: FactObservationV1 | null; currentStateMatches: boolean } {
  const old = observationInDatabase(db, proof.before.id);
  const current = observationInDatabase(db, proof.after.id);
  const { digest: _priorDigest, ...body } = proof.before;
  const retired = createFactObservation({ ...body, active: false, validTo: proof.occurredAt, supersededByFactId: proof.after.id });
  const currentStateMatches = Boolean(old?.digest === retired.digest && current?.digest === proof.after.digest);
  return { current, currentStateMatches };
}

/** Exact target only. No similarity retrieval, provider work, ambient write scope or legacy supersede calls. */
export function correctFactExact(raw: CorrectFactExactInput): FactCorrectionResult {
  const { assertCurrent, ...serializable } = raw;
  if (assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new Error('Invalid host correction check.');
  const input = z.object({ targetId: positive, expectedObservationDigest: digest,
    patches: factCorrectionPatchesSchema, owner: ownerSchema, allowProtectedCorrection: z.literal(true).optional() }).strict().parse(serializable);
  const db = openMemoryDb();
  return db.transaction((): FactCorrectionResult => {
    const episodeId = correctionEpisode(input.owner);
    const prior = readProofInDatabase(db, episodeId);
    if (prior) {
      if (prior.targetId !== input.targetId || prior.expectedObservationDigest !== input.expectedObservationDigest
        || prior.patchesDigest !== jsonHash(input.patches) || JSON.stringify(prior.owner) !== JSON.stringify(proofOwner(input.owner))) {
        return { status: 'refused', reason: 'correction_call_identity_conflict' };
      }
      return { status: 'replayed', proof: prior, ...currentMatches(db, prior) };
    }
    const before = observationInDatabase(db, input.targetId);
    if (!before) return { status: 'refused', reason: 'target_unavailable' };
    if (!before.active || before.validTo !== null || before.supersededByFactId !== null || before.digest !== input.expectedObservationDigest) {
      return { status: 'refused', reason: 'stale_observation' };
    }
    if ((before.pinned || before.kind === 'constraint') && !input.allowProtectedCorrection) {
      return { status: 'refused', reason: 'protected_target_requires_host_authority' };
    }
    const patched = applyExactFactPatches(before.content, input.patches);
    if (patched.content === before.content) return { status: 'already_current', observation: before };
    // Preserve byte-exact untouched content. Existing store canonical identity
    // is whitespace-normalized/case-insensitive; do not silently recanonicalize.
    if (patched.content.replace(/\s+/g, ' ').trim() !== patched.content) {
      return { status: 'refused', reason: 'noncanonical_replacement' };
    }
    const suffix = before.scope.projectId || before.scope.agentKey
      ? `::scope:${before.scope.projectId ?? ''}|${before.scope.agentKey ?? ''}` : '';
    const contentHash = createHash('sha1').update(`${before.kind}::${patched.content.toLowerCase()}${suffix}`).digest('hex');
    if (db.prepare('SELECT 1 FROM consolidated_facts WHERE content_hash=?').get(contentHash)) {
      return { status: 'refused', reason: 'canonical_identity_collision' };
    }
    const boundary = Date.parse(input.owner.occurredAt);
    const priorBoundary = Date.parse(before.validFrom ?? before.createdAt);
    if (!Number.isFinite(priorBoundary) || boundary < priorBoundary) return { status: 'refused', reason: 'invalid_correction_boundary' };
    const old = db.prepare('SELECT * FROM consolidated_facts WHERE id=?').get(before.id) as ConsolidatedFactRow;
    const refs = db.prepare('SELECT fact_id AS factId,episode_id AS episodeId,ordinal FROM fact_evidence WHERE fact_id=? ORDER BY episode_id,ordinal')
      .all(before.id) as FactCorrectionProofV1['preservedEvidenceRefs'];
    const historicalResourceLinkCount = Number((db.prepare('SELECT count(*) AS n FROM fact_resources WHERE fact_id=?').get(before.id) as { n: number }).n);
    const now = new Date().toISOString();
    const sourceUri = `conversation://${input.owner.sessionId}/user-source:${input.owner.sourceUserSeq}`;
    const lineage = [...new Set([...(before.provenance.derivedFromFactIds ?? []), before.id])];
    // A blocked IMMEDIATE lock may outlive the outer host lease check. Replay
    // above is read-only and does not require a fresh mutation grant.
    assertCurrent?.();
    // The replacement is an owner correction, not a fresh read by the old
    // external tool. Historical source evidence remains on the retired fact.
    // Preserve conservative trust/depth and explicit ancestry without reusing
    // its external call attribution for the changed text.
    // Direct insertion avoids rememberFact's dedup/reactivation, best-effort
    // evidence, unscoped enrichment and pre-commit operational emissions.
    const written = db.prepare(`INSERT INTO consolidated_facts
      (kind,content,content_hash,source_session_id,source_path,score,active,created_at,updated_at,
       derived_from_session_id,derived_from_call_id,derived_from_tool,trust_level,extracted_at,
       importance,derivation_depth,derived_from_fact_ids,source_app,pinned,valid_from,confidence)
      VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      before.kind, patched.content, contentHash, input.owner.sessionId, sourceUri, old.score, now, now,
      null, null, null, old.trust_level, now,
      old.importance, old.derivation_depth, JSON.stringify(lineage), 'Conversation', old.pinned, input.owner.occurredAt, old.confidence);
    const successorId = Number(written.lastInsertRowid);
    stampMemoryScope('fact', successorId, before.scope, { sessionId: input.owner.sessionId });
    // The occurrence source is accepted owner input, never the model's full rewrite.
    // Full raw source remains in the harness event; the episode is explicitly bounded.
    const excerptBoundary = input.owner.ownerText.length > 2000
      && /[\uD800-\uDBFF]/.test(input.owner.ownerText[1999]!)
      && /[\uDC00-\uDFFF]/.test(input.owner.ownerText[2000]!) ? 1999 : 2000;
    const excerpt = input.owner.ownerText.slice(0, excerptBoundary);
    db.prepare(`INSERT INTO memory_episodes
      (id,kind,source_app,session_id,call_id,source_uri,occurred_at,ingested_at,content_hash,evidence_excerpt,status,subtype,metadata_json)
      VALUES (?,'user_turn','Conversation',?,?,?,?,?,?,?,'available','fact_correction_v1','{}')`).run(
      episodeId, input.owner.sessionId, correctionCall(input.owner), sourceUri, input.owner.occurredAt, now, hash(excerpt), excerpt);
    stampMemoryScope('episode', episodeId, before.scope, { sessionId: input.owner.sessionId });
    db.prepare('INSERT INTO fact_evidence(fact_id,episode_id,excerpt,source_uri,ordinal,created_at) VALUES (?,?,?,?,0,?)')
      .run(successorId, episodeId, excerpt, sourceUri, now);
    const changed = db.prepare(`UPDATE consolidated_facts SET active=0,valid_to=?,superseded_by_fact_id=?,updated_at=?
      WHERE id=? AND active=1 AND content_hash=? AND pinned=? AND valid_to IS NULL AND superseded_by_fact_id IS NULL`)
      .run(input.owner.occurredAt, successorId, now, before.id, old.content_hash, old.pinned);
    if (changed.changes !== 1) throw new Error('Correction compare-and-swap lost its target.');
    // This helper carries only previously grounded names shared by old/new
    // claims and evidence. It does not observe identities or mutate aggregates.
    const retainedEntityLinkCount = retainFactEntityLinks(db, before.id, successorId);
    syncMemoryPolicyForFact(before.id); syncMemoryPolicyForFact(successorId);
    const after = observationInDatabase(db, successorId);
    if (!after || JSON.stringify(after.scope) !== JSON.stringify(before.scope) || after.content !== patched.content) {
      throw new Error('Correction destination postcondition failed.');
    }
    const proof = parseProof({ protocol: 'fact_correction_v1', version: 1, episodeId,
      targetId: before.id, expectedObservationDigest: before.digest, patches: input.patches,
      patchesDigest: jsonHash(input.patches), before, after, owner: proofOwner(input.owner),
      occurredAt: input.owner.occurredAt, retainedEntityLinkCount, preservedEvidenceRefs: refs, historicalResourceLinkCount });
    db.prepare('UPDATE memory_episodes SET metadata_json=? WHERE id=?').run(JSON.stringify({ factCorrection: proof }), episodeId);
    const verified = readProofInDatabase(db, episodeId);
    if (!verified || !currentMatches(db, verified).currentStateMatches) throw new Error('Correction proof postcondition failed.');
    return { status: 'corrected', proof: verified, ...currentMatches(db, verified) };
  }).immediate();
}
