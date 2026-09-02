/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/restaurant-sheet-model-surface.competitive.red.test.ts
 *
 * Measurement-only wrapper around the exact cold Discord restaurant -> Sheet
 * journey.  It leaves the production request path untouched and records both
 * the Agents SDK ModelRequest and the Codex wire projection.  This is a RED
 * competitive gate until the ordinary cold surface is genuinely bounded.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import {
  estimateInputTokens,
  estimateTextOnlyTokens,
} from '../runtime/harness/token-estimator.js';

const INITIAL_MODEL_SURFACE_CEILING = 16 * 1024;
const CUMULATIVE_DISCOVERY_SCHEMA_CEILING = 32 * 1024;
const WARM_DISCOVERY_SCHEMA_RATIO = 0.70;
const PROMPT = 'Find me 10 restaurants in Santa Clarita and put them in a new Google Sheet';

type JsonRecord = Record<string, unknown>;

interface InputMetric {
  index: number;
  kind: string;
  callId: string | null;
  itemBytes: number;
  projectionBytes: number;
  leadingJsonBytes: number;
  outsideLeadingJsonBytes: number;
  resultArrayBytes: number;
  resultCount: number;
  resultRows: Array<{ name: string; bytes: number; sha256: string }>;
  schemaMapBytes: number;
  schemaNames: string[];
  schemas: Array<{ name: string; bytes: number; sha256: string }>;
  sha256: string;
  preview: string;
}

interface ToolMetric {
  name: string;
  bytes: number;
  descriptionBytes: number;
  parameterBytes: number;
  sha256: string;
}

interface RequestMetric {
  step: number;
  sdkBytes: number;
  sdkCodeUnits: number;
  sdkSha256: string;
  sdkSystemInstructionsBytes: number;
  sdkInputBytes: number;
  sdkToolsBytes: number;
  sdkSystemInstructionsMemberBytes: number;
  sdkInputMemberBytes: number;
  sdkToolsMemberBytes: number;
  sdkOtherAndFramingBytes: number;
  wireBytes: number;
  wireCodeUnits: number;
  wireSha256: string;
  wireInstructionsBytes: number;
  wireInstructionsSha256: string;
  wireInputBytes: number;
  wireInputSha256: string;
  wireToolsBytes: number;
  wireToolsSha256: string;
  wireInstructionsMemberBytes: number;
  wireInputMemberBytes: number;
  wireToolsMemberBytes: number;
  wireOtherAndFramingBytes: number;
  estimatedInstructionTokens: number;
  estimatedInputTokens: number;
  estimatedToolTokens: number;
  estimatedSemanticTokens: number;
  cacheablePrefixBytes: number;
  cacheablePrefixSha256: string;
  semanticPromptBytes: number;
  commonSemanticPrefixWithPreviousBytes: number;
  potentialUncachedSemanticBytes: number;
  promptCacheKeyPresent: boolean;
  inputArrayFramingBytes: number;
  toolArrayFramingBytes: number;
  inputBuckets: Record<string, number>;
  stableInstructionSections: Array<{ heading: string; bytes: number; sha256: string }>;
  instructionComponents: {
    constitutionBytes: number;
    batchMandateBytes: number;
    phaseDirectiveBytes: number;
    catalogBytes: number;
    capabilityCardBytes: number;
    sectionSeparatorBytes: number;
  };
  tools: ToolMetric[];
  input: InputMetric[];
}

const nativeStringify = JSON.stringify.bind(JSON);
const seen = new WeakSet<object>();
const captures: RequestMetric[] = [];
const backgroundModelCandidates: Array<{
  kind: 'memory_reflection';
  inputBytes: number;
  inputCodeUnits: number;
  estimatedInputTokens: number;
  sha256: string;
  preview: string;
}> = [];
let previousSemanticPrompt: Buffer | null = null;
let previousPromptCacheKey: string | null = null;

function json(value: unknown): string {
  return nativeStringify(value) ?? '';
}

function bytes(value: unknown): number {
  return Buffer.byteLength(json(value), 'utf8');
}

function textBytes(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function callIdOf(item: JsonRecord): string | null {
  const value = item.callId ?? item.call_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function projectionOf(item: JsonRecord): unknown {
  return item.output ?? item.content ?? null;
}

function projectionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const row = record(entry);
      return row && typeof row.text === 'string' ? row.text : json(entry);
    }).join('');
  }
  const row = record(value);
  if (row && typeof row.text === 'string') return row.text;
  return json(value);
}

