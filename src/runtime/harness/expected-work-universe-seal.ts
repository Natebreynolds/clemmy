/**
 * Host-owned sealing for source-derived universes.
 *
 * A count-only ask ("draft one for each open opportunity") has no enumerable
 * member set when the task is accepted: the members are whatever the source
 * read returns. Its contract therefore declares the universe by its producer,
 * and the exact member list is sealed HERE — derived from that producer's own
 * settled, exhausted result and the member-id pointer the contract froze.
 *
 * The seal is evidence, never a proposal: no caller may hand one in, an
 * unreadable or unfinished source refuses, and an id the pointer cannot produce
 * refuses by name instead of being guessed. Because it is derived from
 * immutable settled bytes, sealing the same universe twice — in a later call,
 * at terminal match, or after a restart — yields the same members and digest.
 */
import type Database from 'better-sqlite3';
import { insertInternalEventInTransaction } from './eventlog.js';
import {
  EXPECTED_WORK_MAX_UNIVERSE_MEMBERS,
  canonicalExpectedWorkJson,
  expectedWorkDigest,
  isBoundedJsonPointer,
  resolveJsonPointer,
  type AcceptedTaskWorkContractV1,
  type ExpectedWorkUniverseV1,
} from './expected-work-contract.js';
import { deriveResultHandleFactsFromRaw, recordsAtRecordPath } from './result-facts.js';
import {
  redeemedReadIsExhausted,
  redeemSuccessfulSettlementResultForHost,
  type SuccessfulSettlementResultEvidence,
} from './result-handle.js';

export const EXPECTED_WORK_UNIVERSE_AMENDED_EVENT = 'expected_work_universe_amended' as const;

export type SourceDerivedUniverseV1 = Extract<
  ExpectedWorkUniverseV1,
  { seal: 'complete_source_receipt' }
>;

export interface ExpectedWorkUniverseSeal {
  universeId: string;
  producerRequirementId: string;
  /** The one settled producer call whose result this seal redeems. */
  producerLogicalToolCallId: string;
  /** Sorted, unique, bounded member ids. */
  members: string[];
  digest: string;
}

export type ExpectedWorkUniverseSealResult =
  | { status: 'sealed'; seal: ExpectedWorkUniverseSeal }
  | { status: 'unsealed'; reason: string };

/** Per-admission/per-projection memo. Redemption re-reads and re-digests the
 *  full raw payload, and one refusal can ask for the same seal several times. */
export type ExpectedWorkUniverseSealCache = Map<string, ExpectedWorkUniverseSealResult>;

export function createExpectedWorkUniverseSealCache(): ExpectedWorkUniverseSealCache {
  return new Map<string, ExpectedWorkUniverseSealResult>();
}

const MEMBER_ID_MAX_LENGTH = 256;

interface SettledProducerRow {
  logical_tool_call_id: string;
  effect_kind: string;
  cardinality_kind: string;
  evidence_mode: string | null;
  outcome_kind: string;
  continues_requirement: number;
}

/** The record's own top-level keys, as DATA in the refusal. A frozen pointer
 *  cannot be verified until the read settles, so when it misses, the one thing
 *  that lets the model correct itself next turn is what the records actually
 *  carry — '/id' against records keyed "Id" is otherwise a silent dead end. */
function availableKeys(record: unknown): string {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  const keys = Object.keys(record as Record<string, unknown>).slice(0, 8);
  return keys.length > 0 ? ` (record keys: ${keys.map((key) => `/${key}`).join(', ')})` : '';
}

function memberIdOf(
  record: unknown,
  pointer: string,
  index: number,
): { ok: true; id: string } | { ok: false; reason: string } {
  const resolved = resolveJsonPointer(record, pointer);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `source record ${index} has no value at member id pointer '${pointer}'${availableKeys(record)}`,
    };
  }
  const value = resolved.value;
  if (typeof value !== 'string' || value.length < 1 || value.length > MEMBER_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: `source record ${index} has no bounded string member id at pointer '${pointer}'${availableKeys(record)}`,
    };
  }
  return { ok: true, id: value };
}

