import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-relevance-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  SKILLS_DIR,
  findRelevantSkills,
  renderRelevantSkillsForPrompt,
  renderSkillDiscoveryPrompt,
  renderSkillsIndex,
} = await import('./skill-store.js');

function install(name: string, description: string): void {
  const dir = path.join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Full ${name} procedure stays behind skill_read.`,
  ].join('\n'));
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('query relevance surfaces a document skill without unrelated calendar noise', () => {
  install('google-document-brief', 'Create polished Google Docs and Word document briefs for firms.');
  install('calendar-planner', 'Schedule meetings and organize calendar availability.');
  install('seo-audit', 'Audit search rankings and technical SEO issues.');
  install('google-firm-sheet', 'Pull firm data into a Google Sheet for account tracking.');

  const matches = findRelevantSkills('Create me a Google Doc about a firm.');
  assert.equal(matches[0]?.skill.name, 'google-document-brief');
  assert.ok(matches.some((match) => match.skill.name === 'google-document-brief'));
  assert.ok(!matches.some((match) => match.skill.name === 'calendar-planner'));

  const rendered = renderRelevantSkillsForPrompt('Create me a Google Doc about a firm.');
  assert.match(rendered, /google-document-brief/);
  assert.doesNotMatch(rendered, /calendar-planner|seo-audit|google-firm-sheet/);
  assert.match(rendered, /skill_read/);
  assert.match(rendered, /skill_list/);
  assert.doesNotMatch(rendered, /Full google-document-brief procedure/);
});

test('stable discovery stays constant while per-turn skill context is strictly bounded', () => {
  const before = renderSkillDiscoveryPrompt();
  for (let i = 0; i < 40; i++) {
    install(
      `document-variant-${String(i).padStart(2, '0')}`,
      `Document production workflow ${i} for Google Docs, Word reports, and polished firm briefs with a deliberately long description ${'x'.repeat(120)}.`,
    );
  }
  const after = renderSkillDiscoveryPrompt();
  const fullIndex = renderSkillsIndex();
  const relevant = renderRelevantSkillsForPrompt('make a Google document firm brief', { maxSkills: 3, maxChars: 640 });

  assert.equal(after, before, 'installed-library changes cannot churn the stable prefix');
  assert.ok(before.length < 400, `stable discovery should stay compact; got ${before.length} chars`);
  assert.ok(relevant.length <= 640, `per-turn skill context exceeded bound: ${relevant.length}`);
  assert.ok((relevant.match(/^- `/gm) ?? []).length <= 3, 'at most three skill summaries are injected');
  assert.ok(fullIndex.length > relevant.length * 4, `measurement should prove meaningful reduction; full=${fullIndex.length}, relevant=${relevant.length}`);

  const tight = renderRelevantSkillsForPrompt('make a Google document firm brief', { maxSkills: 8, maxChars: 320 });
  assert.ok(tight.length <= 320, `tight per-turn context exceeded bound: ${tight.length}`);
  assert.match(tight, /skill_read\("<name>"\)/, 'tight bounds preserve the complete read fallback');
  assert.match(tight, /skill_list\(\)/, 'tight bounds preserve the complete catalog fallback');
});
