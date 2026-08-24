import { AsyncLocalStorage } from 'node:async_hooks';
import type { AttemptSignals } from './attempt-outcome.js';

export interface HostToolInvocationObservation {
  resultPresent: boolean;
  result?: unknown;
  thrownPresent: boolean;
  thrown?: unknown;
  signals: AttemptSignals;
  businessCall?: boolean;
  mutating?: boolean;
  /** The exact configured adapter claimed that it owns a later provider-final
   * physical row. A non-refusal settlement must therefore observe that row;
   * silently falling back to host-local execution would erase provider truth. */
  terminalPhysicalDispatchRequired?: boolean;
}

export interface HostToolInvocationPhysicalDispatchRequest {
  toolName: string;
  args?: unknown;
}

export type HostToolInvocationPhysicalDispatchOutcome = 'returned' | 'threw';

export interface HostToolInvocationPhysicalDispatchCallbacks {
  reserve: (request: HostToolInvocationPhysicalDispatchRequest) => void;
  settle: (outcome: HostToolInvocationPhysicalDispatchOutcome) => void;
}

interface MutableObservation extends HostToolInvocationObservation {
  physicalDispatch?: HostToolInvocationPhysicalDispatchCallbacks;
}

const storage = new AsyncLocalStorage<MutableObservation>();

/** One exact observation channel shared by a host call and any nested wrapper.
 * It carries nominal result/error facts without teaching the host provider
 * names or opening a second settlement path. */
export function runWithHostToolInvocationObservation<T>(
  work: () => T,
  physicalDispatch?: HostToolInvocationPhysicalDispatchCallbacks,
): T {
  return storage.run({
    resultPresent: false,
    thrownPresent: false,
    signals: {},
    ...(physicalDispatch ? { physicalDispatch } : {}),
  }, work);
}

/** Reserve the one host-owned physical attempt at a nested lane's final
 * pre-body edge. Absence means the enclosing host boundary owns its own direct
 * reservation. A callback either commits the exact child-lease row or throws;
 * callers must never enter the body after a thrown admission. */
export function reserveHostToolInvocationPhysicalDispatch(
  request: HostToolInvocationPhysicalDispatchRequest,
): boolean {
  const callback = storage.getStore()?.physicalDispatch;
  if (!callback) return false;
  callback.reserve(request);
  return true;
}

/** Close a row reserved through the matching nested invocation context before
 * that lane commits its logical settlement. The boolean lets ordinary direct
 * wrappers remain byte-for-byte no-ops when no nested host callback exists. */
export function settleHostToolInvocationPhysicalDispatch(
  outcome: HostToolInvocationPhysicalDispatchOutcome,
): boolean {
  const callback = storage.getStore()?.physicalDispatch;
  if (!callback) return false;
  callback.settle(outcome);
  return true;
}

/** Mark the active host invocation as requiring an adapter-owned provider row.
 * Only the opaque terminal-owner path in brackets calls this; public tool
 * shape/name metadata cannot set it. */
export function requireHostToolInvocationTerminalPhysicalDispatch(): boolean {
  const current = storage.getStore();
  if (!current) return false;
  current.terminalPhysicalDispatchRequired = true;
  return true;
}

export function noteHostToolInvocationObservation(input: {
  result?: unknown;
  resultPresent?: boolean;
  thrown?: unknown;
  thrownPresent?: boolean;
  signals?: AttemptSignals;
  businessCall?: boolean;
  mutating?: boolean;
}): void {
  const current = storage.getStore();
  if (!current) return;
  if (input.resultPresent === true) {
    current.resultPresent = true;
    current.result = input.result;
  }
  if (input.thrownPresent === true) {
    current.thrownPresent = true;
    current.thrown = input.thrown;
  }
  if (input.signals) current.signals = { ...current.signals, ...input.signals };
  if (input.businessCall !== undefined) current.businessCall = input.businessCall;
  if (input.mutating !== undefined) current.mutating = input.mutating;
}

export function currentHostToolInvocationObservation(): HostToolInvocationObservation | undefined {
  const current = storage.getStore();
  return current ? {
    resultPresent: current.resultPresent,
    ...(current.resultPresent ? { result: current.result } : {}),
    thrownPresent: current.thrownPresent,
    ...(current.thrownPresent ? { thrown: current.thrown } : {}),
    signals: { ...current.signals },
    ...(current.businessCall === undefined ? {} : { businessCall: current.businessCall }),
    ...(current.mutating === undefined ? {} : { mutating: current.mutating }),
    ...(current.terminalPhysicalDispatchRequired === undefined
      ? {}
      : { terminalPhysicalDispatchRequired: current.terminalPhysicalDispatchRequired }),
  } : undefined;
}
