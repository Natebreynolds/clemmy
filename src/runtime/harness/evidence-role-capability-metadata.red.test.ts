/**
 * Run: npx tsx --test src/runtime/harness/evidence-role-capability-metadata.red.test.ts
 *
 * RED PIN — evidence roles/modes derive from registered capability metadata,
 * never from tool-slug token lists.
 *
 * Safety classification may stay conservative (guarded below), but the
 * SEMANTIC evidence classification of an operation must follow what is
 * registered/proven about the capability. Today both layers token-match the
 * name: a registered/proven READ capability whose slug happens to contain a
 * write token (X_POST_SUMMARY_FETCH) is classified an irreversible external
 * send, and a registered REVERSIBLE write whose name contains a send token is
 * given 'send' evidence semantics. These tests fail until derivation is
 * metadata-first.
 *
 * GUARD (must stay green): the shell carrier's conservative SAFETY class is
 * not loosened by the role work — an unprovable shell command remains
 * 'compute' for mutation safety, proven local mutation remains 'local_write',
 * and a network publish remains 'external_write'.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-evidence-role-metadata-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-evidence-role\n', 'utf8');

const { classifyRuntimeToolEffect } = await import('./tool-effect.js');
const { operationEvidenceContract } = await import('../graph/operation-evidence-contract.js');
const { isReadOnlyCompletionEvidence } = await import('./tool-evidence.js');
const { rememberToolChoice } = await import('../../memory/tool-choice-store.js');
const { closeEventLog } = await import('./eventlog.js');

test.after(() => {
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** The misleading-name read: a provider fetch whose slug contains POST because
 * the RESOURCE is a post. Registered/proven metadata says it is a read. */
const MISLEADING_READ_SLUG = 'X_POST_SUMMARY_FETCH';

function registerProvenReadCapability(): void {
  rememberToolChoice({
    intent: 'x post engagement summary lookup',
    description: 'Fetch the engagement summary for one existing X post (read-only).',
    choice: {
      kind: 'composio',
      identifier: MISLEADING_READ_SLUG,
      testEvidence: 'verified read: returned 200 with the summary payload; nothing was created or sent',
    },
  });
}

test('learned free-text tool memory cannot grant read evidence authority', () => {
  // A proven read whose slug carries NO read token and a misleading write
  // token: the resource is a channel post; the operation is a snapshot read.
  const slug = 'SLACK_CHANNEL_POST_SNAPSHOT';
  rememberToolChoice({
    intent: 'slack channel post snapshot lookup',
    description: 'Read a snapshot of one existing channel post (read-only).',
    choice: {
      kind: 'composio',
      identifier: slug,
      testEvidence: 'verified read: returned 200 with the snapshot payload; nothing was created or sent',
    },
  });
  assert.equal(
    isReadOnlyCompletionEvidence(slug),
    false,
    'a remembered description/testEvidence string is an optimization, not trusted effect authority',
  );
});

test('learned free-text tool memory cannot relabel a runtime effect', () => {
  registerProvenReadCapability();
  // The production chain: the runtime effect feeds the operation evidence
  // contract. Chained exactly as the resolution ledger does it.
  const decision = classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: MISLEADING_READ_SLUG,
    arguments: { post_id: '1785009911' },
  });
  const contract = operationEvidenceContract({
    resolvedTool: MISLEADING_READ_SLUG,
    effectKind: decision.effect,
    reversibility: 'irreversible',
  });
  assert.notEqual(
    contract.mode,
    'point_read',
    'procedural memory may help rediscover a tool, but cannot relabel current runtime evidence',
  );
});

test('a reversible registered write with a send token in its name is not given send evidence semantics', () => {
  // Registered metadata: reversible local write. The name carries BROADCAST
  // only because of the resource it touches. Send-class evidence obligations
  // (irreversible dispatch proof) must come from registered irreversibility,
  // never from a name token.
  const contract = operationEvidenceContract({
    resolvedTool: 'timeline_broadcast_notes_update',
    effectKind: 'local_write',
    reversibility: 'reversible',
  });
  assert.notEqual(
    contract.mode,
    'send',
    'a reversible registered write must not inherit send semantics from a name token',
  );
});

// ── GUARD: conservative mutation-safety classification stays exactly as-is ──

test('GUARD: shell carrier safety stays conservative — compute unless proven otherwise', () => {
  const compute = classifyRuntimeToolEffect('run_shell_command', { command: 'jq -r ".[].id" leads.json' });
  assert.deepEqual(
    compute,
    { effect: 'compute', mutating: false, dangerousWrite: false, source: 'shell' },
    'an unprovable shell command remains compute for mutation safety',
  );

  const localWrite = classifyRuntimeToolEffect('run_shell_command', { command: 'rm -rf build' });
  assert.equal(localWrite.effect, 'local_write', 'a proven local mutation stays local_write');
  assert.equal(localWrite.mutating, true);

  const externalWrite = classifyRuntimeToolEffect('run_shell_command', {
    command: 'curl -X POST https://api.example.com/send -d @payload.json',
  });
  assert.equal(externalWrite.effect, 'external_write', 'a network mutation stays external_write');
  assert.equal(externalWrite.dangerousWrite, true, 'the mass-send halt ladder still sees it');
});
