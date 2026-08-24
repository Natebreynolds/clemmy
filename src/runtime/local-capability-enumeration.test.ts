/** Run: node scripts/run-tests-isolated.mjs src/runtime/local-capability-enumeration.test.ts
 *
 * Local carriers (MCP servers, CLI programs) land in the same connect-time
 * index as remote ones, with effect provenance that tells the truth: a server's
 * own annotation is `declared`, verb evidence is `inferred`, and a binary with
 * no per-operation signal stays `unknown` rather than being guessed at.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-capability-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-local-capability\n', 'utf8');

const { indexMcpServerTools, indexDiscoveredClis } = await import('./local-capability-enumeration.js');
const { recordDeclaredMcpToolEffect, _resetDeclaredMcpToolEffectsForTest } = await import('./mcp-declared-effects.js');
const { searchCapabilityOperations, listCapabilityOperationsForCarrier } = await import('../memory/capability-index.js');

test('an MCP server\'s own annotation is recorded as DECLARED provenance', () => {
  _resetDeclaredMcpToolEffectsForTest();
  recordDeclaredMcpToolEffect('mcp__tracker__issues', { readOnlyHint: true });
  recordDeclaredMcpToolEffect('mcp__tracker__purge_project', { destructiveHint: true });
  const recorded = indexMcpServerTools('tracker', [
    { name: 'mcp__tracker__issues', description: '[tracker] List issues in a project.' },
    { name: 'mcp__tracker__purge_project', description: '[tracker] Permanently remove a project.' },
    { name: 'mcp__tracker__update_issue', description: '[tracker] Update an issue field.' },
  ]);
  assert.equal(recorded, 3);

  const rows = listCapabilityOperationsForCarrier('mcp', 'tracker');
  const issues = rows.find((row) => row.identifier === 'mcp__tracker__issues');
  assert.equal(issues?.effectClass, 'read');
  assert.equal(issues?.effectProvenance, 'declared', 'the server said so');
  assert.equal(issues?.description, 'List issues in a project.', 'the shim carrier prefix is stripped');
  assert.equal(issues?.displayName, 'issues');

  const purge = rows.find((row) => row.identifier === 'mcp__tracker__purge_project');
  assert.equal(purge?.effectClass, 'write');
  assert.equal(purge?.effectProvenance, 'declared');

  // No annotation ⇒ verb evidence from the OPERATION.
  const update = rows.find((row) => row.identifier === 'mcp__tracker__update_issue');
  assert.equal(update?.effectClass, 'write');
  assert.equal(update?.effectProvenance, 'inferred');
  _resetDeclaredMcpToolEffectsForTest();
});

test('a read verb in the SERVER name never classifies its tools (index mirrors the dispatch rule)', () => {
  indexMcpServerTools('list-monk', [
    { name: 'mcp__list-monk__unsubscribe', description: 'Remove a subscriber from a list.' },
  ]);
  const row = listCapabilityOperationsForCarrier('mcp', 'list-monk')[0];
  assert.notEqual(row?.effectClass, 'read', 'the server name is not evidence');
  assert.equal(row?.effectProvenance, 'none');
});

test('a discovered CLI is indexed and stays honestly unknown', () => {
  const recorded = indexDiscoveredClis([
    { command: 'gh', path: '/usr/local/bin/gh', isLikelyCli: true, version: 'gh version 2.60', helpHead: 'Work seamlessly with GitHub from the command line.' },
    { command: 'sf', path: '/usr/local/bin/sf', isLikelyCli: true, version: 'sf 2.0', helpHead: 'Salesforce CLI.' },
    { command: 'not-a-cli', path: '/usr/bin/not-a-cli', isLikelyCli: false },
  ]);
  assert.equal(recorded, 2, 'only likely CLIs are indexed');
  const hits = searchCapabilityOperations('github command line');
  assert.ok(hits.some((hit) => hit.identifier === 'gh'), 'a CLI is retrievable by what its help says');
  const gh = hits.find((hit) => hit.identifier === 'gh');
  assert.equal(gh?.effectClass, 'unknown', 'a binary has no per-operation effect until argv exists');
  assert.equal(gh?.carrierKind, 'cli');
});

test('a CLI that left $PATH stops being a capability on the next scan', () => {
  indexDiscoveredClis([
    { command: 'gh', path: '/usr/local/bin/gh', isLikelyCli: true, helpHead: 'Work seamlessly with GitHub from the command line.' },
  ]);
  assert.deepEqual(
    searchCapabilityOperations('salesforce').filter((hit) => hit.identifier === 'sf'),
    [],
    'an uninstalled CLI is no longer offered',
  );
  assert.ok(searchCapabilityOperations('github command line').some((hit) => hit.identifier === 'gh'));
});
