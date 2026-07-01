/**
 * Per-tool-call abort context.
 *
 * `withTimeout` (brackets.ts) stops WAITING on a timed-out tool call but does
 * not CANCEL the underlying network request — the HTTP call keeps running and,
 * for a metered provider like Composio/Apify, keeps burning credits after the
 * harness has already moved on (the live 2026-06-24 Apify case). This module
 * carries a per-invocation `AbortSignal` on an AsyncLocalStorage so the layer
 * that actually issues the fetch (integrations/composio/client.ts) can merge it
 * into the request and abort for real when brackets fires the timeout.
 *
 * Deliberately dependency-free (only node:async_hooks) so any tool-execution
 * layer can read the signal without an import cycle back into the harness.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const abortStore = new AsyncLocalStorage<{ signal: AbortSignal }>();

/** Run `fn` with `signal` visible to `currentToolAbortSignal()` across every
 *  await boundary reached from inside it. Returns whatever `fn` returns. */
export function runWithToolAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return abortStore.run({ signal }, fn);
}

/** The abort signal for the tool call currently on the stack, or undefined when
 *  running outside a wrapped invocation (tests, out-of-band calls) — callers
 *  MUST treat undefined as "no cancellation available" and behave exactly as
 *  they do today (fail-open). */
export function currentToolAbortSignal(): AbortSignal | undefined {
  return abortStore.getStore()?.signal;
}
