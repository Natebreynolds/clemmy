import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_REGISTRY } from './tool-registry.js';

/**
 * A capability the owner can ask for in chat has to be reachable from chat.
 *
 * `lanes` decides which catalogs a tool appears in, and the orchestrator lane is
 * the one chat searches. A tool missing from it is not merely hidden — asked for
 * it, the model cannot find it and cannot learn that it exists, so it improvises.
 * Live 2026-09-21, "run the memory embed backfill for facts please" spent 301
 * seconds and 70 tool calls walking the filesystem with list_files, read_file and
 * local_cli_probe, and never reached a terminal. An absent capability does not
 * refuse; it flails, and that is a dead end with a long tail.
 *
 * This pins the memory tools an owner plausibly names out loud. It deliberately
 * does NOT assert that every cli tool is orchestrator-reachable: some are
 * genuinely operator-only (memory_import ingests another agent's store), and a
 * blanket rule would force those open to make the test pass, which is the
 * opposite of the point.
 */
const ASKABLE_IN_CHAT = [
  'memory_embed_backfill',
  'memory_forget',
  'memory_pin',
  'memory_list_facts',
  'memory_read',
  'memory_recall',
];

test('memory tools an owner can ask for by name are reachable from chat', () => {
  for (const name of ASKABLE_IN_CHAT) {
    const entry = TOOL_REGISTRY.find((tool) => tool.name === name);
    assert.ok(entry, `${name} is missing from the registry`);
    assert.ok(
      entry.lanes.includes('orchestrator'),
      `${name} has lanes [${entry.lanes.join(', ')}] and so cannot be found from chat. `
      + 'Either add the orchestrator lane, or remove it from this list because it is '
      + 'genuinely operator-only — but do not leave it askable and unreachable.',
    );
  }
});
