/**
 * Opaque structural ownership for tools whose adapter opens and settles its
 * own physical provider crossing at a later, provider-final edge.
 *
 * This is intentionally process-local authority. A string name, enumerable
 * property, spread copy, or model-authored lookalike cannot claim ownership.
 * Pinning the executable identities also makes post-registration mutation fail
 * closed. Harness wrappers must explicitly copy the attestation to the exact
 * wrapped object they return.
 */
type TerminalPhysicalDispatchOwnerAttestation = Readonly<{
  name: string;
  invoke?: Function;
  execute?: Function;
}>;

const terminalPhysicalDispatchOwners = new WeakMap<
  object,
  TerminalPhysicalDispatchOwnerAttestation
>();

function attestationFor(tool: object): TerminalPhysicalDispatchOwnerAttestation | null {
  const candidate = tool as {
    name?: unknown;
    invoke?: unknown;
    execute?: unknown;
  };
  const invoke = typeof candidate.invoke === 'function' ? candidate.invoke : undefined;
  const execute = typeof candidate.execute === 'function' ? candidate.execute : undefined;
  if (!invoke && !execute) return null;
  return Object.freeze({
    name: typeof candidate.name === 'string' ? candidate.name : '',
    ...(invoke ? { invoke } : {}),
    ...(execute ? { execute } : {}),
  });
}

/** Register the exact configured adapter tool before it enters the harness. */
export function attestTerminalPhysicalDispatchOwner<T extends object>(tool: T): T {
  const attestation = attestationFor(tool);
  if (!attestation) {
    throw new Error('terminal physical-dispatch owner must have an executable body');
  }
  terminalPhysicalDispatchOwners.set(tool, attestation);
  return tool;
}

/** True only while the exact registered object's executable identity is intact. */
export function isTerminalPhysicalDispatchOwner(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const attestation = terminalPhysicalDispatchOwners.get(tool);
  if (!attestation) return false;
  const candidate = tool as {
    name?: unknown;
    invoke?: unknown;
    execute?: unknown;
  };
  return candidate.name === attestation.name
    && candidate.invoke === attestation.invoke
    && candidate.execute === attestation.execute;
}

/** Carry ownership across one trusted harness wrapper construction. */
export function copyTerminalPhysicalDispatchOwnership<T extends object>(
  source: unknown,
  target: T,
): T {
  if (!isTerminalPhysicalDispatchOwner(source)) return target;
  const attestation = attestationFor(target);
  if (!attestation) {
    throw new Error('wrapped terminal physical-dispatch owner lost its executable body');
  }
  terminalPhysicalDispatchOwners.set(target, attestation);
  return target;
}
