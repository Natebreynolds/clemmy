/**
 * Process-local port registry. Tests and the daemon install a port.
 * Absence means this process has not entered the typed path.
 */
import type { TurnSemanticModelPort } from './turn-semantic-model-port.js';

let installed: TurnSemanticModelPort | null = null;

export function installTurnSemanticModelPort(port: TurnSemanticModelPort | null): void {
  installed = port;
}

export function peekTurnSemanticModelPort(): TurnSemanticModelPort | null {
  return installed;
}