function leadingJsonObject(text: string): { value: JsonRecord; source: string } | null {
  const offset = text.search(/\S/);
  if (offset < 0 || text[offset] !== '{') return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = offset; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const source = text.slice(offset, index + 1);
        try {
          const value = record(JSON.parse(source));
          return value ? { value, source } : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function classifyInput(item: JsonRecord): string {
  const callId = callIdOf(item);
  const type = typeof item.type === 'string' ? item.type : '';
  const role = typeof item.role === 'string' ? item.role : '';
  const serialized = json(item);
  if (callId === 'discover-capabilities' && /result|output/i.test(type)) return 'discovery_projection';
  if (callId === 'admit-natural-task' && /result|output/i.test(type)) return 'plan_projection';
  if (callId === 'restaurant-read' && /result|output/i.test(type)) return 'provider_read_projection';
  if (callId === 'sheet-create' && /result|output/i.test(type)) return 'provider_write_projection';
  if (/function_call_result|function_call_output/i.test(type)) return 'other_tool_projection';
  if (/function_call/i.test(type)) return 'assistant_tool_call';
  if (role === 'user' && serialized.includes(PROMPT)) return 'accepted_user_request';
  if (role === 'system' && /# (?:Persistent Context|Current State \(refreshed this turn\))/i.test(serialized)) {
    return 'accepted_turn_context_snapshot';
  }
  if (role === 'system') return 'other_system_context';
  if (role === 'assistant') return 'assistant_history';
  return type || role || 'other_history';
}

function metricForInput(item: unknown, index: number): InputMetric {
  const row = record(item) ?? {};
  const serialized = json(item);
  const projection = projectionOf(row);
  const projectedText = projectionText(projection);
  const leading = leadingJsonObject(projectedText);
  const results = leading && Array.isArray(leading.value.results) ? leading.value.results : [];
  const schemas = leading ? record(leading.value.schemas) : null;
  const leadingJsonBytes = leading ? Buffer.byteLength(leading.source, 'utf8') : 0;
  const projectionBytes = Buffer.byteLength(projectedText, 'utf8');
  return {
    index,
    kind: classifyInput(row),
    callId: callIdOf(row),
    itemBytes: Buffer.byteLength(serialized, 'utf8'),
    projectionBytes,
    leadingJsonBytes,
    outsideLeadingJsonBytes: Math.max(0, projectionBytes - leadingJsonBytes),
    resultArrayBytes: results.length > 0 ? bytes(results) : 0,
    resultCount: results.length,
    resultRows: results.map((result) => {
      const row = record(result);
      const name = row && typeof row.name === 'string' ? row.name : '(unnamed)';
      const serializedResult = json(result);
      return {
        name,
        bytes: Buffer.byteLength(serializedResult, 'utf8'),
        sha256: digest(serializedResult),
      };
    }),
    schemaMapBytes: schemas ? bytes(schemas) : 0,
    schemaNames: schemas ? Object.keys(schemas).sort() : [],
    schemas: schemas ? Object.entries(schemas).map(([name, schema]) => {
      const serializedSchema = json(schema);
      return {
        name,
        bytes: Buffer.byteLength(serializedSchema, 'utf8'),
        sha256: digest(serializedSchema),
      };
    }).sort((left, right) => left.name.localeCompare(right.name)) : [],
    sha256: digest(serialized),
    preview: projectedText.replace(/\s+/g, ' ').slice(0, 120),
  };
}

function metricForTool(tool: unknown): ToolMetric {
  const row = record(tool) ?? {};
  const serialized = json(tool);
  return {
    name: typeof row.name === 'string' ? row.name : '(unnamed)',
    bytes: Buffer.byteLength(serialized, 'utf8'),
    descriptionBytes: textBytes(row.description),
    parameterBytes: bytes(row.parameters ?? {}),
    sha256: digest(serialized),
  };
}

function topLevelMemberBytes(body: JsonRecord, key: string): number {
  if (!(key in body)) return 0;
  return Buffer.byteLength(`${json(key)}:${json(body[key])}`, 'utf8');
}

function commonPrefixBytes(left: Buffer | null, right: Buffer): number {
  if (!left) return 0;
  const ceiling = Math.min(left.length, right.length);
  let index = 0;
  while (index < ceiling && left[index] === right[index]) index += 1;
  return index;
}

let buildWire: ((modelId: string, request: never) => JsonRecord) | null = null;

function looksLikeModelRequest(value: unknown): value is JsonRecord {
  const row = record(value);
  return !!row
    && Array.isArray(row.tools)
    && ('input' in row)
    && ('modelSettings' in row)
    && ('handoffs' in row);
}

function captureRequest(request: JsonRecord): void {
  if (!buildWire || seen.has(request)) return;
  seen.add(request);
  const wire = buildWire('gpt-5.5', request as never);
  const wireInput = Array.isArray(wire.input) ? wire.input : [];
  const wireTools = Array.isArray(wire.tools) ? wire.tools : [];
  const wireBytes = bytes(wire);
  const wireCodeUnits = json(wire).length;
  const wireInstructionsBytes = textBytes(wire.instructions);
  const wireInputBytes = bytes(wireInput);
  const wireToolsBytes = bytes(wireTools);
  const sdkBytes = bytes(request);
  const sdkCodeUnits = json(request).length;
  const sdkSystemInstructionsBytes = textBytes(request.systemInstructions);
  const sdkInputBytes = bytes(request.input);
  const sdkToolsBytes = bytes(request.tools);
  const sdkSystemInstructionsMemberBytes = topLevelMemberBytes(request, 'systemInstructions');
  const sdkInputMemberBytes = topLevelMemberBytes(request, 'input');
  const sdkToolsMemberBytes = topLevelMemberBytes(request, 'tools');
  const sdkOtherAndFramingBytes = sdkBytes
    - sdkSystemInstructionsMemberBytes
    - sdkInputMemberBytes
    - sdkToolsMemberBytes;
  // JSON array/string buckets exclude top-level member names and commas.  The
  // remainder makes that framing explicit instead of silently losing bytes.
  const wireInstructionsMemberBytes = topLevelMemberBytes(wire, 'instructions');
  const wireInputMemberBytes = topLevelMemberBytes(wire, 'input');
  const wireToolsMemberBytes = topLevelMemberBytes(wire, 'tools');
  const wireOtherAndFramingBytes = wireBytes
    - wireInstructionsMemberBytes
    - wireInputMemberBytes
    - wireToolsMemberBytes;
  const input = wireInput.map(metricForInput);
  const tools = wireTools.map(metricForTool);
  const rawTools = wireTools;
  const estimatedInstructionTokens = estimateTextOnlyTokens(
    typeof wire.instructions === 'string' ? wire.instructions : '',
  );
  const estimatedWireInputTokens = estimateInputTokens(wireInput as never[]);
  // Use the repository estimator's documented 1.3x JSON-density treatment for
  // exact serialized tool definitions; this is intentionally not bytes/4.
  const estimatedToolTokens = Math.ceil((json(wireTools).length / 4) * 1.3);
  const semanticPrompt = Buffer.from(json({
    instructions: wire.instructions ?? '',
    tools: wireTools,
    input: wireInput,
  }), 'utf8');
  const promptCacheKey = typeof wire.prompt_cache_key === 'string' ? wire.prompt_cache_key : null;
  const commonSemanticPrefixWithPreviousBytes = promptCacheKey === previousPromptCacheKey
    ? commonPrefixBytes(previousSemanticPrompt, semanticPrompt)
    : 0;
  previousSemanticPrompt = semanticPrompt;
  previousPromptCacheKey = promptCacheKey;
  const inputBuckets: Record<string, number> = {};
  for (const item of input) inputBuckets[item.kind] = (inputBuckets[item.kind] ?? 0) + item.itemBytes;
  captures.push({
    step: captures.length + 1,
    sdkBytes,
    sdkCodeUnits,
    sdkSha256: digest(json(request)),
    sdkSystemInstructionsBytes,
    sdkInputBytes,
    sdkToolsBytes,
    sdkSystemInstructionsMemberBytes,
    sdkInputMemberBytes,
    sdkToolsMemberBytes,
    sdkOtherAndFramingBytes,
    wireBytes,
    wireCodeUnits,
    wireSha256: digest(json(wire)),
    wireInstructionsBytes,
    wireInstructionsSha256: digest(typeof wire.instructions === 'string' ? wire.instructions : ''),
    wireInputBytes,
    wireInputSha256: digest(json(wireInput)),
    wireToolsBytes,
    wireToolsSha256: digest(json(wireTools)),
    wireInstructionsMemberBytes,
    wireInputMemberBytes,
    wireToolsMemberBytes,
    wireOtherAndFramingBytes,
    estimatedInstructionTokens,
    estimatedInputTokens: estimatedWireInputTokens,
    estimatedToolTokens,
    estimatedSemanticTokens:
      estimatedInstructionTokens + estimatedWireInputTokens + estimatedToolTokens,
    cacheablePrefixBytes: wireInstructionsMemberBytes + wireToolsMemberBytes,
    cacheablePrefixSha256: digest(json({
      instructions: wire.instructions ?? '',
      tools: wireTools,
    })),
    semanticPromptBytes: semanticPrompt.length,
    commonSemanticPrefixWithPreviousBytes,
    potentialUncachedSemanticBytes: semanticPrompt.length - commonSemanticPrefixWithPreviousBytes,
    promptCacheKeyPresent: promptCacheKey !== null,
    inputArrayFramingBytes: wireInputBytes - input.reduce((sum, item) => sum + item.itemBytes, 0),
    toolArrayFramingBytes: wireToolsBytes - tools.reduce((sum, tool) => sum + tool.bytes, 0),
    inputBuckets,
    stableInstructionSections: instructionSections(
      typeof wire.instructions === 'string' ? wire.instructions : '',
    ).slice(0, 20),
    instructionComponents: instructionComponents(
      typeof wire.instructions === 'string' ? wire.instructions : '',
    ),
    tools,
    rawTools,
    input,
  });
}

JSON.stringify = ((value: unknown, replacer?: unknown, space?: string | number) => {
  if (looksLikeModelRequest(value)) captureRequest(value);
  return nativeStringify(value, replacer as never, space);
}) as typeof JSON.stringify;

// Importing registers the exact journey without copying or weakening its
// channel, bridge, host, provider, replay, or durability assertions.  It must
// set its isolated environment before codex-model/config are imported.
await import('./restaurant-sheet-natural-request.integration.test.js');
({ buildCodexRequestBody: buildWire } = await import('../runtime/harness/codex-model.js') as unknown as {
  buildCodexRequestBody: (modelId: string, request: never) => JsonRecord;
});
const reflection = await import('../memory/reflection.js');
reflection._testOnly_setReflectionExtractor(async (serialized) => {
  backgroundModelCandidates.push({
    kind: 'memory_reflection',
    inputBytes: Buffer.byteLength(serialized, 'utf8'),
    inputCodeUnits: serialized.length,
    estimatedInputTokens: estimateTextOnlyTokens(serialized),
    sha256: digest(serialized),
    preview: serialized.replace(/\s+/g, ' ').slice(0, 160),
  });
  return {
    facts: [],
    entities: [],
    pointers: [],
    resources: [],
    relationships: [],
  } as never;
});

function uniqueToolBytes(requests: readonly RequestMetric[]): number {
  const unique = new Map<string, ToolMetric>();
  for (const request of requests) {
    for (const tool of request.tools) unique.set(tool.sha256, tool);
  }
  const rows = [...unique.values()];
  return rows.reduce((sum, tool) => sum + tool.bytes, 0)
    + 2 + Math.max(0, rows.length - 1);
}

function uniqueProjectionBytes(requests: readonly RequestMetric[], kinds: ReadonlySet<string>): number {
  const unique = new Map<string, InputMetric>();
  for (const request of requests) {
    for (const item of request.input) {
      if (kinds.has(item.kind)) unique.set(item.sha256, item);
    }
  }
  return [...unique.values()].reduce((sum, item) => sum + item.projectionBytes, 0);
}

function repeatedProjectionBytes(requests: readonly RequestMetric[], kinds: ReadonlySet<string>): number {
  return requests.reduce((total, request) => total + request.input
    .filter((item) => kinds.has(item.kind))
    .reduce((sum, item) => sum + item.projectionBytes, 0), 0);
}

function uniqueProjectionItems(
  requests: readonly RequestMetric[],
  kinds: ReadonlySet<string>,
): InputMetric[] {
  const unique = new Map<string, InputMetric>();
  for (const request of requests) {
    for (const item of request.input) if (kinds.has(item.kind)) unique.set(item.sha256, item);
  }
  return [...unique.values()];
}

function instructionSections(instructions: string): Array<{ heading: string; bytes: number; sha256: string }> {
  // The rubric and action/catalog packets are composed as blank-line-delimited
  // blocks.  Keep those ownership seams visible; a single 10KiB "instructions"
  // number is not surgical enough to guide a provider-neutral cut.
  const sections = instructions.split(/\n{2,}/).filter((section) => section.length > 0);
  return sections.map((section) => ({
    heading: section.split('\n').find((line) => line.trim())?.trim().slice(0, 140) ?? '(blank)',
    bytes: Buffer.byteLength(section, 'utf8'),
    sha256: digest(section),
  })).sort((left, right) => right.bytes - left.bytes);
}

function instructionComponents(instructions: string): RequestMetric['instructionComponents'] {
  const sections = instructions.split(/\n{2,}/).filter((section) => section.length > 0);
  const metrics = {
    constitutionBytes: 0,
    batchMandateBytes: 0,
    phaseDirectiveBytes: 0,
    catalogBytes: 0,
    capabilityCardBytes: 0,
    sectionSeparatorBytes: 0,
  };
  let sectionBytes = 0;
  for (const section of sections) {
    const sectionSize = Buffer.byteLength(section, 'utf8');
    sectionBytes += sectionSize;
    if (section.startsWith('BATCH-SHAPE RULE')) metrics.batchMandateBytes += sectionSize;
    else if (section.startsWith('[action-')) metrics.phaseDirectiveBytes += sectionSize;
    else if (section.startsWith('[tool-catalog]')) metrics.catalogBytes += sectionSize;
    else if (/^(?:## Discovery roles|\[capability)/i.test(section)) metrics.capabilityCardBytes += sectionSize;
    else metrics.constitutionBytes += sectionSize;
  }
  metrics.sectionSeparatorBytes = Math.max(
    0,
    Buffer.byteLength(instructions, 'utf8') - sectionBytes,
  );
  return metrics;
}

test('competitive byte ledger: cold natural request stays below planning and discovery/schema ceilings', () => {
  const projections = new Set([
    'discovery_projection',
    'plan_projection',
    'provider_read_projection',
    'provider_write_projection',
  ]);
  const discoveryOnly = new Set(['discovery_projection']);
  const foregroundCaptures = captures.slice(0, 4);
  assert.equal(foregroundCaptures.length, 4,
    `expected all four foreground model steps, captured ${captures.length} total requests`);
  assert.match(foregroundCaptures[0]?.input[0]?.preview ?? '', new RegExp(PROMPT),
    'the measured slice must begin with the exact cold foreground request');
  const preActivation = foregroundCaptures.slice(0, 2);
  const initialSdkBytes = foregroundCaptures[0]?.sdkBytes ?? Number.POSITIVE_INFINITY;
  const initialWireBytes = foregroundCaptures[0]?.wireBytes ?? Number.POSITIVE_INFINITY;
  const initialToolSchemaBytes = foregroundCaptures[0]?.wireToolsBytes ?? Number.POSITIVE_INFINITY;
  const preActivationUniqueToolBytes = uniqueToolBytes(preActivation);
  const allUniqueToolBytes = uniqueToolBytes(foregroundCaptures);
  const uniqueDiscoveryProjectionBytes = uniqueProjectionBytes(foregroundCaptures, discoveryOnly);
  const uniqueDiscoveryItems = uniqueProjectionItems(foregroundCaptures, discoveryOnly);
  const preActivationDiscoverySchemaBytes = preActivationUniqueToolBytes + uniqueDiscoveryProjectionBytes;
  const wholeJourneyDiscoverySchemaBytes = allUniqueToolBytes + uniqueDiscoveryProjectionBytes;
  const prefixGroups = [...foregroundCaptures.reduce((groups, request) => {
    const existing = groups.get(request.cacheablePrefixSha256);
    if (existing) existing.steps.push(request.step);
    else groups.set(request.cacheablePrefixSha256, {
      sha256: request.cacheablePrefixSha256,
      bytes: request.cacheablePrefixBytes,
      steps: [request.step],
    });
    return groups;
  }, new Map<string, { sha256: string; bytes: number; steps: number[] }>()).values()];
  const contextSnapshotProjection = foregroundCaptures.map((request) => {
    const items = request.input.filter((item) => item.kind === 'accepted_turn_context_snapshot');
    return {
      step: request.step,
      count: items.length,
      indexes: items.map((item) => item.index),
      inputTailIndex: request.input.length - 1,
      digests: items.map((item) => item.sha256),
      bytes: items.reduce((sum, item) => sum + item.itemBytes, 0),
    };
  });
  const report = {
    ceilings: {
      initialModelSurfaceBytes: INITIAL_MODEL_SURFACE_CEILING,
      cumulativeDiscoverySchemaBytes: CUMULATIVE_DISCOVERY_SCHEMA_CEILING,
      warmRatio: WARM_DISCOVERY_SCHEMA_RATIO,
    },
    cold: {
      initialSdkBytes,
      initialWireBytes,
      initialEstimatedSemanticTokens: foregroundCaptures[0]?.estimatedSemanticTokens ?? null,
      initialToolSchemaBytes,
      preActivationUniqueToolBytes,
      allUniqueToolBytes,
      uniqueDiscoveryProjectionBytes,
      uniqueDisclosedProviderSchemaBytes: uniqueDiscoveryItems
        .reduce((sum, item) => sum + item.schemaMapBytes, 0),
      uniqueDiscoveryResultRowsBytes: uniqueDiscoveryItems
        .reduce((sum, item) => sum + item.resultArrayBytes, 0),
      uniqueDiscoveryNonSchemaBytes: uniqueDiscoveryItems.reduce(
        (sum, item) => sum + Math.max(0, item.projectionBytes - item.schemaMapBytes),
        0,
      ),
      preActivationDiscoverySchemaBytes,
      wholeJourneyDiscoverySchemaBytes,
      preActivationTransmittedDiscoverySchemaBytes:
        preActivation.reduce((sum, request) => sum + request.wireToolsBytes, 0)
        + repeatedProjectionBytes(preActivation, discoveryOnly),
      repeatedToolSchemaBytes: foregroundCaptures.reduce((sum, request) => sum + request.wireToolsBytes, 0),
      repeatedDiscoveryProjectionBytes: repeatedProjectionBytes(foregroundCaptures, discoveryOnly),
      repeatedAllToolProjectionBytes: repeatedProjectionBytes(foregroundCaptures, projections),
      semanticPromptBytesTransmitted: foregroundCaptures.reduce((sum, request) => sum + request.semanticPromptBytes, 0),
      estimatedSemanticTokensTransmitted: foregroundCaptures
        .reduce((sum, request) => sum + request.estimatedSemanticTokens, 0),
      bytePrefixPotentialUncachedSemanticBytes: foregroundCaptures
        .reduce((sum, request) => sum + request.potentialUncachedSemanticBytes, 0),
      warmWholeJourneyDiscoverySchemaTargetBytes: Math.floor(wholeJourneyDiscoverySchemaBytes * WARM_DISCOVERY_SCHEMA_RATIO),
    },
    backgroundModelCandidates,
    cacheablePrefixes: prefixGroups,
    contextSnapshotProjection,
    totalCapturedRequests: captures.length,
    requests: foregroundCaptures.map(({ stableInstructionSections: _sections, ...request }) => request),
    topStableInstructionSections: foregroundCaptures[0]?.stableInstructionSections ?? [],
  };
  // The request records contain exact instruction byte counts but intentionally
  // avoid logging prompt prose.  Digests/previews cover tool projections; the
  // normal journey independently proves the accepted text and exact refs.
  process.stdout.write(`\nMODEL_SURFACE_LEDGER ${json(report)}\n`);
  if (process.env.CLEMMY_SURFACE_DUMP === '1') {
    // Diagnostic only: the raw SDK definition of every first-step tool over
    // 1.5 KB, so a byte ledger can be turned into a targeted trim.
    for (const tool of foregroundCaptures[0]?.rawTools ?? []) {
      const serialized = JSON.stringify(tool);
      if (serialized.length > 1500) process.stdout.write(`\nMODEL_SURFACE_TOOL ${serialized}\n`);
    }
  }
  process.stdout.write(`MODEL_SURFACE_SUMMARY ${json({
    backgroundModelCandidates,
    totalCapturedRequests: captures.length,
    requests: foregroundCaptures.map((request) => ({
      step: request.step,
      sdkBytes: request.sdkBytes,
      sdkCodeUnits: request.sdkCodeUnits,
      wireBytes: request.wireBytes,
      wireCodeUnits: request.wireCodeUnits,
      estimatedSemanticTokens: request.estimatedSemanticTokens,
      estimatedInstructionTokens: request.estimatedInstructionTokens,
      estimatedInputTokens: request.estimatedInputTokens,
      estimatedToolTokens: request.estimatedToolTokens,
      wireInstructionsBytes: request.wireInstructionsBytes,
      wireInstructionsMemberBytes: request.wireInstructionsMemberBytes,
      instructionComponents: request.instructionComponents,
      wireInputBytes: request.wireInputBytes,
      wireInputMemberBytes: request.wireInputMemberBytes,
      wireToolsBytes: request.wireToolsBytes,
      wireToolsMemberBytes: request.wireToolsMemberBytes,
      wireOtherAndFramingBytes: request.wireOtherAndFramingBytes,
      semanticPromptBytes: request.semanticPromptBytes,
      cacheablePrefixBytes: request.cacheablePrefixBytes,
      cacheablePrefixSha256: request.cacheablePrefixSha256,
      commonSemanticPrefixWithPreviousBytes: request.commonSemanticPrefixWithPreviousBytes,
      potentialUncachedSemanticBytes: request.potentialUncachedSemanticBytes,
      tools: request.tools.map((tool) => ({ name: tool.name, bytes: tool.bytes })),
      input: request.input.map((item) => ({
        index: item.index,
        kind: item.kind,
        itemBytes: item.itemBytes,
        projectionBytes: item.projectionBytes,
        resultCount: item.resultCount,
        resultRows: item.resultRows,
        schemaMapBytes: item.schemaMapBytes,
        schemaNames: item.schemaNames,
        schemas: item.schemas,
        sha256: item.sha256,
      })),
    })),
  })}\n`);
  const toolNamesAt = (step: number) => (foregroundCaptures[step - 1]?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
  assert.equal(toolNamesAt(1).includes('tool_search'), true,
    'blank cold pre-plan exposes metadata discovery');
  assert.equal(toolNamesAt(1).includes('plan_task'), false,
    'blank cold pre-plan cannot advertise plan_task before exact disclosure');
  assert.equal(toolNamesAt(1).includes('run_worker'), false,
    'worker dispatch stays hidden before plan activation');
  assert.equal(toolNamesAt(2).includes('plan_task'), true,
    'exact discovery enables the plan control');
  assert.equal(toolNamesAt(2).includes('run_worker'), false,
    'discovery alone grants no worker authority');
  assert.equal(toolNamesAt(3).includes('plan_task'), false,
    'the plan control retires after durable activation');
  assert.equal(toolNamesAt(3).includes('work_call'), true,
    'the activated graph exposes the shared business carrier');
  assert.equal(toolNamesAt(3).includes('run_worker'), true,
    'bounded worker fanout becomes reachable only after activation');
  assert.equal(toolNamesAt(4).includes('plan_task'), false,
    'terminal synthesis cannot reopen planning authority');
  const contextDigests = new Set(contextSnapshotProjection.flatMap((step) => step.digests));
  assert.ok(contextSnapshotProjection.every((step) => step.count <= 1),
    `each model step may project at most one accepted-turn context snapshot: ${json(contextSnapshotProjection)}`);
  assert.equal(new Set(contextSnapshotProjection.map((step) => step.count)).size, 1,
    `the accepted-turn context snapshot may not appear/disappear mid-turn: ${json(contextSnapshotProjection)}`);
  assert.ok(contextDigests.size <= 1,
    `one accepted turn must not re-render a different memory/context snapshot: ${json(contextSnapshotProjection)}`);
  assert.ok(contextSnapshotProjection.every((step) =>
    step.indexes.length === 1 && step.indexes[0] === step.inputTailIndex),
  `the source-bound context snapshot must remain at the cache-stable input tail: ${json(contextSnapshotProjection)}`);
  assert.equal(backgroundModelCandidates.length, 0,
    `accepted turn launched hidden post-terminal/background model candidates: ${json(backgroundModelCandidates)}`);
  assert.ok(initialSdkBytes <= INITIAL_MODEL_SURFACE_CEILING,
    `initial SDK model-visible surface exceeded 16KiB: ${initialSdkBytes}`);
  assert.ok(initialWireBytes <= INITIAL_MODEL_SURFACE_CEILING,
    `initial model-visible wire surface exceeded 16KiB: ${initialWireBytes}`);
  assert.ok(preActivationDiscoverySchemaBytes <= CUMULATIVE_DISCOVERY_SCHEMA_CEILING,
    `pre-activation discovery/schema surface exceeded 32KiB: ${preActivationDiscoverySchemaBytes}`);
});

after(() => {
  reflection._testOnly_setReflectionExtractor(null);
  JSON.stringify = nativeStringify as typeof JSON.stringify;
});
