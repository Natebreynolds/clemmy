/**
 * The advertised tool wire: which enabled tools put a schema on the next model
 * request, and the exact projection each one is sent as.
 *
 * The host runner advertises through these functions and the prompt meter
 * measures through them, so the reading and the request cannot disagree about
 * which tools were sent or how large their schemas were.
 */
import { compactAdvertisedJsonSchema } from '../schema-normalizer.js';

export interface AdvertisableTool {
  type?: string;
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
  deferLoading?: boolean;
  providerData?: Record<string, unknown>;
}

/** Schema on demand: a tool marked deferLoading stays enabled and callable
 *  (directly or carried through call_tool) but its schema rides the prefix
 *  only when the model has no search/call doors to fetch it with. */
export function toolsOnAdvertisedWire<T extends { name: string; deferLoading?: unknown }>(
  enabled: readonly T[],
): T[] {
  const acquisitionDoors = enabled.some((tool) => tool.name === 'tool_search')
    && enabled.some((tool) => tool.name === 'call_tool');
  return acquisitionDoors
    ? enabled.filter((tool) => tool.deferLoading !== true)
    : [...enabled];
}

/** The model sees the compact projection; the tool's own zod schema still
 *  parses every call, so nothing accepted or refused changes. */
export function serializeAdvertisedTools(tools: readonly AdvertisableTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: compactAdvertisedJsonSchema(tool.parameters ?? { type: 'object', properties: {} }),
    strict: tool.strict === true,
    ...(tool.deferLoading === true ? { deferLoading: true } : {}),
    ...(tool.providerData ? { providerData: tool.providerData } : {}),
  }));
}

/** Agents whose tools block keeps session-wide wire positions: the ordinary
 *  host chat turns the round-one desk governs (agents/turn-desk.ts). Every
 *  other agent keeps per-source first-seen order only. */
const sessionOrderedAgents = new WeakSet<object>();

export function bindSessionWireOrder(agent: object): void {
  sessionOrderedAgents.add(agent);
}

export function usesSessionWireOrder(agent: unknown): boolean {
  return Boolean(agent) && typeof agent === 'object' && sessionOrderedAgents.has(agent as object);
}
