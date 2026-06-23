/**
 * Run: npx tsx --test src/memory/client-seo-report-skill.test.ts
 *
 * Contract test for the flagship trust job authored as a skill
 * (skills/client-seo-report). The goal-fidelity + numeric/output-
 * grounding gates only have teeth on this job when the skill is present AND its
 * DEFINING REQUIREMENTS are stated (read-only · every figure traceable · honest
 * partial · runtime client discovery). This locks those so a future edit can't
 * silently hollow the contract, and confirms the repo skill is discoverable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_MD = readFileSync(fileURLToPath(new URL('../../skills/client-seo-report/SKILL.md', import.meta.url)), 'utf8');

test('skill frontmatter: name + discovery keywords present', () => {
  assert.match(SKILL_MD, /^---\nname: client-seo-report\n/);
  const desc = SKILL_MD.slice(0, SKILL_MD.indexOf('\n---\n', 4));
  for (const kw of ['SEO', 'read-only', 'recommend', 'organic traffic']) {
    assert.ok(desc.toLowerCase().includes(kw.toLowerCase()), `description should mention "${kw}"`);
  }
});

test('skill body: the trust DEFINING REQUIREMENTS are all stated', () => {
  const body = SKILL_MD.toLowerCase();
  // 1. read-only / never mutate
  assert.ok(/read-only/.test(body) && /(never|not)\b[^.]*\b(send|mutat|publish)/.test(body), 'read-only contract');
  // 2. every figure traces to a tool result
  assert.ok(/figure/.test(body) && /trace/.test(body) && /tool result/.test(body), 'figures-grounded contract');
  assert.ok(/(do not|never)\b[^.]*\b(estimate|fabricat|invent|memory)/.test(body), 'no-fabrication clause');
  // 3. honest partial on a data gap
  assert.ok(/honest partial/.test(body) && /nothing fabricated|nothing was fabricated|fabricated/.test(body), 'honest-partial contract');
  // 4. runtime client discovery (no hardcoded roster)
  assert.ok(/runtime/.test(body) && /never hardcode/.test(body), 'runtime-discovery / no-hardcoded-list contract');
  // 5. fan out, don't serialize (durability nudge)
  assert.ok(/run_worker/.test(body) && /foreach/.test(body), 'fan-out / forEach guidance');
});

test('skill is discoverable in the repo via the real skill-store', async () => {
  const { discoverSkillsInRepo } = await import('./skill-store.js');
  const found = discoverSkillsInRepo(REPO_ROOT, 'repo');
  assert.ok(found.some((f) => f.installName === 'client-seo-report'), 'client-seo-report must be discoverable');
});
