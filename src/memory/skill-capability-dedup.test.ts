/**
 * Run: npx tsx --test src/memory/skill-capability-dedup.test.ts
 *
 * Task-level identity and non-destructive reconciliation for self-distilled
 * skills. These tests stay entirely local/deterministic; no distiller model is
 * invoked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-dedup-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  SKILLS_DIR,
  capabilityTaskFingerprint,
  findDistilledSkillByCapabilityTask,
  listActiveSkills,
  listSkills,
  loadSkill,
  recordSkillCapabilityOrigin,
  reconcileDistilledSkillDuplicates,
  updateSkillFrontmatter,
  writeDistilledSkill,
} = await import('./skill-store.js');
const {
  _testOnly_claimDistilledCapability,
  _testOnly_reuseExistingCapability,
  distillSkillFromSession,
  distillSkillFromSessions,
  reinforceDraftSkills,
} = await import('./skill-distiller.js');
const { evaluateLearningCandidate } = await import('./learning-receipt.js');

function receipt(
  sessionId: string,
  sourceId: string,
  authority: 'workflow_terminal' | 'independent_completion_judge' = 'workflow_terminal',
) {
  return evaluateLearningCandidate({
    target: 'skill',
    authority,
    sessionId,
    sourceId,
    terminalSuccess: true,
    ...(authority === 'workflow_terminal'
      ? { controllerValidation: true }
      : { independentValidation: true }),
  }).receipt!;
}

beforeEach(() => {
  rmSync(SKILLS_DIR, { recursive: true, force: true });
});

test('same task reworded gets one stable fingerprint; a different task on the same provider does not', () => {
  const first = capabilityTaskFingerprint('Audit a law firm website and write an SEO brief.');
  const reworded = capabilityTaskFingerprint('Create an SEO report after reviewing a legal practice\'s site.');
  assert.equal(reworded, first, 'name/word-order/synonym changes preserve task identity');

  const publish = capabilityTaskFingerprint('Publish a landing page to Netlify.');
  const remove = capabilityTaskFingerprint('Delete a landing page from Netlify.');
  assert.notEqual(remove, publish, 'same provider/tool family must not collapse distinct actions');

  const exportToSheets = capabilityTaskFingerprint('Copy contacts from Salesforce to Google Sheets.');
  const importToSalesforce = capabilityTaskFingerprint('Copy contacts from Google Sheets to Salesforce.');
  assert.notEqual(importToSalesforce, exportToSheets, 'source/destination direction remains semantic');

  const eventFromEmail = capabilityTaskFingerprint('Create a calendar event from an email.');
  const emailFromEvent = capabilityTaskFingerprint('Create an email from a calendar event.');
  assert.notEqual(emailFromEvent, eventFromEmail, 'result/source roles remain semantic without an explicit destination');
});

test('newly distilled skills persist the original task fingerprint in metadata', () => {
  const task = 'Audit a law firm website and write an SEO brief.';
  writeDistilledSkill({
    name: 'seo-audit',
    description: 'Prepare a concise search report.',
    body: '1. Inspect the site.\n2. Prepare the report.',
    origin: { kind: 'manual', sourceId: 'session-1' },
    capabilityTask: task,
  });
  assert.equal(loadSkill('seo-audit')!.frontmatter.capabilityFingerprint, capabilityTaskFingerprint(task));
});

test('legacy distilled skill is matched, backfilled, and records repeat lineage instead of duplicating', async () => {
  const dir = path.join(SKILLS_DIR, 'legacy-seo-brief');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: legacy-seo-brief',
    'description: Audit a law firm website and write an SEO brief.',
    'tier: draft',
    'origin:',
    '  kind: workflow',
    '  sourceId: legacy-schedule',
    'useCount: 0',
    'failureCount: 0',
    '---',
    '',
    '1. Audit the site.',
    '',
  ].join('\n'), 'utf-8');

  const objective = 'Create an SEO report after reviewing a legal practice\'s site.';
  const match = findDistilledSkillByCapabilityTask(objective);
  assert.equal(match?.skill.name, 'legacy-seo-brief');
  assert.equal(match?.legacy, true);

  const result = await _testOnly_reuseExistingCapability(
    objective,
    { kind: 'workflow', sourceId: 'repeat-run' },
    receipt('workflow:repeat-run:step', 'repeat-run'),
  );
  assert.equal(result?.status, 'skipped_duplicate');
  assert.equal(result?.name, 'legacy-seo-brief');
  const reused = loadSkill('legacy-seo-brief')!;
  assert.equal(reused.frontmatter.capabilityFingerprint, capabilityTaskFingerprint(objective));
  assert.equal(reused.frontmatter.useCount, 0, 'dedup does not double-count harness success reinforcement');
  assert.deepEqual(
    reused.frontmatter.capabilityOrigins?.map((origin) => origin.sourceId),
    ['legacy-schedule', 'repeat-run'],
    'the duplicate run is retained as source lineage instead',
  );
  assert.equal(listSkills().length, 1, 'no variant was created');
});

test('manual/session and automatic/workflow distillation share the pre-LLM dedup boundary', async () => {
  const objective = 'Publish a landing page to Netlify.';
  writeDistilledSkill({
    name: 'publish-netlify-site', description: 'Deploy a landing page.', body: 'Deploy it.',
    origin: { kind: 'chat', sourceId: 'first-goal' }, capabilityTask: objective,
  });

  const manual = await distillSkillFromSession('missing-session-is-never-read', {
    objective: 'Deploy a landing page using Netlify.',
    origin: { kind: 'manual', sourceId: 'manual-session' },
    learningReceipt: receipt(
      'missing-session-is-never-read',
      'manual-session',
      'independent_completion_judge',
    ),
    force: true,
  });
  assert.equal(manual.status, 'skipped_duplicate');
  assert.equal(manual.name, 'publish-netlify-site');

  const workflow = await distillSkillFromSessions([], {
    objective: 'Release a landing page on Netlify.',
    sourceId: 'workflow-run',
    learningReceipt: receipt('workflow:workflow-run:step', 'workflow-run'),
  });
  assert.equal(workflow.status, 'skipped_duplicate');
  assert.equal(workflow.name, 'publish-netlify-site');

  const skill = loadSkill('publish-netlify-site')!;
  assert.equal(skill.frontmatter.useCount, 0, 'dedup never inflates validated-use counters');
  assert.deepEqual(skill.frontmatter.capabilityOrigins?.map((origin) => origin.sourceId), [
    'first-goal', 'manual-session', 'workflow-run',
  ]);
  assert.equal(listSkills().length, 1);
});

test('automatic distillation cannot mutate lineage without a verified learning receipt', async () => {
  const objective = 'Publish a landing page to Netlify.';
  writeDistilledSkill({
    name: 'receipt-gated-netlify',
    description: 'Deploy a landing page.',
    body: 'Deploy it.',
    origin: { kind: 'chat', sourceId: 'verified-original' },
    capabilityTask: objective,
  });

  const rejected = await distillSkillFromSessions([], {
    objective: 'Release a landing page on Netlify.',
    sourceId: 'unverified-run',
  });
  assert.equal(rejected.status, 'skipped_unverified');
  assert.deepEqual(
    loadSkill('receipt-gated-netlify')!.frontmatter.capabilityOrigins?.map((origin) => origin.sourceId),
    ['verified-original'],
    'an unverified run cannot even inflate capability lineage',
  );
});

test('concurrent post-LLM claims atomically create one active capability', async () => {
  const objective = 'Publish a landing page to Netlify.';
  const results = await Promise.all([
    _testOnly_claimDistilledCapability({
      preferredName: 'publish-netlify-site-a',
      description: 'Publish a landing page.',
      body: 'First candidate body.',
      objective,
      origin: { kind: 'chat', sourceId: 'concurrent-a' },
      applicability: { toolFamilies: ['netlify'], entitySlots: [] },
      learningReceipt: receipt('session-a', 'concurrent-a', 'independent_completion_judge'),
    }),
    _testOnly_claimDistilledCapability({
      preferredName: 'publish-netlify-site-b',
      description: 'Deploy a landing page.',
      body: 'Second candidate body.',
      objective: 'Deploy a landing page using Netlify.',
      origin: { kind: 'workflow', sourceId: 'concurrent-b' },
      applicability: { toolFamilies: ['netlify'], entitySlots: [] },
      learningReceipt: receipt('workflow:concurrent-b:step', 'concurrent-b'),
    }),
  ]);

  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ['skipped_duplicate', 'written'],
  );
  const matches = listActiveSkills().filter((skill) =>
    skill.frontmatter.capabilityFingerprint === capabilityTaskFingerprint(objective));
  assert.equal(matches.length, 1, 'the fingerprint has exactly one active owner');
  assert.deepEqual(
    matches[0].frontmatter.capabilityOrigins?.map((origin) => origin.sourceId).sort(),
    ['concurrent-a', 'concurrent-b'],
    'the losing claim becomes lineage on the canonical draft',
  );
});

test('known duplicate drafts reconcile without deletion and retain every origin in canonical lineage', async () => {
  const capabilityTask = 'Send a daily standup email from calendar events and pending tasks.';
  writeDistilledSkill({
    name: 'daily-standup-email-brief', description: 'Collect meetings and tasks, then send a standup email.',
    body: 'canonical body', origin: { kind: 'workflow', sourceId: 'sched-old' }, capabilityTask,
  });
  writeDistilledSkill({
    name: 'email-daily-standup-from-calendar-and-tasks', description: 'Build and email a morning brief.',
    body: 'alias body remains evidence', origin: { kind: 'workflow', sourceId: 'sched-new' }, capabilityTask,
  });
  recordSkillCapabilityOrigin('email-daily-standup-from-calendar-and-tasks', {
    kind: 'workflow', sourceId: 'sched-new-repeat',
  });
  writeDistilledSkill({
    name: 'user-approved-standup', description: 'User-owned standup procedure.',
    body: 'approved body', origin: { kind: 'manual', sourceId: 'user' }, capabilityTask,
  });
  updateSkillFrontmatter('user-approved-standup', { tier: 'approved' });

  const result = reconcileDistilledSkillDuplicates({
    canonicalName: 'daily-standup-email-brief',
    duplicateNames: ['email-daily-standup-from-calendar-and-tasks', 'user-approved-standup'],
    capabilityTask,
  });
  assert.deepEqual(result.superseded, ['email-daily-standup-from-calendar-and-tasks']);
  assert.ok(result.skipped.some((item) => item.name === 'user-approved-standup'));

  const canonical = loadSkill('daily-standup-email-brief')!;
  assert.equal(canonical.frontmatter.capabilityFingerprint, capabilityTaskFingerprint(capabilityTask));
  assert.deepEqual(canonical.frontmatter.lineage?.map((entry) => entry.origin?.sourceId), ['sched-new']);
  assert.deepEqual(canonical.frontmatter.capabilityOrigins?.map((origin) => origin.sourceId), [
    'sched-old', 'sched-new', 'sched-new-repeat',
  ]);

  const alias = loadSkill('email-daily-standup-from-calendar-and-tasks', { raw: true })!;
  assert.equal(alias.frontmatter.supersededBy, 'daily-standup-email-brief');
  assert.equal(alias.frontmatter.disabled, true);
  assert.match(alias.body, /alias body remains evidence/, 'the old skill is retained on disk');
  assert.equal(
    loadSkill('email-daily-standup-from-calendar-and-tasks')?.name,
    'daily-standup-email-brief',
    'stale aliases execute the canonical procedure, never the retired body',
  );
  assert.equal(loadSkill('user-approved-standup')!.frontmatter.supersededBy, undefined, 'approved skill is untouched');

  assert.equal(listSkills().length, 3, 'management/audit keeps the complete catalog');
  assert.deepEqual(listActiveSkills().map((skill) => skill.name), ['daily-standup-email-brief', 'user-approved-standup']);

  await reinforceDraftSkills(
    ['email-daily-standup-from-calendar-and-tasks'],
    'success',
    undefined,
    undefined,
    receipt('standup-reinforce-session', 'standup-reinforce', 'independent_completion_judge'),
  );
  assert.equal(loadSkill('daily-standup-email-brief')!.frontmatter.useCount, 1, 'stale alias reinforces canonical');
  assert.equal(loadSkill('email-daily-standup-from-calendar-and-tasks', { raw: true })!.frontmatter.useCount, 0);
});

test('legacy aliases without fingerprints serialize into lineage without undefined YAML fields', () => {
  const capabilityTask = 'Send a daily standup email from calendar events and pending tasks.';
  writeDistilledSkill({
    name: 'standup-canonical', description: 'Send a daily standup email.', body: 'Canonical body.',
    origin: { kind: 'workflow', sourceId: 'canonical' }, capabilityTask,
  });
  const legacyDir = path.join(SKILLS_DIR, 'standup-legacy');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(path.join(legacyDir, 'SKILL.md'), [
    '---',
    'name: standup-legacy',
    'description: Send a daily standup email.',
    'tier: draft',
    'origin:',
    '  kind: workflow',
    '  sourceId: legacy',
    'useCount: 0',
    'failureCount: 2',
    'quarantined: true',
    '---',
    '',
    'Legacy body remains on disk.',
    '',
  ].join('\n'), 'utf-8');

  const result = reconcileDistilledSkillDuplicates({
    canonicalName: 'standup-canonical',
    duplicateNames: ['standup-legacy'],
    capabilityTask,
  });
  assert.deepEqual(result.superseded, ['standup-legacy']);
  assert.equal(result.skipped.length, 0);

  const canonical = loadSkill('standup-canonical')!;
  assert.equal(canonical.frontmatter.lineage?.[0]?.skillName, 'standup-legacy');
  assert.equal(canonical.frontmatter.lineage?.[0]?.failureCount, 2);
  assert.equal(canonical.frontmatter.lineage?.[0]?.capabilityFingerprint, undefined);
  assert.equal(loadSkill('standup-legacy', { raw: true })?.frontmatter.supersededBy, 'standup-canonical');
});

test('corrupt supersession cycles fail closed instead of recursing during skill execution', () => {
  for (const [name, target] of [['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a']] as const) {
    const dir = path.join(SKILLS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name}`,
      `supersededBy: ${target}`,
      'disabled: true',
      '---',
      '',
      `${name} body`,
      '',
    ].join('\n'), 'utf-8');
  }

  assert.equal(loadSkill('cycle-a'), null);
  assert.equal(loadSkill('cycle-b'), null);
  assert.equal(loadSkill('cycle-a', { raw: true })?.name, 'cycle-a');
  assert.equal(listSkills().length, 2, 'management can still inspect and repair both corrupt aliases');
  assert.equal(listActiveSkills().length, 0);
});
