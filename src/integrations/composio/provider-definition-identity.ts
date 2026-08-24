import { createHash } from 'node:crypto';
import { digestSchema } from '../../tools/tool-contract-store.js';

/** Identity of the exact prepared transport surface. This is deliberately
 * shared by catalog publication, observation, and the shipped transport; a
 * proof-only label must never masquerade as the executable provider surface. */
export const COMPOSIO_PROVIDER_SURFACE_VERSION = 'composio-tool-router-v1';

export interface ComposioProviderDefinitionIdentity {
  operationId: string;
  operationVersion: string;
  accountId: string;
  invokePortId: string;
  inputSchema: Record<string, unknown>;
  /** `undefined` is an unobserved provider output definition and can never
   * mint executable identity. `null` is an explicit provider-owned absence. */
  outputSchema: Record<string, unknown> | null | undefined;
}

function boundedIdentity(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
}

/** Full definition identity for one prepared Composio business POST. The
 * input and result-payload schemas are independently retained for validation,
 * while this digest closes them together with version, account, and invoke
 * port so none can drift under an otherwise-stable operation slug. */
export function fingerprintComposioProviderDefinition(
  input: ComposioProviderDefinitionIdentity,
): string | null {
  const operationId = boundedIdentity(input.operationId);
  const operationVersion = boundedIdentity(input.operationVersion);
  const accountId = boundedIdentity(input.accountId);
  const invokePortId = boundedIdentity(input.invokePortId);
  if (!operationId || !operationVersion || !accountId || !invokePortId) return null;
  if (!input.inputSchema || typeof input.inputSchema !== 'object' || Array.isArray(input.inputSchema)) {
    return null;
  }
  if (input.outputSchema === undefined) return null;
  if (input.outputSchema !== null && (
    !input.outputSchema
    || typeof input.outputSchema !== 'object'
    || Array.isArray(input.outputSchema)
  )) return null;
  return createHash('sha256').update(JSON.stringify({
    domain: 'composio-prepared-provider-definition',
    version: 1,
    providerIdentity: 'composio',
    providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationId,
    operationVersion,
    accountId,
    invokePortId,
    providerInputSchemaDigest: digestSchema(input.inputSchema),
    providerOutputSchemaDigest: input.outputSchema
      ? digestSchema(input.outputSchema)
      : null,
  }), 'utf8').digest('hex');
}
