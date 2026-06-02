/**
 * Run: npx tsx --test src/runtime/skill-update.test.ts
 *
 * Integration coverage for the skill update-check pipeline:
 *   - checkAllSkillUpdates dedupes the remote call by repo (a bundled
 *     repo with N skills costs ONE network call, not N).
 *   - the result is persisted into each skill's .clementine-source.json
 *     so the dashboard badge survives a reload.
 *   - identical shas leave updateAvailable false.
 *
 * Uses a throwaway CLEMENTINE_HOME so it never touches the real install,
 * and injects a fake remote-sha resolver so it runs offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set BEFORE config.ts (transitively imported below) reads it.
const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-update-test-'));
process.env.CLEMENTINE_HOME = home;

const { installSkillFromDir, loadSkill, recordSkillUpdateCheck, SKILLS_DIR } =
  await import('../memory/skill-store.js');
const { checkAllSkillUpdates } = await import('../runtime/skill-installer.js');

function makeSourceDir(name: string, body = 'body'): string {
  const dir = path.join(home, 'src', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n${body}\n`,
    'utf-8',
  );
  return dir;
}

function readSourceMeta(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(SKILLS_DIR, name, '.clementine-source.json'), 'utf-8'));
}

test('checkAllSkillUpdates: dedupes remote call per repo + flags + persists', async () => {
  const repo = 'https://github.com/acme/bundle.git';
  // Two skills from the SAME repo, installed at sha "old".
  installSkillFromDir(makeSourceDir('alpha'), 'alpha', { repo, pathInRepo: 'skills/alpha', sha: 'old' });
  installSkillFromDir(makeSourceDir('beta'), 'beta', { repo, pathInRepo: 'skills/beta', sha: 'old' });

  const callsByRepo = new Map<string, number>();
  const summary = await checkAllSkillUpdates(async (r) => {
    callsByRepo.set(r, (callsByRepo.get(r) ?? 0) + 1);
    return 'newsha';
  });

  // One network call for the shared repo, not two.
  assert.equal(callsByRepo.get(repo), 1);

  // Both skills flagged.
  assert.deepEqual(summary.updatesAvailable.sort(), ['alpha', 'beta']);

  // Persisted to disk so the badge survives reload.
  const alphaMeta = readSourceMeta('alpha');
  assert.equal(alphaMeta.updateAvailable, true);
  assert.equal(alphaMeta.latestRemoteSha, 'newsha');
  assert.equal(typeof alphaMeta.lastCheckedAt, 'string');
  // Install provenance is preserved (not clobbered by the check).
  assert.equal(alphaMeta.repo, repo);
  assert.equal(alphaMeta.sha, 'old');

  // loadSkill surfaces the flag through the Skill.source the API returns.
  assert.equal(loadSkill('alpha')?.source?.updateAvailable, true);
});

test('checkAllSkillUpdates: identical sha leaves updateAvailable false', async () => {
  const repo = 'https://github.com/acme/single.git';
  installSkillFromDir(makeSourceDir('gamma'), 'gamma', { repo, pathInRepo: '', sha: 'samesha' });

  const summary = await checkAllSkillUpdates(async () => 'samesha');
  assert.ok(!summary.updatesAvailable.includes('gamma'));
  assert.equal(readSourceMeta('gamma').updateAvailable, false);
});

test('checkAllSkillUpdates: unreachable remote → no false update + error noted', async () => {
  const repo = 'https://github.com/acme/offline.git';
  installSkillFromDir(makeSourceDir('delta'), 'delta', { repo, pathInRepo: '', sha: 'old' });

  const summary = await checkAllSkillUpdates(async () => undefined);
  const delta = summary.results.find((r) => r.name === 'delta');
  assert.equal(delta?.updateAvailable, false);
  assert.ok(delta?.error);
  // Unreachable is "unknown", not "up to date": we must NOT invent a
  // false update, and (no prior verdict here) we must not write one.
  assert.ok(!readSourceMeta('delta').updateAvailable);
  // But lastCheckedAt is always stamped.
  assert.equal(typeof readSourceMeta('delta').lastCheckedAt, 'string');
});

test('checkAllSkillUpdates: a transient failed check does NOT clobber a previously-detected update', async () => {
  const repo = 'https://github.com/acme/flaky.git';
  installSkillFromDir(makeSourceDir('epsilon'), 'epsilon', { repo, pathInRepo: '', sha: 'old' });

  // 1) Successful check detects an update.
  await checkAllSkillUpdates(async () => 'newsha');
  assert.equal(readSourceMeta('epsilon').updateAvailable, true);
  assert.equal(readSourceMeta('epsilon').latestRemoteSha, 'newsha');

  // 2) A later check can't reach the remote (offline). The badge must
  //    survive — don't erase a real pending update on a transient blip.
  await checkAllSkillUpdates(async () => undefined);
  assert.equal(readSourceMeta('epsilon').updateAvailable, true);
  assert.equal(readSourceMeta('epsilon').latestRemoteSha, 'newsha');

  // 3) A successful check showing the upstream matches again clears it.
  await checkAllSkillUpdates(async () => 'old');
  assert.equal(readSourceMeta('epsilon').updateAvailable, false);
});

test('recordSkillUpdateCheck: no-op for a skill with no source file', () => {
  // A manually dropped-in skill (no .clementine-source.json) shouldn't
  // gain one from a check — nothing to compare against upstream.
  const dir = path.join(SKILLS_DIR, 'manual');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: manual\ndescription: m\n---\nbody\n', 'utf-8');
  recordSkillUpdateCheck('manual', { latestRemoteSha: 'x', updateAvailable: true, lastCheckedAt: 'now' });
  assert.equal(loadSkill('manual')?.source, undefined);
});

test.after(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
});
