import { getRuntimeEnv } from '../../config.js';

/**
 * Temporary cutover selector for the Clem-owned interactive turn engine.
 *
 * Production host_v1 owns only fresh interactive chat. Workflow, execution,
 * and background owners retain their existing runners. `legacy_sdk` is a
 * persisted-state compatibility identity only: a fresh interactive turn must
 * never enter that owner, while persisted state always resumes through the
 * engine that wrote it.
 */
export const TURN_ENGINE_ENV_KEY = 'CLEMMY_TURN_ENGINE';

export type HostTurnEngineMode = 'host_v1' | 'host_v1_read_only';
export type TurnEngineMode = 'legacy_sdk' | HostTurnEngineMode;
export type PersistedTurnEngineState = 'none' | 'host' | HostTurnEngineMode | 'legacy_sdk';
export const DEFAULT_TURN_ENGINE: TurnEngineMode = 'host_v1';

export interface TurnEngineSelectionInput {
  sessionKind: string;
  persistedState?: PersistedTurnEngineState;
  /** Pure-test seam. Live callers omit this and read TURN_ENGINE_ENV_KEY. */
  configuredValue?: string;
}

export class InvalidFreshTurnEngineError extends Error {
  readonly configuredValue: string;

  constructor(raw: string) {
    const configuredValue = raw.trim();
    super(`Unsupported fresh interactive turn engine: ${configuredValue || '(empty)'}`);
    this.name = 'InvalidFreshTurnEngineError';
    this.configuredValue = configuredValue;
  }
}

export function configuredTurnEngineMode(raw: string): HostTurnEngineMode {
  const value = raw.trim().toLowerCase();
  if (value === 'host_v1' || value === 'host_v1_read_only') return value;
  throw new InvalidFreshTurnEngineError(raw);
}

export function isHostTurnEngine(mode: TurnEngineMode): mode is HostTurnEngineMode {
  return mode === 'host_v1' || mode === 'host_v1_read_only';
}

export function selectTurnEngine(input: TurnEngineSelectionInput): TurnEngineMode {
  const persistedState = input.persistedState ?? 'none';

  // A paused turn must resume through the engine that serialized it. This is
  // independent of the current flag so toggling the canary cannot reinterpret
  // an opaque SDK RunState or strand a HostInterruptState.
  if (persistedState === 'host') return 'host_v1_read_only';
  if (persistedState === 'host_v1' || persistedState === 'host_v1_read_only') return persistedState;
  if (persistedState === 'legacy_sdk') return 'legacy_sdk';

  if (input.sessionKind !== 'chat') return 'legacy_sdk';
  return configuredTurnEngineMode(
    input.configuredValue
      ?? getRuntimeEnv(TURN_ENGINE_ENV_KEY, DEFAULT_TURN_ENGINE)
      ?? DEFAULT_TURN_ENGINE,
  );
}
