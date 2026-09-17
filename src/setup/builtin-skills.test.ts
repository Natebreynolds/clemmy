import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-builtin-skills-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { initHome } = await import('./init-home.js');
const builtins = await import('./builtin-skills.js');
const { PKG_DIR } = await import('../config.js');
const { registerSkillTools } = await import('../tools/skill-tools.js');
const { buildAgentContextPacket } = await import('../runtime/harness/context-packet.js');

after(() => rmSync(HOME, { recursive: true, force: true }));

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
}

test('source init provisions the shipped skill and real skill_list/skill_read expose it', async () => {
  await initHome();
  const installed = path.join(
    HOME,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    'SKILL.md',
  );
  const shipped = path.join(
    PKG_DIR,
    'builtin-skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    'SKILL.md',
  );
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(shipped, 'utf8'));

  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  registerSkillTools({
    tool(name: string, ...parts: unknown[]) {
      handlers.set(name, parts.at(-1) as (args: Record<string, unknown>) => Promise<unknown>);
    },
  } as never);
  const listed = text(await handlers.get('skill_list')!({}));
  assert.match(listed, /technical-content-marketing/);
  assert.match(listed, /cited content strategy, publishing calendar, and complete platform-ready social posts/i);
  const read = text(await handlers.get('skill_read')!({
    name: builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  }));
  assert.match(read, new RegExp(builtins.TECHNICAL_CONTENT_MARKETING_RULE_MARKER));
  assert.match(read, /one atomic `space_save` call/i);
  assert.match(read, /complete post in a record `body`/i);

  const prompt = 'Scrape the top recent news about local LLM processing, then create a content calendar and five social posts using the marketing skills.';
  const context = buildAgentContextPacket(
    prompt,
    { enabled: false, hitCount: 0, source: null, injected: false },
    { sessionKind: 'chat', suppressConfirmBeat: true },
  );
  assert.equal(context.skills[0]?.name, builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    'the exact north-star request deterministically ranks the shipped skill first');
  assert.match(context.text, /technical-content-marketing/);
});

test('first-party provisioning never overwrites a pre-existing same-name user skill', () => {
  const existingHome = path.join(HOME, 'existing-user');
  const targetDir = path.join(
    existingHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const target = path.join(targetDir, 'SKILL.md');
  const userBytes = [
    '---',
    'name: technical-content-marketing',
    'description: My private campaign procedure.',
    '---',
    '',
    'USER-OWNED-BYTES',
    '',
  ].join('\n');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, userBytes, 'utf8');

  const result = builtins.provisionBuiltinSkills({ baseDir: existingHome, packageRoot: PKG_DIR });
  assert.deepEqual(result
    .filter(({ name }) => name === builtins.TECHNICAL_CONTENT_MARKETING_SKILL)
    .map(({ name, status }) => ({ name, status })), [{
    name: builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    status: 'preserved',
  }]);
  assert.equal(readFileSync(target, 'utf8'), userBytes);
});

