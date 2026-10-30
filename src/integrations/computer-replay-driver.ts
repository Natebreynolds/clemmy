/**
 * Replay's hands: each recipe step asks Clem's own computer driver over its
 * command line on Clem's private socket, the same way the chat's live view
 * reads the screen. No turn and no model are involved.
 */
import type { ComputerDriverCall } from '../runtime/computer-recipe.js';
import { askDriver, computerDriverEnv, computerDriverPath, computerDriverSocketPath, realComputerDriverPath } from './computer-driver.js';

/** The driver's command line prints the tool's structured result as JSON;
 *  anything else is the driver refusing or failing, in its own words. */
export function driverCliResult(output: string | null): unknown {
  if (output === null) return { result: { isError: true, content: [{ type: 'text', text: 'The computer driver did not answer.' }] } };
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { result: { isError: false, structuredContent: parsed } };
  } catch { /* the driver's own words follow */ }
  return { result: { isError: true, content: [{ type: 'text', text: output.slice(0, 500) }] } };
}

/** A caller for replay, or null when the computer is not turned on for Clem. */
export function computerDriverCaller(timeoutMs = 30_000): ComputerDriverCall | null {
  const binary = computerDriverPath();
  if (!binary) return null;
  const real = realComputerDriverPath(binary);
  return async (tool, args) => driverCliResult(await askDriver(real,
    ['call', tool, JSON.stringify(args), '--socket', computerDriverSocketPath()], timeoutMs, computerDriverEnv()));
}
