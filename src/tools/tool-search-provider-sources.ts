import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import { stripMcpToolCarrier } from '../runtime/mcp-tool-authority.js';
import { searchComposioBrokerCandidates } from './composio-tools.js';
import type {
  ToolSearchCandidateSource,
  ToolSearchBrokerCandidate,
} from './tool-search-tool.js';

function boundedRank(index: number, count: number): number {
  return Math.max(0, 1 - (index / Math.max(1, count)));
}
/**
 * Bind provider adapters to the already-resolved turn scope. The returned
 * sources are lazy: constructing a fresh action does no connector I/O; only an
 * actual unresolved-role tool_search pays discovery latency. Both adapters
 * return capability context, never execution authority.
 */
export function buildAuthorizedToolSearchCandidateSources(
  scope: McpToolScope,
): readonly ToolSearchCandidateSource[] {
  const externalMcp: ToolSearchCandidateSource = {
    kind: 'authorized_external_mcp',
    async search({ query, limit }) {
      const server = getOrCreateExternalMcpServers({ ...scope, queryText: query });
      const tools = await server.listTools();
      return tools.slice(0, limit).map((tool, index): ToolSearchBrokerCandidate => ({
        name: stripMcpToolCarrier(tool.name),
        summary: typeof tool.description === 'string'
          ? tool.description
          : `Connected external capability ${stripMcpToolCarrier(tool.name)}`,
        ...(tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
        carrier: 'work_call',
        score: boundedRank(index, Math.min(limit, tools.length)),
      }));
    },
  };

  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    async search({ query, limit }) {
      const candidates = await searchComposioBrokerCandidates(query, limit);
      return candidates.map((candidate, index): ToolSearchBrokerCandidate => ({
        name: candidate.slug,
        summary: candidate.description?.trim()
          || `${candidate.name} (${candidate.toolkit})`,
        schema: candidate.inputParameters,
        carrier: 'work_call',
        score: boundedRank(index, candidates.length),
        invocation: {
          name: 'composio_execute_tool',
          fixedArgs: { tool_slug: candidate.slug },
          payloadField: 'arguments',
        },
        guidance: `Build the action arguments from this exact schema. Invoke work_call with inner name composio_execute_tool; set tool_slug to ${candidate.slug} and serialize the action arguments into the arguments field.`,
      }));
    },
  };

  return [externalMcp, composio];
}
