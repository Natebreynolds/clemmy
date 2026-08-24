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

export interface DurableLogicalCallContract {
  toolName: string;
  argumentDigest: string;
}

/**
 * Reconstructable, normalized material for a call whose execution may need to
 * be settled after a process restart. The arguments are the same value-opaque
 * canonical object used by the logical digest; callers must seal them before
 * persistence. Keeping this derivation beside admission prevents recovery from
 * rediscovering wrapper/provider semantics from a current registry.
 */
export interface DurableLogicalCallRecoveryMaterial extends DurableLogicalCallContract {
  args: Record<string, unknown>;
}

export function canonicalLogicalToolName(tool: string): string | null {
  // Callable contracts are case-folded. Keep the durable row on that same
  // canonical alphabet so an upper-case provider slug cannot make all carrier
  // parity assertions pass vacuously as `null === null`.
  return canonicalRuntimeEffectiveToolName(tool)?.toLowerCase() ?? null;
}

/**
 * A bracket that cannot parse model/provider argument bytes still needs one
 * durable identity for its proven pre-dispatch refusal. Recognize only the
 * closed host marker that brackets constructs after contractibility fails.
 * Additional or changed bytes are ordinary untrusted gateway input and remain
 * uncontractible. The provider continues to receive the original malformed
 * input, so this marker can settle a refusal but can never authorize I/O.
 */
function hostUnreadableArgumentsContract(
  tool: string,
  args: unknown,
): { toolName: string; contract: ReturnType<typeof normalizeCallableArguments> } | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const marker = args as Record<string, unknown>;
  if (
    Object.keys(marker).sort().join('\0') !== 'carrier\0malformed\0version'
    || marker.carrier !== tool
    || marker.malformed !== true
    || marker.version !== 1
  ) return null;
  const toolName = canonicalLogicalToolName(tool);
  if (!toolName) return null;
  const contract = normalizeCallableArguments({
    kind: 'direct',
    toolName,
    args: marker,
  });
  if (contract.error || contract.toolName !== toolName) return null;
  return { toolName, contract };
}

function readableContract(
  tool: string,
  args: unknown,
): { toolName: string; contract: ReturnType<typeof normalizeCallableArguments> } | null {
  const unreadableHostRefusal = hostUnreadableArgumentsContract(tool, args);
  if (unreadableHostRefusal) return unreadableHostRefusal;
  const effective = unwrapRuntimeEffectiveToolIdentity(tool, args);
  const toolName = canonicalLogicalToolName(effective.toolName ?? '');
  if (!toolName) return null;
  // Only the trusted Composio gateway owns a provider-carrier payload. Unwrap
  // has already peeled its `{tool_slug, arguments}` envelope to the exact
  // inner operation + object. From this point every effective call is a
  // discriminated DIRECT contract, so ordinary inner business data containing
  // fields named `tool_slug`, `arguments`, `name`, or `method` can never be
  // mistaken for a second carrier or rename its trusted caller.
  //
  // The carrier flag comes from the UNWRAP, not the outer name: a
  // call_tool/work_call chain that peels down to the gateway carries the same
  // provider payload as a direct gateway call and MUST digest to the same
  // inner contract. Keying on the outer name gave the same call a different
  // digest per carrier, so each trusted layer's admission/refinement saw a
  // "different" contract and poisoned the step (live 2026-08-18
  // FIRECRAWL_SEARCH: raw carrier-as-direct ≠ refined peel ≠ repaired args).
  const contract = normalizeCallableArguments({
    kind: 'direct',
    toolName,
    args: effective.args,
  });
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
  const material = durableLogicalCallRecoveryMaterial(acceptedTaskId, tool, args);
  return material
    ? { toolName: material.toolName, argumentDigest: material.argumentDigest }
    : null;
}

export function durableLogicalCallRecoveryMaterial(
  acceptedTaskId: string,
  tool: string,
  args: unknown,
): DurableLogicalCallRecoveryMaterial | null {
  if (!acceptedTaskId.trim()) return null;
  const readable = readableContract(tool, args);
  if (!readable) return null;
  return {
    toolName: readable.toolName,
    args: readable.contract.args,
    argumentDigest: createHash('sha256')
      .update(JSON.stringify({
        domain: 'logical-contract',
        version: 1,
        acceptedTaskId,
        toolName: readable.toolName,
        contractIdentity: callableContractIdentity(readable.contract),
      }))
      .digest('hex'),
  };
}
