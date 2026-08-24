import { createHash } from 'node:crypto';

export type SettlementCrossingAuthorityVersion = 1 | 2;

export type SettlementCrossingTerminalState =
  | 'started'
  | 'returned'
  | 'threw'
  | 'timed_out'
  | 'cancelled'
  | 'unknown';

export interface SettlementCrossingAuthorityEntry {
  physicalDispatchId: string;
  ordinal: number;
  relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
  retryOf?: string | null;
  toolName: string;
  argumentDigest: string;
  terminalState?: SettlementCrossingTerminalState | null;
  executionSite?: 'host' | null;
}

/**
 * One canonical byte projection for immutable logical-settlement crossings.
 *
 * V1 is retained only for already-durable settlements. V2 additionally freezes
 * whether each crossing returned/threw/stopped and whether it ran on the host
 * or beyond the provider boundary. Writers and every redemption/proof verifier
 * must use this function so a schema evolution cannot silently fork authority.
 */
export function settlementCrossingAuthorityProjection(
  crossings: readonly SettlementCrossingAuthorityEntry[],
  version: SettlementCrossingAuthorityVersion,
): Array<Record<string, unknown>> {
  return crossings.map((crossing) => ({
    physicalDispatchId: crossing.physicalDispatchId,
    ordinal: crossing.ordinal,
    relation: crossing.relation,
    retryOf: crossing.retryOf ?? null,
    toolName: crossing.toolName,
    argumentDigest: crossing.argumentDigest,
    ...(version === 2 ? {
      terminalState: crossing.terminalState ?? null,
      executionSite: crossing.executionSite ?? null,
    } : {}),
  }));
}

export function settlementCrossingAuthorityJson(
  crossings: readonly SettlementCrossingAuthorityEntry[],
  version: SettlementCrossingAuthorityVersion,
): string {
  return JSON.stringify(settlementCrossingAuthorityProjection(crossings, version));
}

export function settlementCrossingAuthorityDigest(
  crossings: readonly SettlementCrossingAuthorityEntry[],
  version: SettlementCrossingAuthorityVersion,
): string {
  return createHash('sha256')
    .update(settlementCrossingAuthorityJson(crossings, version))
    .digest('hex');
}