/**
 * The records a settled source read actually produced.
 *
 * A host read hands back exactly what the tool returned, and a local file of
 * JSON arrives as TEXT — the bytes ARE the records, but the handle's own facts
 * see a string and find no collection. Refusing there would fail the model for
 * a representation detail after it did precisely the right read (live
 * 2026-08-11: leads.json read whole, 671 bytes, record_path NULL).
 *
 * Strictly guarded: host executions only, only a string that strictly parses,
 * and the parsed value goes through the SAME derivation an object payload
 * takes — no second shape-extraction path, no lenient parsing, no repair. A
 * provider string is untouched: a provider that returns text is making a
 * claim about its own shape, and we do not reinterpret it.
 */
function sourceRecordsFor(
  value: SuccessfulSettlementResultEvidence,
): { ok: true; records: unknown[] } | { ok: false; reason: 'no_collection' | 'count_mismatch' } {
  const direct = recordsAtRecordPath(value.rawPayload, value.handle.recordPath);
  if (direct) {
    return direct.length === value.handle.recordCount
      ? { ok: true, records: direct }
      : { ok: false, reason: 'count_mismatch' };
  }
  if (value.executionSite !== 'host' || typeof value.rawPayload !== 'string') {
    return { ok: false, reason: 'no_collection' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.rawPayload) as unknown;
  } catch {
    return { ok: false, reason: 'no_collection' };
  }
  const facts = deriveResultHandleFactsFromRaw(parsed);
  const records = recordsAtRecordPath(parsed, facts.recordPath);
  if (!records) return { ok: false, reason: 'no_collection' };
  return records.length === facts.recordCount
    ? { ok: true, records }
    : { ok: false, reason: 'count_mismatch' };
}


/** The pointer in force for this universe: the contract's, unless exactly one
 *  amendment corrected it. Read fresh every time — never cached across the
 *  amendment that changes it, and never taken from the audit event. */
function effectiveMemberIdPointer(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  universe: SourceDerivedUniverseV1,
): string {
  const row = db.prepare(`
    SELECT member_id_pointer FROM expected_work_universe_amendments
     WHERE session_id = ? AND source_user_seq = ? AND contract_id = ? AND universe_id = ?
  `).get(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    universe.id,
  ) as { member_id_pointer: string } | undefined;
  return row?.member_id_pointer ?? universe.memberIdPointer;
}


