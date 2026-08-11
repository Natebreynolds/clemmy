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
import {
  EXPECTED_WORK_MAX_UNIVERSE_MEMBERS,
  canonicalExpectedWorkJson,
  expectedWorkDigest,
  resolveJsonPointer,
  type AcceptedTaskWorkContractV1,
  type ExpectedWorkUniverseV1,
} from './expected-work-contract.js';
import { providerEnvelopeHasContradiction } from './provider-read-evidence.js';
import { recordsAtRecordPath } from './result-facts.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';

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

function memberIdOf(
  record: unknown,
  pointer: string,
  index: number,
): { ok: true; id: string } | { ok: false; reason: string } {
  const resolved = resolveJsonPointer(record, pointer);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `source record ${index} has no value at member id pointer '${pointer}'`,
    };
  }
  const value = resolved.value;
  if (typeof value !== 'string' || value.length < 1 || value.length > MEMBER_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: `source record ${index} has no bounded string member id at pointer '${pointer}'`,
    };
  }
  return { ok: true, id: value };
}

function deriveSeal(
  db: Database.Database,
  contract: AcceptedTaskWorkContractV1,
  universe: SourceDerivedUniverseV1,
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
  if (
    redeemed.value.handle.completeness !== 'complete'
    || redeemed.value.handle.continuationRef !== null
    || redeemed.value.handle.continuationRepeated !== false
    || providerEnvelopeHasContradiction(redeemed.value.rawPayload)
  ) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} does not prove it exhausted its collection`,
    };
  }

  const records = recordsAtRecordPath(redeemed.value.rawPayload, redeemed.value.handle.recordPath);
  if (!records) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} exposes no record collection to seal`,
    };
  }
  if (records.length !== redeemed.value.handle.recordCount) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} disagrees with its durable record count`,
    };
  }
  if (records.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS) {
    return {
      status: 'unsealed',
      reason: `the settled source read ${universe.producedBy} returned more than ${EXPECTED_WORK_MAX_UNIVERSE_MEMBERS} members`,
    };
  }

  const members: string[] = [];
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    const member = memberIdOf(record, universe.memberIdPointer, index);
    if (!member.ok) return { status: 'unsealed', reason: member.reason };
    if (seen.has(member.id)) {
      return {
        status: 'unsealed',
        reason: `source records repeat member id '${member.id}' at pointer '${universe.memberIdPointer}'`,
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
    result = deriveSeal(input.db, input.contract, input.universe);
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
