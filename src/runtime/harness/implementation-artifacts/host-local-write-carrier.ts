/**
 * Host-owned storage carrier seam for reviewed local mutations.
 *
 * Some reviewed Clementine-local writes need the host's durable storage
 * (SQLite + data.json) rather than the file-system-only transport leaf. The
 * shipped invoke/reconcile artifacts never import that storage graph: doing so
 * bundles a second event-log/database module instance into a digest-addressed
 * artifact and drags native bindings into a packaged extract that has no
 * node_modules. Instead the host binds its carrier here — into the shipped
 * artifacts at load (beside `bindAttestedTransport`) and into its own module
 * instance at evaluation — and the artifact calls whatever is bound.
 *
 * This module must stay import-free (types only) so it is a leaf in every
 * bundle that contains it.
 */
import type {
  AttestedTransportCall,
  AttestedTransportReconcile,
  AttestedTransportReconcileResult,
} from './attested-transport.js';

export interface HostLocalWriteReconcileInput extends AttestedTransportReconcile {
  /** The sealed manifest expectation of the port probing the artifact. */
  expected: NonNullable<AttestedTransportCall['expected']>;
}

/** One host storage adapter for a reviewed local operation. */
export interface HostLocalWriteStorageAdapter {
  execute: (call: AttestedTransportCall) => Promise<unknown>;
  reconcile: (input: HostLocalWriteReconcileInput) => Promise<AttestedTransportReconcileResult>;
}

export interface HostLocalWriteCarrier {
  /**
   * The host storage adapter that owns this exact reviewed operation, or null
   * when the attested transport leaf executes it itself. Selection is by
   * registry execution contract on the host side; the artifact interprets no
   * local tool name.
   */
  select: (input: { operationId: string; accountId: string }) => HostLocalWriteStorageAdapter | null;
}

let bound: HostLocalWriteCarrier | null = null;

export function bindHostLocalWriteCarrier(carrier: HostLocalWriteCarrier | null): void {
  bound = carrier;
}

export function peekHostLocalWriteCarrier(): HostLocalWriteCarrier | null {
  return bound;
}

/**
 * A carrier that resolves through `peek` on every call. The shipped artifacts
 * are separate module instances from the host; the loader binds this
 * forwarder so a carrier the host binds (or rebinds) later is still the one
 * the artifact reaches.
 */
export function forwardingHostLocalWriteCarrier(
  peek: () => HostLocalWriteCarrier | null,
): HostLocalWriteCarrier {
  return Object.freeze({
    select: (input: { operationId: string; accountId: string }) => peek()?.select(input) ?? null,
  });
}
