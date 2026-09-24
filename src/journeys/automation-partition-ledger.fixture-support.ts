import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

import * as catalogs from '../runtime/harness/host-capability-catalog-factory.js';
import * as manifestStores from '../runtime/harness/capability-manifest-store.js';
import * as acquisitionRegistry from '../runtime/harness/production-live-read-acquisition-registry.js';
import type { ManagedMcpServer } from '../types.js';

export const PARTITION_RECORD_COUNT = 10_001;
export const PARTITION_PAGE_SIZE = 4_000;
export const PARTITION_PAGE_COUNT = 3;
export const PARTITION_SERVER_NAME = 'generated_partition_source';
export const PARTITION_TOOL_NAME = `${PARTITION_SERVER_NAME}__enumerate_partition_scope`;

export interface GeneratedPartitionCarrier {
  acquisition: ReturnType<typeof acquisitionRegistry.configuredProductionLiveReadAcquisitionPort>;
  counts: {
    list: number;
    call: number;
    cursors: Array<string | null>;
  };
}

function pageFor(cursor: unknown): {
  records: Array<{ shard_code: string }>;
  page: { exhausted: boolean; next: string | null };
} {
  const pageIndex = cursor === undefined || cursor === null
    ? 0
    : cursor === 'partition-page-1'
      ? 1
      : cursor === 'partition-page-2'
        ? 2
        : -1;
  assert.notEqual(pageIndex, -1, `unexpected continuation cursor: ${String(cursor)}`);
  const start = pageIndex * PARTITION_PAGE_SIZE;
  const end = Math.min(start + PARTITION_PAGE_SIZE, PARTITION_RECORD_COUNT);
  const records = Array.from({ length: end - start }, (_, offset) => ({
    shard_code: `scope_${String(start + offset).padStart(5, '0')}`,
  }));
  const exhausted = end === PARTITION_RECORD_COUNT;
  return {
    records,
    page: {
      exhausted,
      next: exhausted ? null : `partition-page-${pageIndex + 1}`,
    },
  };
}

export function installGeneratedPartitionCarrier(): GeneratedPartitionCarrier {
  const counts = { list: 0, call: 0, cursors: [] as Array<string | null> };
  const tool = {
    name: PARTITION_TOOL_NAME,
    description: 'Enumerate the exact closed generated partition scope as bounded cursor pages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string' },
        cursor: { type: 'string' },
      },
      required: ['scope'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { shard_code: { type: 'string' } },
            required: ['shard_code'],
          },
        },
        page: {
          type: 'object',
          additionalProperties: false,
          properties: {
            exhausted: { type: 'boolean' },
            next: { type: ['string', 'null'] },
          },
          required: ['exhausted', 'next'],
        },
      },
      required: ['records', 'page'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const fakeServer: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'> = {
    async invalidateToolsCache() {},
    async listTools() {
      counts.list += 1;
      return [tool] as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(_toolName, args) {
      counts.call += 1;
      const input = (args ?? {}) as Record<string, unknown>;
      assert.equal(input.scope, 'generated-large');
      counts.cursors.push(typeof input.cursor === 'string' ? input.cursor : null);
      const payload = pageFor(input.cursor);
      const result = [{
        type: 'text',
        text: JSON.stringify(payload),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>> & Record<string, unknown>;
      Object.assign(result, {
        structuredContent: structuredClone(payload),
        isError: false,
      });
      return result;
    },
  };
  const configuredServer: ManagedMcpServer = {
    name: PARTITION_SERVER_NAME,
    type: 'stdio',
    command: '/isolated/generated-partition-source',
    args: ['--stdio'],
    env: { GENERATED_PARTITION_FIXTURE: '1' },
    description: 'Isolated generated partition source',
    enabled: true,
    source: 'user',
  };
  const runtime = {
    configuredServers: () => [configuredServer],
    serverForEnumeration: () => fakeServer,
    serverForOperation: () => fakeServer,
    portIdentity: () => ({
      portId: 'host:test-native-mcp-read:large-partition-journey',
      compiler: { id: 'host:mcp-json-arguments', version: '1' },
    }),
  };
  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = manifestStores.createCapabilityManifestStore([], { durable: true });
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(store);
  return {
    acquisition: acquisitionRegistry.configuredProductionLiveReadAcquisitionPort({
      configuredMcpServers: () => [configuredServer],
      mcpRuntimeForServer: () => runtime,
      factory,
      store,
    }),
    counts,
  };
}

/** Recording provider transport used in both processes; the real review runner
 * and verdict parser remain in charge of workflow completion. */
export function installRecordingPartitionReview() {
  const previous = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'https://partition-review.invalid/v1/chat/completions');
    const body = await request.json() as Record<string, unknown>;
    assert.equal(body.model, 'partition-review-fixture');
    assert.match(JSON.stringify(body.messages), /Complete the full workflow objective, including its constraints/);
    assert.match(JSON.stringify(body.messages), /workflow_execution/);
    assert.match(JSON.stringify(body.tools), /open_evidence/);
    requests.push(body);
    return new Response(JSON.stringify({ id: 'partition-recording-review', object: 'chat.completion', created: 1,
      model: 'partition-review-fixture', choices: [{ index: 0, message: { role: 'assistant',
        content: 'DONE: the recording pilot evidence satisfies its bounded objective' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, restore: () => { globalThis.fetch = previous; } };
}
