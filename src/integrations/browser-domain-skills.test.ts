/**
 * Run: npx tsx --test src/integrations/browser-domain-skills.test.ts
 *
 * Learned per-site browser playbooks — the memory that makes "teach her once,
 * she can do it again" work. The harness reads these files itself before it
 * improvises, so a write here is what turns one successful browse into a
 * repeatable one.
 *
 * The risk being pinned is containment: `site` and `task` become a directory
 * and a filename, and both arrive from model output. A slug rule that lets
 * either escape the skills directory turns a memory feature into an arbitrary
 * file write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
  browserDomainSkillSite,
  browserDomainSkillTask,
  writeBrowserDomainSkill,
  BROWSER_HARNESS_DOMAIN_SKILLS_DIR,
} = await import('./browser-harness.js');

test('a site key accepts a URL, a host, or a slug and normalizes to one host', () => {
  for (const raw of [
    'https://www.amazon.com/s?k=keyboard',
    'www.amazon.com',
    'amazon.com',
    'AMAZON.COM',
  ]) {
    assert.equal(browserDomainSkillSite(raw), 'amazon.com', `"${raw}" must key the same playbook`);
  }
  // A subdomain is a DIFFERENT app and must not collapse into the parent —
  // an internal tool rarely navigates like its marketing site.
  assert.equal(browserDomainSkillSite('https://app.example.com/reports'), 'app.example.com');
});

test('a site key cannot escape the skills directory', () => {
  for (const hostile of ['../../etc', '..', '/etc/passwd', '../../../root', '.', './..']) {
    const site = browserDomainSkillSite(hostile);
    assert.ok(
      site === null || !site.includes('..'),
      `"${hostile}" normalized to "${site}" — a traversal survived`,
    );
  }
});

test('a task name cannot escape either, and stays a single filename', () => {
  for (const hostile of ['../evil', 'a/b/c', '..', '/abs/path']) {
    const task = browserDomainSkillTask(hostile);
    assert.ok(
      task === null || (!task.includes('..') && !task.includes('/')),
      `"${hostile}" normalized to "${task}" — a path separator survived`,
    );
  }
  assert.equal(browserDomainSkillTask('Export Monthly Report'), 'export-monthly-report');
});

test('the write refuses anything that resolves outside the skills root', () => {
  // Belt and braces: even if a slug rule were loosened later, the resolved
  // path is checked against the root before any write happens.
  const result = writeBrowserDomainSkill({
    site: '../../../../tmp',
    task: 'pwned',
    markdown: 'nope',
  });
  assert.equal(result.ok, false, 'a traversing site must never write');
  assert.ok(result.error, 'the refusal explains itself');
  assert.ok(
    !result.path || result.path.startsWith(path.resolve(BROWSER_HARNESS_DOMAIN_SKILLS_DIR)),
    'no path outside the skills root may be returned',
  );
});

test('an empty or oversized playbook is refused rather than written', () => {
  assert.equal(writeBrowserDomainSkill({ site: 'example.com', task: 'x', markdown: '   ' }).ok, false);
  assert.equal(
    writeBrowserDomainSkill({ site: 'example.com', task: 'x', markdown: 'a'.repeat(40_001) }).ok,
    false,
    'an oversized playbook is a runaway, not a memory',
  );
});

test('a missing site or task is refused with a usable message', () => {
  const noSite = writeBrowserDomainSkill({ site: '   ', task: 'x', markdown: 'body' });
  assert.equal(noSite.ok, false);
  assert.match(String(noSite.error), /site/i);
  const noTask = writeBrowserDomainSkill({ site: 'example.com', task: '   ', markdown: 'body' });
  assert.equal(noTask.ok, false);
  assert.match(String(noTask.error), /task/i);
});

// ── Status must name the fix, not just the problem ─────────────────────────
//
// The whole point of browser_harness_setup is that Clementine stops sending the
// user to click in Settings for something she can do. That only holds if status
// hands back an ACTION. Pinned in both directions: a broken harness must name
// its remedy, and a healthy one must not invent work.

const { browserHarnessNextAction } = await import('./browser-harness.js');

const READY = {
  installed: true,
  installDir: '/tmp/bh',
  repoPresent: true,
  codexSkillLinked: true,
  prerequisites: [
    { name: 'git', available: true },
    { name: 'uv', available: true },
    { name: 'python3', available: true },
  ],
  browserUseCloudKeyPresent: false,
  chromeSetupUrl: 'chrome://inspect/#remote-debugging',
} as unknown as Parameters<typeof browserHarnessNextAction>[0];

test('a ready harness proposes nothing', () => {
  assert.equal(browserHarnessNextAction(READY), null, 'a healthy harness must not manufacture a setup step');
});

test('a missing install names the tool that fixes it', () => {
  const next = browserHarnessNextAction({ ...READY, installed: false });
  assert.match(String(next), /browser_harness_setup/, 'the remedy must be the tool, not a Settings errand');
  assert.doesNotMatch(String(next), /Settings|Console/i);
});

test('a missing checkout is repairable by the same action', () => {
  const next = browserHarnessNextAction({ ...READY, repoPresent: false });
  assert.match(String(next), /browser_harness_setup/);
});

test('a missing PREREQUISITE is honest that the tool cannot fix it', () => {
  // uv and git are machine-level installs. Claiming setup can install them
  // would send the model into a loop that fails the same way every time.
  const next = String(browserHarnessNextAction({
    ...READY,
    prerequisites: [
      { name: 'git', available: true },
      { name: 'uv', available: false },
      { name: 'python3', available: true },
    ],
  }));
  assert.match(next, /uv/, 'it must name WHICH prerequisite is missing');
  assert.match(next, /cannot install/i, 'and be explicit that this one needs the user');
});
