/**
 * One value-opaque contract for logical-call admission and settlement.
 *
 * Raw arguments never enter the authority tables.  The accepted-task id salts
 * the digest so the same provider payload in two user tasks cannot be mistaken
 * for shared authority.
 */
import { createHash } from 'node:crypto';
import { callableContractIdentity, normalizeCallableArguments } from './callable-contract.js';
import {
  canonicalRuntimeEffectiveToolName,
  unwrapRuntimeEffectiveToolIdentity,
} from './tool-effect.js';
import { isTrustedComposioGateway } from './runtime-tool-identity.js';

export interface DurableLogicalCallContract {
  toolName: string;
  argumentDigest: string;
}

export function canonicalLogicalToolName(tool: string): string | null {
  // Callable contracts are case-folded. Keep the durable row on that same
  // canonical alphabet so an upper-case provider slug cannot make all carrier
  // parity assertions pass vacuously as `null === null`.
  return canonicalRuntimeEffectiveToolName(tool)?.toLowerCase() ?? null;
}

export function durableLogicalCallContract(
  acceptedTaskId: string,
  tool: string,
  args: unknown,
): DurableLogicalCallContract | null {
  const effective = unwrapRuntimeEffectiveToolIdentity(tool, args);
  const toolName = canonicalLogicalToolName(effective.toolName ?? '');
  if (!toolName || !acceptedTaskId.trim()) return null;
  // Only the trusted Composio gateway owns a provider-carrier payload. Its
  // `{tool_slug, arguments}` pair is peeled to the same inner contract used at
  // the paid dispatch. Every other effective tool keeps a discriminated direct
  // contract, so ordinary business data containing fields named `tool_slug`,
  // `arguments`, `name`, or `method` can never rename its trusted caller.
  const contract = isTrustedComposioGateway(tool)
    ? normalizeCallableArguments(effective.args, toolName)
    : normalizeCallableArguments({ kind: 'direct', toolName, args: effective.args });
  if (contract.error || contract.toolName !== toolName) return null;
  return {
    toolName,
    argumentDigest: createHash('sha256')
      .update(`${acceptedTaskId}\0${callableContractIdentity(contract)}`)
      .digest('hex'),
  };
}
