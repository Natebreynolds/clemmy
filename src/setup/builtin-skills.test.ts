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
  assert.deepEqual(result.map(({ name, status }) => ({ name, status })), [{
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
    beforeInstallPublish: ({ stagingDir }) => {
      staged = stagingDir;
      assert.ok(existsSync(path.join(stagingDir, 'SKILL.md')));
      throw new Error('injected pre-publication crash');
    },
  }), /injected pre-publication crash/);
  assert.equal(existsSync(target), false, 'a failed publish exposed a public partial skill');
  assert.equal(existsSync(staged), false, 'the failed invocation left its private staging directory behind');

  const recovered = builtins.provisionBuiltinSkills({ baseDir: recoveryHome, packageRoot: PKG_DIR });
  assert.deepEqual(recovered.map(({ name, status }) => ({ name, status })), [{
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
    beforeInstallPublish: () => {
      mkdirSync(targetDir);
      racedDirectoryInode = statSync(targetDir, { bigint: true }).ino;
    },
  });

  assert.deepEqual(result.map(({ name, status }) => ({ name, status })), [{
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
