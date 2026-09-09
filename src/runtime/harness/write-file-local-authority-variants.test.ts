/**
 * RED-first contract for argument-dependent write_file planning authority.
 *
 * One configured tool owns three runtime modes. Planning must disclose three
 * provider-neutral local envelopes over that same physical tool/schema so the
 * accepted plan freezes create, append, or overwrite before the model supplies
 * work_call arguments. Merely dropping the existing create-only safeMode would
 * make one broad ref authorize every mode and is intentionally insufficient.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs --test-concurrency=1 \
 *     src/runtime/harness/write-file-local-authority-variants.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-write-file-authority-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-write-file-authority\n', 'utf8');

const local = await import('./local-planning-capability.js');
const registry = await import('../../tools/tool-registry.js');
const eventlog = await import('./eventlog.js');

type WriteVariant = {
  capabilityRef: string;
  reversibility: string;
  destructive: boolean;
  destinationPosture: string | null;
};

type ObservedVariantsResult =
  | {
      ok: true;
      definitions: readonly import('./local-planning-capability.js').AuthorizedLocalPlanningDefinitionV1[];
      schema: Record<string, unknown>;
    }
  | { ok: false; reason: string };

after(() => {
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

async function observedWriteFileVariants() {
  const observe = (local as unknown as {
    observeCurrentLocalPlanningDefinitions?: (input: {
      name: string;
      carrier: 'work_call';
    }) => Promise<ObservedVariantsResult>;
  }).observeCurrentLocalPlanningDefinitions;
  assert.equal(
    typeof observe,
    'function',
    'RED: local authority can observe only one definition per configured tool name',
  );
  const observed = await observe!({
    name: 'write_file',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, observed.ok ? '' : observed.reason);
  if (!observed.ok) throw new Error(observed.reason);
  return observed;
}

function exactMatch(
  definitions: readonly import('./local-planning-capability.js').AuthorizedLocalPlanningDefinitionV1[],
  args: unknown,
) {
  const matches = definitions.filter((definition) => (
    local.localPlanningArgumentsMatch(definition, args)
  ));
  return matches.length === 1 ? matches[0]! : null;
}

test('write_file declares three split local authority refs with truthful risk', async () => {
  const declaration = registry.TOOL_REGISTRY.find((entry) => entry.name === 'write_file');
  assert.ok(declaration, 'write_file registry row exists exactly once');
  const observed = await observedWriteFileVariants();
  const variants: WriteVariant[] = observed.definitions.map((definition) => ({
    capabilityRef: definition.capabilityRef,
    reversibility: definition.reversibility,
    destructive: definition.destructive,
    destinationPosture: definition.descriptor.destinationPosture,
  }));

  assert.deepEqual(variants, [
    {
      capabilityRef: 'cap:local:write_file:create',
      reversibility: 'create_only',
      destructive: false,
      destinationPosture: 'create_new',
    },
    {
      capabilityRef: 'cap:local:write_file:append',
      reversibility: 'reversible',
      destructive: false,
      destinationPosture: 'named_existing',
    },
    {
      capabilityRef: 'cap:local:write_file:overwrite',
      reversibility: 'reversible',
      destructive: false,
      destinationPosture: 'named_existing',
    },
  ]);
});

test('write_file variant selection exactly mirrors append-over-mode runtime precedence', async () => {
  const observed = await observedWriteFileVariants();
  const base = { path: 'report.txt', content: 'content' };

  for (const [label, args, expected] of [
    ['explicit create', { ...base, mode: 'create', append: null }, 'create'],
    ['nullable create default', { ...base, mode: null, append: null }, 'create'],
    ['mode append', { ...base, mode: 'append', append: null }, 'append'],
    ['mode overwrite', { ...base, mode: 'overwrite', append: null }, 'overwrite'],
    ['append flag wins over create mode', { ...base, mode: 'create', append: true }, 'append'],
    ['append flag wins over overwrite mode', { ...base, mode: 'overwrite', append: true }, 'append'],
    ['false append flag wins over create mode', { ...base, mode: 'create', append: false }, 'overwrite'],
    ['false append flag wins over append mode', { ...base, mode: 'append', append: false }, 'overwrite'],
    ['omitted append preserves append mode', { ...base, mode: 'append' }, 'append'],
  ] as const) {
    const selected = exactMatch(observed.definitions, args);
    assert.equal(selected?.capabilityRef, `cap:local:write_file:${expected}`, label);
  }
});

test('unrecognized or malformed write modes never inherit local planning authority', async () => {
  const observed = await observedWriteFileVariants();
  const invalid = [
    null,
    { path: 'report.txt', content: 'content', mode: 'truncate', append: null },
    { path: 'report.txt', content: 'content', mode: undefined, append: null },
    { path: 'report.txt', content: 'content', mode: 'append', append: 'true' },
  ];

  for (const args of invalid) {
    assert.equal(exactMatch(observed.definitions, args), null, JSON.stringify(args));
  }
});
