/**
 * The production attested provider transport, over the ONE Composio gateway.
 *
 * Until now nothing bound an attested transport outside tests, so the typed
 * lane's `productionProviderCrossingAllowed()` was permanently false on a
 * live home: proof-provisioned capabilities never registered, every admitted
 * act construct compiled zero operationIds, and dispatch fell through to the
 * vendor pipe (live 2026-08-19 sess-mszlpidc — admitted collect_then_construct
 * turned into a refused tool_search and a maxTurns:1 park; 0 artifacts).
 *
 * The transport is deliberately thin:
 *  - `execute` resolves through `resolveComposioDispatch` — the SAME gateway
 *    resolution every lane pays (route prohibitions, account/owner identity,
 *    schema-grounded arg validation + deterministic repairs, irreversible-send
 *    validation) — then performs the raw provider call. It does NOT open its
 *    own logical call or settle anything: the typed executor's crossing kernel
 *    (fenced reservation → receipt → settlement) owns that bookkeeping, and a
 *    second writer here would double-account the crossing.
 *  - `observe` reports the frozen schema identity for the operation — the same
 *    digest the proof-provisioned manifest froze — so catalog readiness can
 *    verify identity without a paid call.
 *  - `reconcile` is conservative: an unproven recovery probe reports
 *    not-found, which fails toward admission, never toward a second invoke.
 */
import { createHash } from 'node:crypto';
import {
  bindAttestedTransport,
  peekAttestedTransport,
  type AttestedTransport,
} from './implementation-artifacts/attested-transport.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Exported for pins: the transport itself, without binding it. */
export function buildComposioAttestedTransport(): AttestedTransport {
  const transport: AttestedTransport = {
    digest: 'composio-gateway-transport-v1',
    async execute({ operationId, args }) {
      // Deferred import: this module is reached from typed-runtime boot, and
      // the composio toolset imports broadly across the harness.
      const { resolveComposioDispatch } = await import('../../tools/composio-tools.js');
      const { executeComposioTool } = await import('../../integrations/composio/client.js');
      const resolved = await resolveComposioDispatch(operationId, { ...args }, undefined, {});
      if (!resolved.ok) {
        throw new Error(`${operationId} refused pre-dispatch (${resolved.reason}): ${resolved.message}`);
      }
      return executeComposioTool(operationId, resolved.args, resolved.connectionId, resolved.identity);
    },
    observe({ operationId, accountId }) {
      const schema = getCachedToolSchema(operationId);
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
      return {
        operationId,
        accountId,
        definitionFingerprint: sha256(JSON.stringify(schema)),
        providerVersion: 'composio-proof-v1',
        operationVersion: '1',
        observedAt: Date.now(),
      };
    },
    async reconcile() {
      return { exists: false };
    },
  };
  return transport;
}

export function bindComposioAttestedTransportOnce(): boolean {
  if (peekAttestedTransport()) return false;
  // Isolated tests own their transports (bindAttestedTransport /
  // installProductionTransport); the attested slot outranks the test seam in
  // executeSealed, so auto-binding here would hijack every stubbed fixture.
  if (isolatedTestContractActive()) return false;
  bindAttestedTransport(buildComposioAttestedTransport());
  return true;
}
