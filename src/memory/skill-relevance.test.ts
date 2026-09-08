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
    'version: 1.1.0',
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

test('an action-shaped request reaches its artifact skill even when neighbors share the artifact word (2026-07-31 live)', () => {
  // The owner's own outbound standard was NOT selected for his own outbound
  // request: "draft"/"prepare" were pooled with stopwords, so the request kept
  // no skill-bearing signal and lost to skills that merely mention email.
  install('brand-outbound', 'Brand-enforced outbound email. Shapes a template or draft into an on-brand prospect email.');
  install('dashboard-recipe', 'Build an interactive workspace report — auto-refreshing data with one-click email from rows.');
  install('deal-risk-board', 'Build a deal-risk workspace for a rep with open opportunities flagged by email and call engagement.');

  const matches = findRelevantSkills(
    'these 266 we need to get a mid year audit email ready for them in my drafts, lets get at least 50 of them ready right now please?',
  );
  const names = matches.map((m) => m.skill.name);
  assert.ok(names.includes('brand-outbound'), `the artifact-correct standard must be a candidate, got: ${names.join(', ') || 'none'}`);

  // Precision floor holds: a verb alone can never surface a skill.
  assert.deepEqual(findRelevantSkills('can you draft something for me'), [], 'a bare action verb surfaces nothing');
  assert.deepEqual(findRelevantSkills('whats on my calendar today'), [], 'an unrelated read stays quiet');
});

test('compound data flow admits a useful Sheet reference while excluding unrelated whole recipes', () => {
  install('google-firm-sheet', 'Pull firm data into a Google Sheet for account tracking.');
  install(
    'workspace-email-recipe',
    'Build an interactive Workspace report with scheduled data pulls and one-click email actions.',
  );
  install(
    'slack-sheet-review',
    'Review Slack requests and append a daily digest to a Google Sheet workspace.',
  );
  const request = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
  const names = findRelevantSkills(request).map(match => match.skill.name);
  assert.ok(names.includes('google-firm-sheet'), 'the data-to-Sheet helper is useful to this requested subtask');
  assert.ok(!names.includes('workspace-email-recipe'), 'an incidental email feature does not adopt a Workspace recipe');
  assert.ok(!names.includes('slack-sheet-review'), 'a Sheet destination does not adopt an unrelated Slack source procedure');
  const prompt = renderRelevantSkillsForPrompt(request);
  assert.match(prompt, /google-firm-sheet/);
  assert.doesNotMatch(prompt, /workspace-email-recipe|slack-sheet-review/);
});


test('an owner writing standard can anchor to its useful subtask without describing the whole compound job', () => {
  install('scorpion-outbound', 'Scorpion brand-enforced outbound email. Shapes a template or draft into an on-brand cold or follow-up prospect email.');
  const query = "Find me 30 of Brett's market leader accounts that he hasn't touched in the last 15 days. Pull account data and then website SEO data. Create me a 3 email plan that we can start kicking off today and then email every 2 days after as long as they don't respond. These emails need to add value around scorpion and have a clear CTA on why they would want to book a meeting with him.";
  const matches = findRelevantSkills(query);
  const reference = matches.find(match => match.skill.name === 'scorpion-outbound');
  assert.ok(reference, `the email writing subtask can use its brand standard, got ${matches.map(match => match.skill.name).join(', ')}`);
  assert.equal(reference.skill.frontmatter.version, '1.1.0');
  assert.equal(reference.skill.frontmatter.applicability, undefined, 'fixture does not bypass purpose matching with owner metadata edits');
  const prompt = renderRelevantSkillsForPrompt(query);
  assert.match(prompt, /scorpion-outbound/);
  assert.doesNotMatch(prompt, /Full scorpion-outbound procedure/, 'candidate discovery does not execute or inject the whole framework');
});

test('an incidental email delivery and a brand account lookup do not import a prospect writing standard', () => {
  install('scorpion-outbound', 'Scorpion brand-enforced outbound email. Shapes a template or draft into an on-brand cold or follow-up prospect email.');
  for (const query of [
    'Find the Scorpion market leader accounts assigned to Brett and report their website SEO data.',
    'Create a Scorpion website report, then email me the link.',
    'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.',
  ]) assert.ok(!findRelevantSkills(query).some(match => match.skill.name === 'scorpion-outbound'), query);
  assert.ok(findRelevantSkills('Inspect scorpion-outbound').some(match => match.skill.name === 'scorpion-outbound'), 'explicit reference discovery remains available without execution');
});

test('writing standards remain subtask candidates in a multi-artifact outreach request', () => {
  install('scorpion-outbound', 'Scorpion brand-enforced outbound email. Shapes a template or draft into an on-brand cold or follow-up prospect email.');
  const matches = findRelevantSkills('Read the account spreadsheet, draft Scorpion prospect emails, then create a website report for the meeting.');
  assert.ok(matches.some(match => match.skill.name === 'scorpion-outbound'));
  assert.ok(!matches.some(match => match.skill.name === 'workspace-email-recipe'), 'incidental email features do not make a Workspace recipe the writing standard');
});
