/**
 * Attested provider transport surface. Invoke/reconcile/observer artifacts
 * call this module after the host binds the exact loaded transport artifact.
 */
export interface AttestedTransportCall {
  operationId: string;
  args: Record<string, unknown>;
  accountId: string;
  /**
   * Optional exact live identity sealed by a generic manifest-backed port.
   * Legacy curated adapters predate this field. Open-ended carriers must send
   * it so the transport can re-list/re-observe immediately before dispatch.
   */
  expected?: {
    providerKind: string;
    providerIdentity: string;
    providerVersion: string;
    operationVersion: string;
    definitionFingerprint: string;
    invokePortId: string;
    argumentCompiler: { id: string; version: string };
  };
}

export interface AttestedTransportObservation {
  operationId: string;
  accountId: string;
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
  observedAt: number;
}

export interface AttestedTransportReconcile {
  artifactId: string;
  accountId: string;
  operationId: string;
}

export interface AttestedTransportReconcileResult {
  exists: boolean;
  artifactId?: string;
  handle?: string;
  contentDigest?: string;
  receipt?: string;
}

export interface AttestedTransport {
  execute: (call: AttestedTransportCall) => Promise<unknown>;
  /**
   * Last observation this transport actually made. Synchronous because the
   * crossing reads it inside a SQLite transaction; it never contacts the
   * provider. `null` means the transport has nothing observed to report, which
   * the host must treat as unavailable rather than as agreement.
   */
  observe: (input: { operationId: string; accountId: string }) => AttestedTransportObservation | null;
  /**
   * Contact the provider and record what it reports. Every real provider read
   * is async, so refreshing cannot happen at crossing time; readiness performs
   * it out of band and the crossing then reads the result with a freshness
   * bound. Keeping it here means the attested artifact remains the only
   * producer of an independent observation.
   */
  refreshObservation?: (
    input: { operationId: string; accountId: string },
  ) => Promise<AttestedTransportObservation | null>;
  reconcile: (input: AttestedTransportReconcile) => Promise<AttestedTransportReconcileResult>;
  digest: string;
}

let bound: AttestedTransport | null = null;

export function bindAttestedTransport(transport: AttestedTransport): void {
  bound = transport;
}

export function peekAttestedTransport(): AttestedTransport | null {
  return bound;
}

export function requireAttestedTransport(): AttestedTransport {
  if (!bound) {
    throw new Error('attested provider transport is not bound');
  }
  return bound;
}
