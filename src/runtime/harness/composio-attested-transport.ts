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
import {
  bindAttestedTransport,
  peekAttestedTransport,
  type AttestedTransport,
} from './implementation-artifacts/attested-transport.js';
import {
  getCachedToolSchema,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
} from '../../tools/composio-schema-cache.js';
import {
  COMPOSIO_PROVIDER_SURFACE_VERSION,
  fingerprintComposioProviderDefinition,
} from '../../integrations/composio/provider-definition-identity.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';

/** Exported for pins: the transport itself, without binding it. */
export function buildComposioAttestedTransport(): AttestedTransport {
  const transport: AttestedTransport = {
    digest: 'composio-gateway-transport-v1',
    async execute({ operationId, args }) {
      // Deferred import: this module is reached from typed-runtime boot, and
      // the composio toolset imports broadly across the harness.
      const { resolveComposioDispatch } = await import('../../tools/composio-tools.js');
      const { executePreparedComposioTool } = await import('../../integrations/composio/client.js');
      const resolved = await resolveComposioDispatch(operationId, { ...args }, undefined, {
        preparedExecution: true,
      });
      if (!resolved.ok) {
        throw new Error(`${operationId} refused pre-dispatch (${resolved.reason}): ${resolved.message}`);
      }
      if (!resolved.preparedDispatch) {
        throw new Error(`${operationId} refused pre-dispatch: terminal one-shot preparation is absent`);
      }
      return executePreparedComposioTool(resolved.preparedDispatch);
    },
    observe({ operationId, accountId }) {
      const schema = getCachedToolSchema(operationId);
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
      const operationVersion = liveComposioOperationVersion(operationId);
      const outputSchema = liveComposioOutputSchema(operationId);
      if (!operationVersion || outputSchema === undefined) return null;
      const invokePortId = `port:cap:resolved:${operationId.toLowerCase()}:${operationId}`;
      const definitionFingerprint = fingerprintComposioProviderDefinition({
        operationId,
        operationVersion,
        accountId,
        invokePortId,
        inputSchema: schema,
        outputSchema,
      });
      if (!definitionFingerprint) return null;
      return {
        operationId,
        accountId,
        definitionFingerprint,
        providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
        operationVersion,
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