test('a user-owned blocking path is preserved byte-for-byte but fails readiness when no usable skill exists', () => {
  const conflictHome = path.join(HOME, 'user-conflict');
  const targetDir = path.join(
    conflictHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const note = path.join(targetDir, 'README.txt');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(note, 'USER-OWNED-CONFLICT\n', 'utf8');

  assert.throws(
    () => builtins.provisionBuiltinSkills({ baseDir: conflictHome, packageRoot: PKG_DIR }),
    /blocks required built-in skill technical-content-marketing but has no discoverable SKILL\.md/,
  );
  assert.equal(readFileSync(note, 'utf8'), 'USER-OWNED-CONFLICT\n');
  assert.equal(existsSync(path.join(targetDir, 'SKILL.md')), false);
});

test('a malformed same-name user skill is never overwritten and cannot masquerade as daemon readiness', () => {
  const conflictHome = path.join(HOME, 'malformed-user-override');
  const targetDir = path.join(
    conflictHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const target = path.join(targetDir, 'SKILL.md');
  const malformed = '---\nname: wrong-user-skill\ndescription: User bytes stay owned.\n---\n\nUSER-BODY\n';
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, malformed, 'utf8');

  assert.throws(
    () => builtins.provisionBuiltinSkills({ baseDir: conflictHome, packageRoot: PKG_DIR }),
    /declares wrong-user-skill; expected technical-content-marketing/,
  );
  assert.equal(readFileSync(target, 'utf8'), malformed);
});

test('a pre-publication failure publishes no partial skill and the next init self-heals', () => {
  const recoveryHome = path.join(HOME, 'pre-publication-recovery');
  const target = path.join(
    recoveryHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    'SKILL.md',
  );
  let staged = '';
  assert.throws(() => builtins.provisionBuiltinSkills({
    baseDir: recoveryHome,
    packageRoot: PKG_DIR,
    beforeInstallPublish: ({ name, stagingDir }) => {
      if (name !== builtins.TECHNICAL_CONTENT_MARKETING_SKILL) return;
      staged = stagingDir;
      assert.ok(existsSync(path.join(stagingDir, 'SKILL.md')));
      throw new Error('injected pre-publication crash');
    },
  }), /injected pre-publication crash/);
  assert.equal(existsSync(target), false, 'a failed publish exposed a public partial skill');
  assert.equal(existsSync(staged), false, 'the failed invocation left its private staging directory behind');

  const recovered = builtins.provisionBuiltinSkills({ baseDir: recoveryHome, packageRoot: PKG_DIR });
  assert.deepEqual(recovered
    .filter(({ name }) => name === builtins.TECHNICAL_CONTENT_MARKETING_SKILL)
    .map(({ name, status }) => ({ name, status })), [{
    name: builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    status: 'installed',
  }]);
  assert.equal(
    readFileSync(target, 'utf8'),
    readFileSync(path.join(
      PKG_DIR,
      'builtin-skills',
      builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
      'SKILL.md',
    ), 'utf8'),
  );
});

test('an empty same-name directory created at the publication seam is reused, never replaced', () => {
  const raceHome = path.join(HOME, 'empty-directory-race');
  const targetDir = path.join(
    raceHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const target = path.join(targetDir, 'SKILL.md');
  let racedDirectoryInode: bigint | undefined;

  const result = builtins.provisionBuiltinSkills({
    baseDir: raceHome,
    packageRoot: PKG_DIR,
    beforeInstallPublish: ({ name }) => {
      if (name !== builtins.TECHNICAL_CONTENT_MARKETING_SKILL) return;
      mkdirSync(targetDir);
      racedDirectoryInode = statSync(targetDir, { bigint: true }).ino;
    },
  });

  assert.deepEqual(result
    .filter(({ name }) => name === builtins.TECHNICAL_CONTENT_MARKETING_SKILL)
    .map(({ name, status }) => ({ name, status })), [{
    name: builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
    status: 'installed',
  }]);
  assert.equal(
    statSync(targetDir, { bigint: true }).ino,
    racedDirectoryInode,
    'publication replaced the raced empty directory',
  );
  assert.equal(
    readFileSync(target, 'utf8'),
    readFileSync(path.join(
      PKG_DIR,
      'builtin-skills',
      builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
      'SKILL.md',
    ), 'utf8'),
  );
});

test('a malformed user file winning the final publish race is preserved but fails readiness', () => {
  const raceHome = path.join(HOME, 'malformed-file-race');
  const targetDir = path.join(
    raceHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const target = path.join(targetDir, 'SKILL.md');
  const racedBytes = '---\nname: wrong-race-winner\ndescription: Preserve me.\n---\n\nUSER-RACE-BYTES\n';

  assert.throws(
    () => builtins.provisionBuiltinSkills({
      baseDir: raceHome,
      packageRoot: PKG_DIR,
      beforeSkillFilePublish: () => writeFileSync(target, racedBytes, { flag: 'wx' }),
    }),
    /declares wrong-race-winner; expected technical-content-marketing/,
  );
  assert.equal(readFileSync(target, 'utf8'), racedBytes,
    'the installer overwrote the non-cooperating race winner');
  assert.deepEqual(
    readdirSync(path.join(raceHome, 'skills'))
      .filter((name) => name.startsWith(`.${builtins.TECHNICAL_CONTENT_MARKETING_SKILL}-install-`)),
    [],
    'the readiness failure left private staging bytes behind',
  );
});

test('malformed or oversized packaged skill bytes cannot publish a target or staging remnant', () => {
  const packageRoot = path.join(HOME, 'malformed-package');
  const sourceDir = path.join(
    packageRoot,
    'builtin-skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  const source = path.join(sourceDir, 'SKILL.md');
  mkdirSync(sourceDir, { recursive: true });

  for (const fixture of [
    {
      label: 'wrong name',
      bytes: '---\nname: wrong-skill\ndescription: Wrong identity.\n---\n\nBody.\n',
      error: /frontmatter name must be exactly technical-content-marketing/,
    },
    {
      label: 'oversized body',
      bytes: Buffer.alloc(builtins.BUILTIN_SKILL_MAX_BYTES + 1, 0x61),
      error: /must be 1-262144 bytes/,
    },
  ] as const) {
    const baseDir = path.join(HOME, `malformed-${fixture.label.replaceAll(' ', '-')}`);
    writeFileSync(source, fixture.bytes);
    assert.throws(
      () => builtins.provisionBuiltinSkills({ baseDir, packageRoot }),
      fixture.error,
      fixture.label,
    );
    const skillsDir = path.join(baseDir, 'skills');
    assert.equal(
      existsSync(path.join(skillsDir, builtins.TECHNICAL_CONTENT_MARKETING_SKILL)),
      false,
    );
    assert.deepEqual(
      readdirSync(skillsDir).filter((name) => name.startsWith(`.${builtins.TECHNICAL_CONTENT_MARKETING_SKILL}-install-`)),
      [],
      `${fixture.label} left staging bytes`,
    );
  }
});

test('both foreground daemon entries provision built-ins before constructing the runtime', () => {
  const source = readFileSync(path.join(PKG_DIR, 'src', 'index.ts'), 'utf8');
  const helperStart = source.indexOf('function provisionForegroundDaemonBuiltins(): void');
  const helperEnd = source.indexOf('async function startConnectedCliSurfaces', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /provisionBuiltinSkills\(\);/);
  assert.doesNotMatch(helper, /catch\s*\(/,
    'a damaged or unwritable built-in must fail daemon readiness, not leave a normal-looking partial runtime');
  const internalStart = source.indexOf("if (sub === '--foreground')");
  const internalEnd = source.indexOf("if (sub === 'start')", internalStart);
  const legacyStart = source.indexOf('// Anything else: treat as legacy foreground');
  const legacyEnd = source.indexOf('// --- Plugin commands ---', legacyStart);
  assert.ok(internalStart > 0 && internalEnd > internalStart && legacyStart > internalEnd && legacyEnd > legacyStart);
  for (const [label, branch] of [
    ['daemon --foreground', source.slice(internalStart, internalEnd)],
    ['legacy foreground', source.slice(legacyStart, legacyEnd)],
  ] as const) {
    const provisionAt = branch.indexOf('provisionForegroundDaemonBuiltins();');
    const runtimeAt = branch.indexOf('new ClementineAssistant(createRuntimeFromConfig())');
    assert.ok(provisionAt >= 0, `${label} bypasses built-in provisioning`);
    assert.ok(runtimeAt > provisionAt, `${label} constructs the runtime before built-ins are visible`);
  }
  const devUp = readFileSync(path.join(PKG_DIR, 'scripts', 'dev-up.sh'), 'utf8');
  assert.match(devUp, /src\/index\.ts daemon --foreground/,
    'the local source launcher must traverse the provisioned foreground branch');
});

test('an unusable preserved override makes the exact foreground daemon process fail before readiness', () => {
  const conflictHome = path.join(HOME, 'daemon-readiness-conflict');
  const targetDir = path.join(
    conflictHome,
    'skills',
    builtins.TECHNICAL_CONTENT_MARKETING_SKILL,
  );
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    path.join(targetDir, 'SKILL.md'),
    '---\nname: wrong-daemon-skill\ndescription: Preserve this conflict.\n---\n\nUSER-BYTES\n',
  );
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(PKG_DIR, 'src', 'index.ts'), 'daemon', '--foreground'],
    {
      cwd: PKG_DIR,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        CLEMENTINE_HOME: conflictHome,
        CLEMMY_TEST_ISOLATED_HOME: '1',
        MCP_AUTO_IMPORT_ENABLED: 'false',
        DISCORD_ENABLED: 'false',
        SLACK_ENABLED: 'false',
        WEBHOOK_ENABLED: 'false',
      },
    },
  );
  assert.equal(child.signal, null, `foreground readiness check timed out: ${child.stderr}`);
  assert.notEqual(child.status, 0, 'foreground daemon reported success with the required skill unavailable');
  const output = `${child.stdout}\n${child.stderr}`;
  assert.match(output, /wrong-daemon-skill; expected technical-content-marketing/);
  assert.match(output, /Startup failed/);
  assert.doesNotMatch(output, /Daemon loop started|Webhook server listening|Direct-app mobile door open/);
});

function packageRootWith(label: string, overrides: Record<string, string> = {}): string {
  const root = path.join(HOME, `package-${label}`);
  for (const name of [builtins.TECHNICAL_CONTENT_MARKETING_SKILL, builtins.WORKSPACE_BUILDER_SKILL]) {
    const dir = path.join(root, 'builtin-skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      overrides[name] ?? readFileSync(path.join(PKG_DIR, 'builtin-skills', name, 'SKILL.md'), 'utf8'),
    );
  }
  return root;
}

test('a framework skill follows the release while untouched, and a user edit is never overwritten', () => {
  const home = path.join(HOME, 'release-updates');
  const name = builtins.WORKSPACE_BUILDER_SKILL;
  const target = path.join(home, 'skills', name, 'SKILL.md');
  const record = path.join(home, 'skills', name, builtins.BUILTIN_SKILL_RECORD);
  const shipped = readFileSync(path.join(PKG_DIR, 'builtin-skills', name, 'SKILL.md'), 'utf8');

  const first = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('v1') });
  assert.equal(first.find((entry) => entry.name === name)?.status, 'installed');
  assert.equal(readFileSync(target, 'utf8'), shipped);
  assert.ok(existsSync(record), 'the published digest is recorded beside the skill');

  // Next release ships new bytes: the untouched copy follows it.
  const v2 = shipped.replace('# Workspace builder', '# Workspace builder\n\nRELEASE-TWO-GUIDANCE');
  const second = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('v2', { [name]: v2 }) });
  assert.equal(second.find((entry) => entry.name === name)?.status, 'updated');
  assert.equal(readFileSync(target, 'utf8'), v2);

  // Same release again: nothing to do.
  const steady = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('v2', { [name]: v2 }) });
  assert.equal(steady.find((entry) => entry.name === name)?.status, 'preserved');

  // The user edits it: the next release leaves their bytes alone.
  const edited = v2.replace('RELEASE-TWO-GUIDANCE', 'MY-OWN-HOUSE-RULES');
  writeFileSync(target, edited);
  const v3 = shipped.replace('# Workspace builder', '# Workspace builder\n\nRELEASE-THREE-GUIDANCE');
  const third = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('v3', { [name]: v3 }) });
  assert.equal(third.find((entry) => entry.name === name)?.status, 'preserved');
  assert.equal(readFileSync(target, 'utf8'), edited, 'a user edit is never overwritten');

  // A broken packaged asset never costs the working installed copy.
  const broken = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('broken', { [name]: 'not a skill' }) });
  assert.equal(broken.find((entry) => entry.name === name)?.status, 'preserved');
  assert.equal(readFileSync(target, 'utf8'), edited);
  assert.deepEqual(
    readdirSync(path.join(home, 'skills', name)).filter((entry) => entry.includes('.update') || entry.endsWith('.tmp')),
    [],
    'no staged update bytes are left behind',
  );
});

