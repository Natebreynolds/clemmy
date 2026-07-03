/**
 * Run: npx tsx --test src/runtime/harness/known-pitfalls.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-known-pitfalls-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { extractPitfallLines, pitfallsForSkills } = await import('./known-pitfalls.js');
const { knownPitfallLineForInput } = await import('./context-packet.js');
const { writeDistilledSkill, appendSkillPitfall } = await import('../../memory/skill-store.js');

test('extractPitfallLines: bullets under "## Pitfalls (observed)" only, section ends at the next heading', () => {
  const body = [
    '# My Skill', 'Do the thing.', '',
    '## Pitfalls (observed)',
    '- composio_execute_tool: hit "invalid cursor" — don\'t repeat the same call; retry with corrected args.',
    '- sf data query: use --json or the parse fails.',
    '## Steps', '- not a pitfall',
  ].join('\n');
  const lines = extractPitfallLines(body);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /invalid cursor/);
  assert.ok(!lines.some((l) => l.includes('not a pitfall')), 'later sections excluded');
  assert.deepEqual(extractPitfallLines('# No pitfalls here\n- bullet'), []);
});

test('pitfallsForSkills + knownPitfallLineForInput: freshest lessons for the ranked skills, bounded, null when none', () => {
  writeDistilledSkill({
    name: 'prospect-outreach',
    description: 'research prospects and draft outreach emails',
    body: 'Research each prospect, then draft the outreach email.',
    origin: { kind: 'manual' },
  });
  assert.equal(pitfallsForSkills(['prospect-outreach']), null, 'no pitfalls yet → no line (zero noise)');

  appendSkillPitfall('prospect-outreach', 'older lesson: check the toolkit is connected first.');
  appendSkillPitfall('prospect-outreach', 'newest lesson: composio search before execute — slugs drift.');

  const block = pitfallsForSkills(['prospect-outreach']);
  assert.ok(block, 'lessons exist → block renders');
  assert.match(block as string, /Known pitfalls/);
  assert.match(block as string, /newest lesson/);
  const newestIdx = (block as string).indexOf('newest lesson');
  const olderIdx = (block as string).indexOf('older lesson');
  assert.ok(newestIdx !== -1 && (olderIdx === -1 || newestIdx < olderIdx), 'newest lesson listed first');

  // The input-ranked wrapper (both lanes call this): a matching ask surfaces
  // the lesson; an unrelated ask stays silent.
  const hit = knownPitfallLineForInput('research prospects and draft outreach for these firms');
  assert.ok(hit && /newest lesson/.test(hit), 'skill-matched input surfaces the pitfall pre-flight');
  assert.equal(knownPitfallLineForInput('what is the weather like'), null, 'unrelated input → no pitfall noise');

  assert.equal(pitfallsForSkills(['never-installed']), null, 'missing skill → fail-quiet');
});

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
