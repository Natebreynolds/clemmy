/**
 * Run: npx tsx --test src/tools/plan-tools-input-repair.red.test.ts
 *
 * plan_task input failures must name their own fix, typed.
 *
 * Measured live (gauntlet 2026-08-26, replayed byte-exact against the real SDK
 * parser): the six InvalidToolInputError plan_task calls across four sessions
 * were all schema-layer rejections whose zod issues NAMED the violated path —
 *   ×2 "draft.topology :: operation[1].coverage and cardinality describe
 *       different read sets" (sess-desktop-8823…, b3a7…),
 *   ×2 "draft.bindings.N.evidence.0 :: Invalid string: must match pattern"
 *       (sess-desktop-f58f…),
 *   ×1 'draft :: Unrecognized key: "version"' (sess-desktop-e0e9…) —
 * and the SDK's default errorFunction destroyed every one of them into
 * "An error occurred while running the tool. Please try again. Error:
 * InvalidToolInputError: Invalid JSON input for tool". Blind identical retries
 * followed (5× → guardrail block → dead conversation). Errors that name their
 * own condition must reach the model (self-healing law).
 *
 * Also pinned here, at the schema layer: the nullish-anyOf strict-schema TRAP.
 * plan_task's published JSON schema carries type-less anyOf wrappers at
 * draft.cardinality, draft.destination, and operations[].coverage/cardinality;
 * the strict-nullable materializer must recurse those wrappers so a model that
 * omits the optional-looking keys still parses (reference:
 * nullish-anyof-strict-schema-trap, fixed once at jsonSchemaTypeMatches).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bare `npx tsx --test` must never bind the LIVE home — same preamble as the
// sibling pins.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-input-repair-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-plan-input-repair\n', 'utf8');
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { PlanTaskInputSchema, buildPlanTaskTool } from './plan-tools.js';
import { materializeStrictNullableFields } from '../runtime/schema-normalizer.js';

const require = createRequire(import.meta.url);
// The exact schema+parser derivation the Agents SDK applies to this tool. The
// package does not export the subpath, so resolve it off the package root.
const agentsCoreRoot = require.resolve('@openai/agents-core');
const { getSchemaAndParserFromInputType } = require(
  agentsCoreRoot.replace(/index\.(?:m?js|cjs)$/, 'utils/tools.js'),
) as {
  getSchemaAndParserFromInputType: (
    parameters: unknown,
    name: string,
    options: { strict: boolean },
  ) => { parser: (input: string) => unknown; schema: unknown };
};

const { parser, schema } = getSchemaAndParserFromInputType(PlanTaskInputSchema, 'plan_task', { strict: true });

/** The live sess-desktop-8823… payload shape: coverage 'complete_set' on an
 * each-cardinality read — the schema refine rejects it BY NAME. */
function liveMismatchArgs(): Record<string, unknown> {
  return {
    preamble: 'I will list the runs, then check each one individually.',
    draft: {
      criteria: ['Every run is checked individually via its own status read'],
      cardinality: null,
      destination: null,
      topology: {
        version: 1,
        operations: [
          {
            id: 'op-list-runs', effect: 'read', coverage: 'complete_set',
            dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
          },
          {
            id: 'op-check-each-run', effect: 'read', coverage: 'complete_set',
            dependsOn: ['op-list-runs'], dataFrom: ['op-list-runs'],
            cardinality: { kind: 'each', universeId: 'runs' },
          },
        ],
        universes: [{
          id: 'runs', seal: 'complete_source_receipt',
          producedBy: 'op-list-runs', memberIdPointer: '/run_id',
        }],
      },
      bindings: [
        { operationId: 'op-list-runs', role: 'list', capabilityRef: 'workflow_run_status', evidence: ['clause-1:read'] },
        { operationId: 'op-check-each-run', role: 'detail', capabilityRef: 'workflow_run_status', evidence: ['clause-1:read'] },
      ],
      deliverables: [{ id: 'status-tally', kind: 'report' }],
      evidenceRequirements: ['clause-1:read'],
    },
  };
}