test('an installed copy from before digests were recorded is adopted when it matches the release, preserved otherwise', () => {
  const home = path.join(HOME, 'legacy-adoption');
  const name = builtins.TECHNICAL_CONTENT_MARKETING_SKILL;
  const dir = path.join(home, 'skills', name);
  const shipped = readFileSync(path.join(PKG_DIR, 'builtin-skills', name, 'SKILL.md'), 'utf8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), shipped);
  const adopted = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('legacy') });
  assert.equal(adopted.find((entry) => entry.name === name)?.status, 'preserved');
  assert.ok(existsSync(path.join(dir, builtins.BUILTIN_SKILL_RECORD)), 'a matching legacy copy is adopted');
  const next = shipped.replace('# Technical Content Marketing', '# Technical Content Marketing\n\nNEXT-RELEASE');
  const updated = builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: packageRootWith('legacy-next', { [name]: next }) });
  assert.equal(updated.find((entry) => entry.name === name)?.status, 'updated', 'an adopted copy then follows releases');

  const otherHome = path.join(HOME, 'legacy-different');
  const otherDir = path.join(otherHome, 'skills', name);
  mkdirSync(otherDir, { recursive: true });
  const older = shipped.replace('# Technical Content Marketing', '# Technical Content Marketing\n\nOLDER-OR-EDITED');
  writeFileSync(path.join(otherDir, 'SKILL.md'), older);
  const kept = builtins.provisionBuiltinSkills({ baseDir: otherHome, packageRoot: packageRootWith('legacy-other') });
  assert.equal(kept.find((entry) => entry.name === name)?.status, 'preserved');
  assert.equal(readFileSync(path.join(otherDir, 'SKILL.md'), 'utf8'), older, 'unrecorded bytes that differ are the user\'s');
});

