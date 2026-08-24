/** Run: node scripts/run-tests-isolated.mjs src/runtime/cli-inventory.test.ts
 *
 * A PROGRAM IS A CARRIER, NOT A CAPABILITY.
 *
 * The index records a local program as one row whose identifier is the bare
 * command — and, because the boot scan never executes anything, whose
 * description is empty. That row can say a binary exists. It cannot say the
 * binary can create a pull request, so an ask phrased in the user's own words
 * has nothing to match against and the capability is invisible on a machine
 * that demonstrably has it. Measured across 19 real programs: 8 of them hold
 * 235 subcommands behind 8 flat rows.
 *
 * These pins hold the closing of that gap, and the honesty constraints on it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-inventory-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-cli-inventory\n', 'utf8');

const {
  searchCapabilityOperations,
  capabilityInventoryState,
  listCapabilityOperationsForCarrier,
} = await import('../memory/capability-index.js');
const { indexDiscoveredClis, indexCliSubcommands } = await import('./local-capability-enumeration.js');

/** What the boot scan actually produces: a name, a path, and nothing else. */
function scanTheProgram(): void {
  indexDiscoveredClis([{ command: 'vcs', path: '/usr/local/bin/vcs', isLikelyCli: true }]);
}

const SUBCOMMANDS = [
  { name: 'clone', description: 'Clone a repository into a new directory' },
  { name: 'commit', description: 'Record changes to the repository' },
  { name: 'push', description: 'Update remote refs along with associated objects' },
];

test('a scanned program alone cannot answer an ask about what it does', () => {
  scanTheProgram();
  const hits = searchCapabilityOperations('clone a repository', { limit: 5 });
  assert.equal(
    hits.some((hit) => hit.carrier === 'vcs'),
    false,
    'precondition: the flat row has no description, so nothing matches',
  );
});

test('its subcommands become capabilities an ask can reach', () => {
  const recorded = indexCliSubcommands('vcs', SUBCOMMANDS);
  assert.equal(recorded, 3);
  const hits = searchCapabilityOperations('clone a repository', { limit: 5 });
  const found = hits.find((hit) => hit.identifier === 'vcs clone');
  assert.ok(found, `the capability must now be reachable: ${hits.map((h) => h.identifier).join(',')}`);
  assert.equal(found.carrier, 'vcs', 'the program remains the carrier');
});

test('the identifier is the invocation, and it records what selected it', () => {
  // The local lane runs a command string, so the invocation is the only
  // identity worth binding to; parent and selector keep the relationship.
  const rows = listCapabilityOperationsForCarrier('cli', 'vcs');
  const push = rows.find((row) => row.identifier === 'vcs push');
  assert.ok(push, 'the invocation is the identifier');
  assert.equal(push.parentIdentifier, 'vcs');
  assert.equal(push.selector, 'push');
});

test('effect stays unknown — a blurb is not evidence', () => {
  // "Update remote refs" reads like a write, and guessing that from prose is
  // exactly how a delete once proved read-only. The effect gate decides at
  // dispatch, where an argv exists.
  const rows = listCapabilityOperationsForCarrier('cli', 'vcs');
  for (const row of rows.filter((entry) => entry.selector)) {
    assert.equal(row.effectClass, 'unknown', `${row.identifier} must not claim an effect`);
    assert.equal(row.effectProvenance, 'none');
  }
});

test('the program row survives — expansion adds, it does not replace', () => {
  const rows = listCapabilityOperationsForCarrier('cli', 'vcs');
  assert.ok(rows.some((row) => row.identifier === 'vcs' && !row.selector), 'the carrier row is still there');
});

test('CAT-7 for MCP — a connected server is not a decorative carrier', async () => {
  // Measured before this landed: 4 MCP operations catalogued, 3 with a known
  // effect, ZERO with a resolvable schema. Under CAT-8 that is a decorative
  // carrier — the user sees a connected server and the executor sees nothing
  // it can bind. The server published the schema in the same listTools
  // response that named the tool; we simply threw it away.
  const { indexMcpServerTools } = await import('./local-capability-enumeration.js');
  const { loadToolContract } = await import('../tools/tool-contract-store.js');

  indexMcpServerTools('records', [
    {
      name: 'records__list_items',
      description: 'List the items in a collection.',
      inputSchema: { type: 'object', required: ['collection'], properties: { collection: { type: 'string' } } },
    },
    // A server that publishes no schema for a tool must not break the rest.
    { name: 'records__undocumented', description: 'No schema published.' },
  ]);
  // The deposit is fire-and-forget and its first call cold-loads the schema
  // module, which outlives a handful of microtask ticks. Poll instead of
  // guessing a tick count — a fixed sleep here would be flaky on a loaded box.
  for (let i = 0; i < 100 && !loadToolContract('records__list_items'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const contract = loadToolContract('records__list_items');
  assert.ok(contract?.schema, 'the published schema must be durably resolvable, not discarded');
  assert.ok(!loadToolContract('records__undocumented')?.schema, 'and absence stays absence');
});

test('the expander is REACHED from the one place a bind definitively failed', async () => {
  // A capability nothing calls is worse than no capability: it passes its own
  // pins and changes nothing. This asserts the connection, in the same shape as
  // the two-teeth parity pin in conversation-short-circuit.test.ts.
  //
  // The site matters as much as the fact. It must be the dispatcher's unbound
  // stop — reached once, after a participated turn is known to have failed —
  // and NOT the binder, which is a pure selector run more than once per turn
  // and called directly by tests.
  const { readFileSync } = await import('node:fs');
  const dispatch = readFileSync(
    new URL('./semantic-boundary/typed-source-dispatch.ts', import.meta.url), 'utf-8',
  );
  assert.match(
    dispatch, /scheduleCliInventoryExpansion\(/,
    'the dispatcher must reach the expander when a participated turn cannot bind',
  );
  const binder = readFileSync(
    new URL('./semantic-boundary/host-bind-operations.ts', import.meta.url), 'utf-8',
  );
  assert.doesNotMatch(
    binder, /scheduleCliInventoryExpansion/,
    'the pure selector must stay free of this side effect',
  );
});

test('asking is recorded so it happens once, including when there is nothing', () => {
  assert.equal(capabilityInventoryState('vcs'), 'expanded');

  indexDiscoveredClis([
    { command: 'vcs', path: '/usr/local/bin/vcs', isLikelyCli: true },
    { command: 'plainly', path: '/usr/local/bin/plainly', isLikelyCli: true },
  ]);
  assert.equal(capabilityInventoryState('plainly'), null, 'never asked yet');
  // A flag-driven program genuinely has none. Recording that is what stops it
  // being re-probed forever — "asked, and there was nothing" is a real answer.
  indexCliSubcommands('plainly', []);
  assert.equal(capabilityInventoryState('plainly'), 'none');
});