function planTaskInvokable(): { invoke: (context: unknown, input: string) => Promise<unknown> } {
  const identity = { sessionId: 'plan-input-repair', sourceUserSeq: 1 };
  return buildPlanTaskTool({
    planning: {
      authority: Object.freeze({}),
      identity,
      capabilities: [{ id: 'workflow_run_status', effect: 'read', purpose: 'status' }],
      digest: 'repair',
    },
  } as never) as unknown as { invoke: (context: unknown, input: string) => Promise<unknown> };
}

test('an input-validation failure returns a typed refusal that names the violated path', async () => {
  const tool = planTaskInvokable();
  // The live 09-01 shape (a complete_set per-item read) is now DERIVED by the
  // host (work-topology.test.ts), so this pin uses the pair the host cannot
  // derive: a finite accepted set read once names no set at all.
  const args = liveMismatchArgs();
  const detail = (((args.draft as Record<string, unknown>).topology as Record<string, unknown>)
    .operations as Array<Record<string, unknown>>)[1]!;
  detail.coverage = 'accepted_set';
  detail.cardinality = { kind: 'once' };
  const raw = await tool.invoke({}, JSON.stringify(args));
  const text = String(raw);
  assert.doesNotMatch(text, /^An error occurred while running the tool/,
    'the SDK default string names nothing the model can correct — live cost: 5 blind identical retries, then a dead conversation');
  const parsed = JSON.parse(text) as { ok?: unknown; code?: unknown; detail?: unknown; repair?: unknown };
  assert.equal(parsed.ok, false, 'the result stays inside plan_task’s closed typed union');
  assert.equal(parsed.code, 'plan_invalid_input');
  assert.match(String(parsed.detail), /draft\.topology/,
    'the violated path reaches the model');
  assert.match(String(parsed.detail), /coverage and cardinality/,
    'the refine message names its own fix; destroying it violated the self-healing law');
  assert.equal(typeof parsed.repair, 'string');
});

test('an unrecognized-key failure names the exact key (live sess-desktop-e0e9 shape)', async () => {
  const tool = planTaskInvokable();
  const args = liveMismatchArgs();
  (args.draft as Record<string, unknown>).version = 1;
  (((args.draft as Record<string, unknown>).topology as Record<string, unknown>)
    .operations as Array<Record<string, unknown>>)[1]!.coverage = 'single';
  const raw = await tool.invoke({}, JSON.stringify(args));
  const parsed = JSON.parse(String(raw)) as { ok?: unknown; code?: unknown; detail?: unknown };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'plan_invalid_input');
  assert.match(String(parsed.detail), /version/i, 'the stray key is named, not laundered away');
});

test('type-less anyOf wrappers in the published schema materialize and parse (nullish-anyOf pin)', async () => {
  // The wrappers must exist — this is the exact shape the TRAP fires on.
  const draftSchema = (schema as {
    properties: { draft: { properties: Record<string, { anyOf?: unknown; type?: unknown }> } };
  }).properties.draft;
  for (const key of ['cardinality', 'destination'] as const) {
    const wrapper = draftSchema.properties[key]!;
    assert.ok(Array.isArray(wrapper.anyOf) && wrapper.type === undefined,
      `draft.${key} is a type-less anyOf wrapper; a walker that type-matches on schema.type loses it`);
  }

  // A model that omits every optional-looking nullable key — the Claude-lane
  // emission the strict-nullable materializer exists for.
  const omitted = liveMismatchArgs();
  const draft = omitted.draft as Record<string, unknown>;
  delete draft.cardinality;
  delete draft.destination;
  (((draft.topology as Record<string, unknown>).operations as Array<Record<string, unknown>>))[1]!.coverage = 'single';
  const materialized = materializeStrictNullableFields(omitted, schema) as {
    draft: Record<string, unknown>;
  };
  assert.equal(materialized.draft.cardinality, null,
    'the materializer recursed the type-less wrapper and filled the required nullable');
  assert.equal(materialized.draft.destination, null);
  await assert.doesNotReject(async () => { await parser(JSON.stringify(materialized)); },
    'the materialized emission round-trips the real SDK parser');
});