test('Clem finds the workspace-builder skill for ordinary Space requests and not for unrelated work', async () => {
  const home = path.join(HOME, 'skill-discovery');
  builtins.provisionBuiltinSkills({ baseDir: home, packageRoot: PKG_DIR });
  const probe = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    const { findRelevantSkills } = await import(${JSON.stringify(path.join(PKG_DIR, 'src', 'memory', 'skill-store.ts'))});
    const asks = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(asks.map((ask) => findRelevantSkills(ask).map((m) => m.skill?.name ?? m.name))));
  `, JSON.stringify([
    'Completely revolutionize the design of my My Day space',
    'add a draft reply button to the emails in my inbox workspace',
    'build me a dashboard for my team pipeline that refreshes every morning',
    'the slack section of my space is empty, fix it',
    'what is the weather in denver tomorrow',
  ])], {
    cwd: PKG_DIR,
    env: { ...process.env, CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1' },
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  const found = JSON.parse(probe.stdout.trim().split('\n').pop()!) as string[][];
  for (const [index, names] of found.slice(0, 4).entries()) {
    assert.ok(names.includes(builtins.WORKSPACE_BUILDER_SKILL), `request ${index} did not surface the skill: ${JSON.stringify(names)}`);
  }
  assert.equal(found[4]!.includes(builtins.WORKSPACE_BUILDER_SKILL), false, 'unrelated work does not pull it in');
});
