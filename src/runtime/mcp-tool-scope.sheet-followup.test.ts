/**
 * Run: npx tsx --test src/runtime/mcp-tool-scope.sheet-followup.test.ts
 *
 * Regression pins for the 2026-08-26 gauntlet break (B1 feeder a): the
 * keyword-family scoper missed bare "sheet"-family phrasings and a follow-up
 * containing "append" was classified as a local-context turn, zeroing the
 * external surface mid-task. Contract under pin:
 *   1. Bare-noun sheet phrasings scope the google-sheets family.
 *   2. An unmatched keyword family never zeroes a turn (fail-open persists).
 *   3. A local-context follow-up during an external-family task inherits the
 *      prior turn's family surface instead of stripping it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-scope-sheet-followup-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  resolveMcpToolScope,
  resolveMcpToolScopeWithContinuity,
} = await import('./mcp-tool-scope.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('bare "sheet" phrasings scope the google-sheets family (gauntlet S2/S3 shapes)', () => {
  for (const input of [
    'make me a google sheet called Gauntlet Sheet with a header row Scenario, Result',
    'add a row to the gauntlet sheet',
    'add a row to the sheet for scenario two',
    'put the results into new spreadsheets, one per region',
  ]) {
    const scope = resolveMcpToolScope({ userInput: input });
    assert.ok(
      (scope.allowedServerSlugs ?? []).includes('googlesheets'),
      `expected google-sheets family for "${input}" — got: ${scope.reason}`,
    );
    assert.ok((scope.maxTools ?? 0) > 0, `expected a non-zero surface for "${input}"`);
  }
});

test('an append/row task continuation must not zero the external surface', () => {
  const scope = resolveMcpToolScope({
    userInput: 'use the first tab, append after the last row',
  });
  assert.notEqual(
    scope.maxTools,
    0,
    `artifact-noun heuristics may never zero an external-write continuation — got: ${scope.reason}`,
  );
});

test('a local-context follow-up during an external-family task inherits that family surface', () => {
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'append the remaining rows from the report we just ran',
    priorUserInputs: ['add these rows to the google sheet called Gauntlet'],
  });
  assert.ok(
    (scope.allowedServerSlugs ?? []).includes('googlesheets'),
    `expected the inherited google-sheets surface — got: ${scope.reason}`,
  );
  assert.ok((scope.maxTools ?? 0) > 0, 'inherited family surface must be non-zero');
});

test('a genuinely local follow-up with no external family anywhere keeps its no-tool discipline', () => {
  const direct = resolveMcpToolScope({
    userInput: 'update the local markdown report from the existing context',
  });
  assert.equal(direct.maxTools, 0, direct.reason);
  const inherited = resolveMcpToolScopeWithContinuity({
    userInput: 'update the local markdown report from the existing context',
    priorUserInputs: ['summarize what we learned yesterday'],
  });
  assert.equal(inherited.maxTools, 0, inherited.reason);
});
