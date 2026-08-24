import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import { stripMcpToolCarrier } from '../runtime/mcp-tool-authority.js';
import { searchComposioBrokerCandidates } from './composio-tools.js';
import { searchCapabilityOperations } from '../memory/capability-index.js';
import { listConnectedToolkits } from '../integrations/composio/client.js';
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import {
  recordAdmissionCapabilityResolution,
  type CapabilityResolutionEntry,
} from '../runtime/harness/capability-resolution.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import type {
  ToolSearchCandidateSource,
  ToolSearchBrokerCandidate,
  ToolSearchPlanningDisclosureCandidate,
} from './tool-search-tool.js';

function boundedRank(index: number, count: number): number {
  return Math.max(0, 1 - (index / Math.max(1, count)));
}

/**
 * Deposit identity/schema facts for only the provider candidates the visible
 * tool_search result actually returned. This is intentionally staging, not
 * catalog publication: plan_task is the one foreground-loop boundary that
 * may install the model-selected manifests and freeze execution authority.
 */
export async function stageDisclosedPlanningProviderCandidates(input: {
  sessionId: string;
  sourceUserSeq: number;
  candidates: readonly ToolSearchPlanningDisclosureCandidate[];
}): Promise<void> {
  const accepted = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText.trim() : '';
  const eventText = typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '';
  const acceptedText = display || eventText;
  if (!acceptedText) return;
  const connections = await listConnectedToolkits({ requireFresh: true });
  const byToolkit = new Map<string, typeof connections>();
  for (const connection of connections) {
    const current = byToolkit.get(connection.slug.trim().toLowerCase()) ?? [];
    current.push(connection);
    byToolkit.set(connection.slug.trim().toLowerCase(), current);
  }
  const entries = new Map<string, CapabilityResolutionEntry>();
  // A task may resolve source and destination in separate foreground searches.
  // Keep the newest accepted-task resolution cumulative so the existing
  // proof publisher can materialize the model-selected subset at plan time.
  for (const event of listEvents(input.sessionId, { types: ['capability_resolution'] })) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq || event.data.authoritativeForTask === false) continue;
    const prior = Array.isArray(event.data.entries)
      ? event.data.entries as CapabilityResolutionEntry[]
      : [];
    for (const entry of prior) {
      if (
        entry.kind !== 'composio'
        || entry.status !== 'proven'
        || entry.connection === 'missing'
        || !entry.identifier?.trim()
      ) continue;
      entries.set(`composio:${entry.identifier.trim().toLowerCase()}`, { ...entry });
    }
  }
  for (const candidate of input.candidates.slice(0, 20)) {
    if (
      candidate.sourceKind !== 'authorized_composio'
      || candidate.carrier !== 'work_call'
      || !candidate.name.trim()
      || !candidate.schema
      || typeof candidate.schema !== 'object'
      || Array.isArray(candidate.schema)
    ) continue;
    const slug = candidate.name.trim();
    const toolkit = registeredToolkitOfSlug(slug).trim().toLowerCase();
    const matches = byToolkit.get(toolkit) ?? [];
    // Account ambiguity is an input question, never a reason to mint a
    // provider-default manifest behind the model's back.
    if (matches.length !== 1) continue;
    const effectClass = classifyComposioSlugEffect(slug) === 'read' ? 'read' : 'write';
    entries.set(`composio:${slug}`, {
      intent: 'foreground tool_search disclosed this exact live operation',
      kind: 'composio',
      identifier: slug,
      status: 'proven',
      connection: 'active',
      accountIdentity: matches[0]!.connectionId,
      effectClass,
    });
  }
  if (entries.size === 0) return;
  recordAdmissionCapabilityResolution({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedInput: acceptedText,
    entries: [...entries.values()],
  });
}
/**
 * Bind provider adapters to the already-resolved turn scope. The returned
 * sources are lazy: constructing a fresh action does no connector I/O; only an
 * actual unresolved-role tool_search pays discovery latency. Both adapters
 * return capability context, never execution authority.
 */
export function buildAuthorizedToolSearchCandidateSources(
  scope: McpToolScope,
  planningIdentity?: { sessionId: string; sourceUserSeq: number },
): readonly ToolSearchCandidateSource[] {
  // The identity is consumed by the disclosure/staging callback rather than by
  // candidate search. In particular, its presence must not let an advisory
  // planning index suppress the one bounded live provider search.
  void planningIdentity;
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
      // Memory/index rows are ranking hints, never completeness or liveness
      // proof. Every admitted unresolved role gets exactly one bounded live
      // filtered search; only identifiers present in that response may be
      // returned or acquire a planning ref.
      const indexed = searchCapabilityOperations(query, {
        limit,
        carrierKind: 'composio',
      });
      const indexScore = new Map(indexed.map((hit) => [
        hit.identifier.trim().toLowerCase(),
        hit.score,
      ]));
      const candidates = await searchComposioBrokerCandidates(query, limit);
      return candidates
        .map((candidate, index): ToolSearchBrokerCandidate => ({
          name: candidate.slug,
          summary: candidate.description?.trim()
            || `${candidate.name} (${candidate.toolkit})`,
          schema: candidate.inputParameters,
          carrier: 'work_call',
          // The provider result owns membership. Memory can only nudge the
          // ordering of those exact live rows, never add a missing row.
          score: boundedRank(index, candidates.length)
            + Math.min(0.05, Math.max(0, indexScore.get(candidate.slug.toLowerCase()) ?? 0) * 0.05),
          invocation: {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: candidate.slug },
            payloadField: 'arguments',
          },
          guidance: `Build the action arguments from this exact live schema. Invoke work_call with inner name composio_execute_tool; set tool_slug to ${candidate.slug} and serialize the action arguments into the arguments field.`,
        }))
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.name.localeCompare(right.name))
        .slice(0, Math.max(1, Math.min(limit, 8)));
    },
  };

  return [externalMcp, composio];
}
