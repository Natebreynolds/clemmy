/**
 * Run: npx tsx --test src/memory/salesforce-deal-risk-workspace-skill.test.ts
 *
 * Contract test for the deal-risk Workspace skill (skills/
 * salesforce-deal-risk-workspace) — the capability that lets Clementine BUILD or
 * EDIT a Salesforce deal-risk workspace herself (concrete-evidence "why",
 * read-only). Locks the defining requirements, discoverability, and that the
 * bundled reference runner stays valid, read-only JS so a future edit can't
 * silently hollow the capability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_DIR = fileURLToPath(new URL('../../skills/salesforce-deal-risk-workspace/', import.meta.url));
const SKILL_MD = readFileSync(SKILL_DIR + 'SKILL.md', 'utf8');
const RUNNER_PATH = SKILL_DIR + 'src/refresh.reference.mjs';
const RUNNER = readFileSync(RUNNER_PATH, 'utf8');

test('frontmatter: name + matching keywords', () => {
  assert.match(SKILL_MD, /^---\nname: salesforce-deal-risk-workspace\n/);
  const desc = SKILL_MD.slice(0, SKILL_MD.indexOf('\n---\n', 4)).toLowerCase();
  for (const kw of ['deal risk', 'pipeline', 'salesforce', 'read-only', 'workspace']) {
    assert.ok(desc.includes(kw), `description should mention "${kw}"`);
  }
});

test('body: the defining requirements are all stated', () => {
  const body = SKILL_MD.toLowerCase();
  assert.ok(/read-only/.test(body) && /(never|not)\b[^.]*\b(update|create|delete|modif|mutat)/.test(body), 'read-only contract');
  // concrete, evidence-based "why" (the whole point of this skill)
  assert.ok(/why/.test(body) && /concrete/.test(body), 'evidence-based why');
  for (const sig of ['email', 'next step', 'notes', 'age']) {
    assert.ok(body.includes(sig), `why must reference "${sig}" as a concrete signal`);
  }
  assert.ok(/runtime/.test(body) && /never hardcode/.test(body), 'runtime resolution / no hardcoded IDs');
  assert.ok(/traces to/.test(body) && /never invent|never fabricat|honest/.test(body), 'grounded-figures / no fabrication');
});

test('skill is discoverable in the repo via the real skill-store', async () => {
  const { discoverSkillsInRepo } = await import('./skill-store.js');
  const found = discoverSkillsInRepo(REPO_ROOT, 'repo');
  assert.ok(found.some((f) => f.installName === 'salesforce-deal-risk-workspace'), 'must be discoverable');
});

test('bundled reference runner: valid JS, read-only, runtime-resolved', () => {
  // Must parse (a broken template is worse than none).
  execFileSync('node', ['--check', RUNNER_PATH], { stdio: 'pipe' });
  // Read-only contract: only SELECT SOQL, and the canonical write-verbs must be absent.
  assert.ok(/IsClosed = false/.test(RUNNER), 'pulls OPEN opportunities');
  assert.ok(/SELECT /.test(RUNNER), 'uses SELECT queries');
  assert.ok(!/\b(UPDATE|INSERT|DELETE|upsert|data update|data create|data delete)\b/i.test(RUNNER), 'no mutating SF operations');
  // Concrete-evidence signals are actually computed.
  for (const f of ['NextStep', 'TaskSubtype', 'daysSinceEmail', 'ContentDocumentLink', 'ageDays']) {
    assert.ok(RUNNER.includes(f), `reference runner should compute "${f}"`);
  }
  // Runtime resolution (a name slot, not a hardcoded Id).
  assert.ok(/const TEAM_LEAD = /.test(RUNNER) && !/'00[A-Za-z0-9]{15,16}'/.test(RUNNER), 'resolves the lead by name, no hardcoded Id');
});
