import { loadExpectedWorkContract } from './expected-work-contract.js';
import { loadSealedNodeBinding } from './host-capability-catalog-factory.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { unwrapRuntimeEffectiveToolIdentity, type OffSurfaceDirectCarry } from './tool-effect.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';

/** Carrier spelling is not plan authority. Reuse the sole exact selected native
 * write, never choose among requirements by order, prose, model or provider. The
 * existing work_call boundary still checks dependencies, arguments and consent. */
export function plannedNativeDirectCarry(input: {
  sessionId: string; sourceUserSeq: number; authoredName: string;
  authoredArgs: Record<string, unknown> | null; authoredArgumentsJson: string;
}): OffSurfaceDirectCarry | null {
  // An explicit work_call already owns its requirement. A generic call_tool
  // spelling can reuse the same unique selection as the direct native name.
  if (isPlainOrClementineLocalTool(input.authoredName, 'work_call')) return null;
  const effective = unwrapRuntimeEffectiveToolIdentity(input.authoredName, input.authoredArgs);
  const name = effective.toolName;
  if (!name || (!isPlainOrClementineLocalTool(input.authoredName, name)
    && !isPlainOrClementineLocalTool(input.authoredName, 'call_tool'))) return null;
  if (typeof input.authoredArgs?.name === 'string'
    && isPlainOrClementineLocalTool(input.authoredArgs.name, 'work_call')) return null;
  const args = effective.args;
  const declarations = TOOL_REGISTRY.filter(row => row.name === name);
  if (declarations.length !== 1 || declarations[0]!.sideEffect !== 'write' || !declarations[0]!.localPlanning
    || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (loaded.status !== 'ok') return null;
  const matches = loaded.contract.operations.filter(operation => {
    if (operation.effect !== 'local_write') return false;
    const selected = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, operation.id);
    return selected?.effect === 'local_write' && selected.logicalToolName === name;
  });
  if (matches.length !== 1 || matches[0]!.cardinality.kind !== 'once') return null;
  return { carrierName: 'work_call', carrierArgs: { requirement_id: matches[0]!.id,
    name, args_json: JSON.stringify(args) } };
}
