/** Render real policy records inside a disposable home. No provider or model. */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-policy-provenance-'));
process.env.CLEMENTINE_HOME = home;
process.env.EMBEDDINGS_DISABLED = 'true';
const db = await import('./db.js');
const facts = await import('./facts.js');
const context = await import('../agents/harness-context.js');
beforeEach(() => db.resetMemoryDb());
after(() => { db.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
const ids = (text: string) => [...text.matchAll(/\[fact:(\d+)\]/g)].map(match => match[1]!);

test('short and shortened policy text expose exact identity without claiming use', () => {
  const short = { id: 31, content: 'Use the controlled mailbox for this sample.' };
  assert.equal(facts.presentPolicyText(short), '[fact:31] ' + short.content);
  const long = { id: 32, content: 'Keep this exact rule. '.repeat(90) };
  const displayed = facts.presentPolicyText(long);
  assert.match(displayed, /^\[fact:32\] Keep this exact rule\./);
  assert.match(displayed, /rule #32 shortened for display; memory_recall_all/);
  assert.ok(displayed.length <= facts.POLICY_LINE_MAX_CHARS + 120);
  assert.ok(!displayed.includes(long.content));
  assert.doesNotMatch(displayed, /recorded as used|applied successfully/i);
});

test('current corrected pins identify the rendered fact in core and variable context, never the predecessor', () => {
  const original = facts.rememberFact({ kind: 'feedback', content: 'For the controlled Cedar preference, use numbered prose.' });
  facts.setFactPinned(original.id, true);
  const corrected = facts.supersedeFact(original.id, { content: 'For the controlled Cedar preference, use a two-column table.' });
  assert.ok(corrected);
  facts.setFactPinned(corrected!.id, true);
  const core = facts.renderCorePoliciesForInstructions();
  assert.ok(core.text.includes(`[fact:${corrected!.id}] ${corrected!.content}`));
  assert.ok(!core.text.includes(original.content));
  assert.ok(!ids(core.text).includes(String(original.id)));
  assert.deepEqual(core.refs.map(ref => ref.id), ids(core.text));
  const variable = facts.renderFactsForInstructions(10, 2000);
  assert.ok(variable.includes(`[fact:${corrected!.id}] ${corrected!.content}`));
  assert.ok(!variable.includes(original.content));
  const packet = context.renderMemoryCore();
  const section = packet.manifest.find(entry => entry.section === 'Standing Policies');
  assert.ok(section?.refs.some(ref => ref.type === 'policy' && ref.id === String(corrected!.id)));
  assert.ok(!section?.refs.some(ref => ref.id === String(original.id)));
  assert.ok(packet.text.includes(`[fact:${corrected!.id}] ${corrected!.content}`));
  assert.equal(context.renderMemoryCore().sha256, packet.sha256, 'identity does not add clock or exposure noise');
});

test('provenance stays inside policy budgets and names only displayed rows', () => {
  const huge = facts.rememberFact({ kind: 'feedback', content: 'Keep a complete memo. '.repeat(160) });
  facts.setFactPinned(huge.id, true);
  const small = facts.rememberFact({ kind: 'feedback', content: 'Keep the sample digest brief.' });
  facts.setFactPinned(small.id, true);
  const core = facts.renderCorePoliciesForInstructions();
  assert.ok(core.text.includes(`[fact:${small.id}] ${small.content}`));
  assert.ok(!ids(core.text).includes(String(huge.id)));
  assert.ok(core.text.includes('more standing preference'));
  assert.deepEqual(core.refs.map(ref => ref.id), ids(core.text));
  const constrained = facts.renderFactsForInstructions(10, 200);
  assert.ok(constrained.length <= 300, 'identities cannot solve coverage by expanding the existing budget');
  assert.match(constrained, /Policy manifest:/);
});
