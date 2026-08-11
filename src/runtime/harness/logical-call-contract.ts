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

function readableContract(
  tool: string,
  args: unknown,
): { toolName: string; contract: ReturnType<typeof normalizeCallableArguments> } | null {
  const effective = unwrapRuntimeEffectiveToolIdentity(tool, args);
  const toolName = canonicalLogicalToolName(effective.toolName ?? '');
  if (!toolName) return null;
  // Only the trusted Composio gateway owns a provider-carrier payload. Its
  // `{tool_slug, arguments}` pair is peeled to the same inner contract used at
  // the paid dispatch. Every other effective tool keeps a discriminated direct
  // contract, so ordinary business data containing fields named `tool_slug`,
  // `arguments`, `name`, or `method` can never rename its trusted caller.
  const contract = isTrustedComposioGateway(tool)
    ? normalizeCallableArguments(effective.args, toolName)
    : normalizeCallableArguments({ kind: 'direct', toolName, args: effective.args });
  if (contract.error || contract.toolName !== toolName) return null;
  return { toolName, contract };
}

/**
 * Whether these exact bytes can become a durable contract at all.
 *
 * Admission REQUIRES a contract, and refusing one poisons the accepted task's
 * resolution — so an invocation whose arguments cannot be read (truncated JSON,
 * a carrier whose inner `arguments` payload is malformed) must be bound to a
 * host-owned outer identity rather than take the whole turn down with it.
 */
export function logicalCallArgumentsAreContractible(tool: string, args: unknown): boolean {
  return readableContract(tool, args) !== null;
}

export function durableLogicalCallContract(
  acceptedTaskId: string,
  tool: string,
  args: unknown,
): DurableLogicalCallContract | null {
  if (!acceptedTaskId.trim()) return null;
  const readable = readableContract(tool, args);
  if (!readable) return null;
  return {
    toolName: readable.toolName,
    argumentDigest: createHash('sha256')
      .update(`${acceptedTaskId}\0${callableContractIdentity(readable.contract)}`)
      .digest('hex'),
  };
}