function deriveSealWithPointer(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  universe: SourceDerivedUniverseV1,
  pointer: string,
): ExpectedWorkUniverseSealResult {
  const producer = contract.operations.find((entry) => entry.id === universe.producedBy);
  if (
    !producer
    || producer.effect !== 'read'
    || producer.coverage !== 'complete_set'
    || producer.cardinality.kind !== 'once'
  ) {
    return {
      status: 'unsealed',
      reason: `universe ${universe.id} names no complete-set source read producer`,
    };
  }

  const rows = db.prepare(`
    SELECT b.logical_tool_call_id, b.effect_kind, b.cardinality_kind, b.evidence_mode,
           s.outcome_kind, s.continues_requirement
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
  `).all(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    universe.producedBy,
  ) as SettledProducerRow[];

  const settled = rows.filter((row) =>
    (row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result')
    && row.continues_requirement === 0
    && row.effect_kind === 'read'
    && row.cardinality_kind === 'once'
    && row.evidence_mode === 'collection_read');
  if (settled.length === 0) {
    return {
      status: 'unsealed',
      reason: `the complete source read ${universe.producedBy} has not settled a completed collection result yet`,
    };
  }
  if (settled.length !== 1) {
    return {
      status: 'unsealed',
      reason: `more than one settled source read claims requirement ${universe.producedBy}`,
    };
  }

  const producerCall = settled[0]!.logical_tool_call_id;
  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: contract.identity.sessionId,
    sourceUserSeq: contract.identity.sourceUserSeq,
    acceptedTaskId: contract.acceptedTaskId,
    logicalToolCallId: producerCall,
  });
  if (redeemed.status !== 'ok') {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} result is ${redeemed.status}: ${redeemed.reason}`,
    };
  }
  // One authority decides exhaustion for every reader.
  if (!redeemedReadIsExhausted(redeemed.value)) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} does not prove it exhausted its collection`,
    };
  }

  const source = sourceRecordsFor(redeemed.value);
  if (!source.ok) {
    return {
      status: 'unsealed',
      reason: source.reason === 'count_mismatch'
        ? `the settled source read ${universe.producedBy} disagrees with its durable record count`
        : `the settled source read ${universe.producedBy} exposes no record collection to seal`,
    };
  }
  const records = source.records;
  if (records.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} returned more than ${EXPECTED_WORK_MAX_UNIVERSE_MEMBERS} members`,
    };
  }

  const members: string[] = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    const member = memberIdOf(record, pointer, index);
    if (!member.ok) return { status: 'unsealed', reason: member.reason };
    if (seen.has(member.id)) {
      return {
        status: 'unsealed',
        reason: `source records repeat member id '${member.id}' at pointer '${pointer}'`,
      };
    }
    seen.add(member.id);
    members.push(member.id);
  }
  const sorted = [...members].sort();

  return {
    status: 'sealed',
    seal: {
      universeId: universe.id,
      producerRequirementId: universe.producedBy,
      producerLogicalToolCallId: producerCall,
      members: sorted,
      digest: expectedWorkDigest(canonicalExpectedWorkJson(sorted)),
    },
  };
}

/**
 * Seal one source-derived universe from its producer's settled complete read.
 * Safe to call inside the caller's IMMEDIATE transaction: it only reads.
 */
export function sealSourceDerivedUniverse(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  universe: SourceDerivedUniverseV1;
  cache?: ExpectedWorkUniverseSealCache;
}): ExpectedWorkUniverseSealResult {
  const key = `${input.contract.contractId}\0${input.universe.id}`;
  const cached = input.cache?.get(key);
  if (cached) return cached;
  let result: ExpectedWorkUniverseSealResult;
  try {
    result = deriveSealWithPointer(
      input.db,
      input.contract,
      input.universe,
      effectiveMemberIdPointer(input.db, input.contract, input.universe),
    );
  } catch (error) {
    // An unreadable store refuses; it never seals a partial universe.
    result = {
      status: 'unsealed',
      reason: `the source universe store is unreadable: ${
        String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 160)
      }`,
    };
  }
  input.cache?.set(key, result);
  return result;
}

/**
 * Resolve the member set of any universe an operation may consume. Accepted
 * input is already exact; a source-derived universe must redeem its seal.
 */
export function resolveExpectedWorkUniverseMembers(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  universe: ExpectedWorkUniverseV1;
  cache?: ExpectedWorkUniverseSealCache;
}): { status: 'resolved'; members: string[]; seal?: ExpectedWorkUniverseSeal }
  | { status: 'unsealed'; reason: string } {
  if (input.universe.seal === 'accepted_input') {
    return { status: 'resolved', members: [...input.universe.members].sort() };
  }
  const sealed = sealSourceDerivedUniverse({
    db: input.db,
    contract: input.contract,
    universe: input.universe,
    ...(input.cache ? { cache: input.cache } : {}),
  });
  return sealed.status === 'sealed'
    ? { status: 'resolved', members: sealed.seal.members, seal: sealed.seal }
    : sealed;
}


export type ExpectedWorkUniverseAmendmentResult =
  | { status: 'amended'; seal: ExpectedWorkUniverseSeal }
  | { status: 'refused'; reason: string };

/**
 * Correct a source universe's member-id pointer ONCE, against evidence.
 *
 * The contract freezes this pointer before the read that could prove it, so a
 * wrong guess used to kill the turn outright. This is the narrow way back: the
 * pointer alone, once, only while nothing has been bound against the old seal,
 * and only if the corrected pointer actually resolves against the producer's
 * settled records right now. It is not a retry — an amendment that does not
 * seal is refused with the same detail the original refusal carried, so a
 * second guess costs the model nothing it did not already know.
 *
 * The caller owns the IMMEDIATE transaction; the durable row's primary key is
 * what makes "once" true even under concurrent admission.
 */
export function amendSourceUniverseMemberIdPointer(input: {
  db: Database.Database;
  contract: AcceptedTaskWorkContractV1;
  universe: SourceDerivedUniverseV1;
  memberIdPointer: string;
  motivatingRefusal: string;
  cache?: ExpectedWorkUniverseSealCache;
}): ExpectedWorkUniverseAmendmentResult {
  const { db, contract, universe } = input;
  if (!isBoundedJsonPointer(input.memberIdPointer)) {
    return { status: 'refused', reason: 'an amended member id pointer must be a bounded RFC 6901 pointer' };
  }
  const current = effectiveMemberIdPointer(db, contract, universe);
  if (input.memberIdPointer === current) {
    return { status: 'refused', reason: `universe ${universe.id} already identifies members at '${current}'` };
  }
  const existing = db.prepare(`
    SELECT member_id_pointer FROM expected_work_universe_amendments
     WHERE session_id = ? AND source_user_seq = ? AND contract_id = ? AND universe_id = ?
  `).get(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    universe.id,
  ) as { member_id_pointer: string } | undefined;
  if (existing) {
    return {
      status: 'refused',
      reason: `universe ${universe.id} has already used its one member-id correction ('${existing.member_id_pointer}')`,
    };
  }
  // Nothing may have been bound against the seal this correction replaces.
  const bound = db.prepare(`
    SELECT COUNT(*) AS count FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND contract_id = ? AND universe_id = ?
  `).get(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    universe.id,
  ) as { count: number };
  if (bound.count > 0) {
    return {
      status: 'refused',
      reason: `universe ${universe.id} already has ${bound.count} bound member call(s); its identity cannot change underneath them`,
    };
  }
  // EVIDENCE GATE: the corrected pointer must seal against the producer's
  // settled records right now, or there is nothing to record.
  const candidate = deriveSealWithPointer(db, contract, universe, input.memberIdPointer);
  if (candidate.status !== 'sealed') {
    return { status: 'refused', reason: candidate.reason };
  }
  const mirror = insertInternalEventInTransaction(db, {
    sessionId: contract.identity.sessionId,
    turn: contract.identity.turn,
    role: 'system',
    type: EXPECTED_WORK_UNIVERSE_AMENDED_EVENT,
    data: {
      sourceUserSeq: contract.identity.sourceUserSeq,
      contractId: contract.contractId,
      universeId: universe.id,
      priorMemberIdPointer: current,
      memberIdPointer: input.memberIdPointer,
      motivatingRefusal: input.motivatingRefusal.replace(/\s+/g, ' ').trim().slice(0, 300),
      sealedMemberCount: candidate.seal.members.length,
    },
  });
  db.prepare(`
    INSERT INTO expected_work_universe_amendments
      (session_id, source_user_seq, contract_id, universe_id,
       prior_member_id_pointer, member_id_pointer, motivating_refusal,
       sealed_member_count, amended_at, amendment_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
    contract.contractId,
    universe.id,
    current,
    input.memberIdPointer,
    input.motivatingRefusal.replace(/\s+/g, ' ').trim().slice(0, 300),
    candidate.seal.members.length,
    mirror.createdAt,
    mirror.id,
  );
  // The seal this universe reports has changed; no reader may serve the old one.
  input.cache?.delete(`${contract.contractId}\0${universe.id}`);
  return { status: 'amended', seal: candidate.seal };
}
