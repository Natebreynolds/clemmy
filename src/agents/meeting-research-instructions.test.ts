import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-research-instructions-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_EMBEDDINGS = 'off';
const { resetMemoryDb, closeMemoryDb, openMemoryDb } = await import('../memory/db.js');
const { rememberFact, setFactPinned, renderCorePoliciesForInstructions } = await import('../memory/facts.js');
const { withMemoryReadScope } = await import('../memory/memory-scope.js');
const { harnessInstructions, renderHarnessMemoryContext, memoryTailScopeFor } = await import('./harness-context.js');
const { saveUserProfile } = await import('../runtime/user-profile.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const { createFocus } = await import('../memory/focus.js');
const { checkpointWorkingMemory } = await import('../memory/working-memory.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { SOUL_FILE, IDENTITY_FILE, MEMORY_FILE, WORKING_MEMORY_FILE } = await import('../memory/vault.js');
test.after(() => { closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

test('evidence-only instructions exclude ordinary private context while retaining the disclosed standing profile and no memory tail', () => {
  resetMemoryDb();
  for (const [file, sentinel] of [[SOUL_FILE, 'PRIVATE_SOUL_SENTINEL'], [IDENTITY_FILE, 'PRIVATE_IDENTITY_SENTINEL'],
    [MEMORY_FILE, 'PRIVATE_VAULT_SENTINEL'], [WORKING_MEMORY_FILE, 'PRIVATE_GLOBAL_WORKING_SENTINEL']]) {
    mkdirSync(path.dirname(file!), { recursive: true }); writeFileSync(file!, `# Fixture\n${sentinel}\n`);
  }
  saveUserProfile({ displayName: 'PRIVATE_PROFILE_SENTINEL', notes: 'PRIVATE_PROFILE_NOTES_SENTINEL' });
  saveProactivityPolicy({ autoApproveScope: 'strict' });
  const core = rememberFact({ kind: 'user', content: 'The owner has PRIVATE_CORE_PROFILE_SENTINEL as their business role.' });
  setFactPinned(core.id, true);
  rememberFact({ kind: 'project', content: 'The selected launch date is PRIVATE_ORDINARY_FACT_SENTINEL.' });
  const session = createSession({ id: 'meeting-research-private-context', kind: 'chat', userId: 'fixture-owner' });
  createFocus({ resourceRef: `session:${session.id}`, resourceKind: 'thread', relatedSessionId: session.id,
    title: 'PRIVATE_FOCUS_SENTINEL', summary: 'PRIVATE_FOCUS_SUMMARY_SENTINEL' });
  checkpointWorkingMemory(session.id, { turn: 1, toolCallsTotal: 0, lastText: 'PRIVATE_SESSION_WORKING_SENTINEL' });
  const normal = renderHarnessMemoryContext({ sessionId: session.id, focusInput: 'PRIVATE launch date', partition: 'all' });
  for (const sentinel of ['PRIVATE_PROFILE_SENTINEL', 'PRIVATE_CORE_PROFILE_SENTINEL', 'PRIVATE_VAULT_SENTINEL',
    'PRIVATE_SOUL_SENTINEL', 'PRIVATE_IDENTITY_SENTINEL', 'PRIVATE_FOCUS_SENTINEL', 'PRIVATE_SESSION_WORKING_SENTINEL']) {
    assert.ok(normal.includes(sentinel), `control setup must expose ${sentinel} through ordinary context`);
  }
  const instructions = harnessInstructions('UNCHANGED CLEM RUBRIC SENTINEL', { evidenceOnly: true, sessionId: session.id,
    focusInput: 'PRIVATE launch date', volatileMemoryInstructions: 'PRIVATE_VOLATILE_MEMORY_SENTINEL',
    agentInstructions: 'PRIVATE_AGENT_CONTEXT_SENTINEL' });
  const rendered = instructions();
  assert.match(rendered, /UNCHANGED CLEM RUBRIC SENTINEL/);
  assert.match(rendered, /ASK MODE/);
  assert.match(rendered, /PRIVATE_CORE_PROFILE_SENTINEL/, 'saved standing profile is explicitly disclosed as always applicable');
  for (const sentinel of ['PRIVATE_PROFILE_SENTINEL', 'PRIVATE_PROFILE_NOTES_SENTINEL', 'PRIVATE_VAULT_SENTINEL',
    'PRIVATE_SOUL_SENTINEL', 'PRIVATE_IDENTITY_SENTINEL', 'PRIVATE_FOCUS_SENTINEL', 'PRIVATE_FOCUS_SUMMARY_SENTINEL',
    'PRIVATE_SESSION_WORKING_SENTINEL', 'PRIVATE_GLOBAL_WORKING_SENTINEL', 'PRIVATE_ORDINARY_FACT_SENTINEL',
    'PRIVATE_VOLATILE_MEMORY_SENTINEL', 'PRIVATE_AGENT_CONTEXT_SENTINEL']) assert.ok(!rendered.includes(sentinel), sentinel);
  assert.equal(memoryTailScopeFor(instructions), undefined, 'a skipped ranker must not rebuild an unscoped memory tail');
});

test('evidence-only instructions preserve every global policy including legacy user-kind instructions, but exclude project/agent rules', () => {
  resetMemoryDb();
  const global = rememberFact({ kind: 'constraint', content: 'Always mark uncertain meeting answers with GLOBAL_STANDING_POLICY_SENTINEL.' });
  const preference = rememberFact({ kind: 'feedback', content: 'Lead meeting responses with GLOBAL_STANDING_PREFERENCE_SENTINEL.' });
  setFactPinned(preference.id, true);
  rememberFact({ kind: 'constraint', content: 'For this project use PRIVATE_PROJECT_POLICY_SENTINEL.', scope: { projectId: 'private-project', agentKey: null } });
  rememberFact({ kind: 'constraint', content: 'For this agent use PRIVATE_AGENT_POLICY_SENTINEL.', scope: { projectId: null, agentKey: 'private-agent@1' } });
  const core = rememberFact({ kind: 'user', content: 'PRIVATE_CORE_PROFILE_SENTINEL is the owner employer.' }); setFactPinned(core.id, true);
  const legacyInstruction = rememberFact({ kind: 'user', content: 'Always begin meeting answers with LEGACY_USER_STANDING_INSTRUCTION_SENTINEL.' });
  setFactPinned(legacyInstruction.id, true);
  const normal = withMemoryReadScope('unrestricted', () => renderCorePoliciesForInstructions());
  assert.ok(normal.text.includes('PRIVATE_CORE_PROFILE_SENTINEL'), 'ordinary default still includes core profile');
  assert.ok(normal.text.includes('PRIVATE_PROJECT_POLICY_SENTINEL'));
  const rendered = withMemoryReadScope({ projectId: 'private-project', agentKey: 'private-agent@1' }, () =>
    harnessInstructions('CLEM ROLE', { evidenceOnly: true })());
  assert.ok(rendered.includes(global.content)); assert.ok(rendered.includes(preference.content));
  assert.ok(rendered.includes(core.content)); assert.ok(rendered.includes(legacyInstruction.content));
  assert.doesNotMatch(rendered, /PRIVATE_PROJECT_POLICY_SENTINEL|PRIVATE_AGENT_POLICY_SENTINEL/);
});

test('evidence-only instructions refuse unreadable policies while ordinary context retains its existing fallback', () => {
  resetMemoryDb(); rememberFact({ kind: 'constraint', content: 'Preserve GLOBAL_RULE_ON_FILE_SENTINEL in every answer.' });
  openMemoryDb().exec('ALTER TABLE memory_policies RENAME TO unavailable_memory_policies');
  assert.throws(() => harnessInstructions('CLEM ROLE', { evidenceOnly: true }), /memory_policies|no such table/);
  assert.doesNotThrow(() => renderCorePoliciesForInstructions(), 'ordinary policy fallback remains unchanged');
  resetMemoryDb();
});

test('evidence-only instructions cannot broaden project policy when the scope store is unreadable', () => {
  resetMemoryDb();
  rememberFact({ kind: 'constraint', content: 'GLOBAL_SCOPE_CHECK_SENTINEL applies everywhere.' });
  rememberFact({ kind: 'constraint', content: 'PRIVATE_SCOPE_LOSS_SENTINEL belongs to this project only.', scope: { projectId: 'private-project', agentKey: null } });
  openMemoryDb().exec('ALTER TABLE memory_scopes RENAME COLUMN scope_project_id TO unavailable_scope_project_id');
  closeMemoryDb();
  assert.throws(() => harnessInstructions('CLEM ROLE', { evidenceOnly: true }), /scope_project_id|no such column/);
  resetMemoryDb();
});
