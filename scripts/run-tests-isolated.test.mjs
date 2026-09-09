import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createIsolatedRunnerProgressTracker,
  DEFAULT_TEST_TARGETS,
  isolatedTestArgs,
  TEST_ISOLATION_PRELOAD,
} from './run-tests-isolated-args.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-tests-isolated.mjs');

/**
 * Environment for spawning the runner from inside a test.
 *
 * NODE_TEST_CONTEXT must not be inherited: Node reads it as "you are already a
 * test child", so the nested runner reports through a serializer channel that
 * has no listener, executes NO test files, and exits 0. A nested run that only
 * asserts on the exit status then passes without ever running its fixture.
 */
function nestedRunnerEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function expandTestTargets(targets) {
  return targets.flatMap((target) => (
    globSync(target, { cwd: repoRoot })
      .map((file) => file.split(path.sep).join('/'))
  ));
}

test('isolated test runner retains source-only defaults when only reporter options are forwarded', () => {
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter=dot']),
    ['--import', TEST_ISOLATION_PRELOAD, '--test', '--test-timeout', '600000', '--test-reporter=dot', ...DEFAULT_TEST_TARGETS],
  );
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter', 'dot']),
    ['--import', TEST_ISOLATION_PRELOAD, '--test', '--test-timeout', '600000', '--test-reporter', 'dot', ...DEFAULT_TEST_TARGETS],
  );
  assert.equal(
    DEFAULT_TEST_TARGETS.some((target) => target.includes('/journeys/')),
    false,
    'the broad concurrent unit suite must not duplicate the serialized journey gate',
  );
});

test('broad and serialized journey targets partition every src/apps TypeScript test exactly once', () => {
  // The relay's own suite is plain ESM (.mjs); it is a real test the broad target runs, so it belongs in the partition.
  const allTests = expandTestTargets(['src/**/*.test.ts', 'apps/**/*.test.ts', 'apps/relay/**/*.test.mjs']).sort();
  const allJourneys = expandTestTargets(['src/journeys/**/*.test.ts']).sort();
  const expectedBroad = allTests.filter((file) => !file.startsWith('src/journeys/'));
  const expandedBroad = expandTestTargets(DEFAULT_TEST_TARGETS);

  assert.equal(
    new Set(expandedBroad).size,
    expandedBroad.length,
    'no broad target patterns may select the same test file twice',
  );
  assert.deepEqual([...expandedBroad].sort(), expectedBroad);

  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const journeyTargets = String(packageJson.scripts?.journeys ?? '')
    .split(/\s+/)
    .filter((argument) => argument.startsWith('src/journeys/') && argument.endsWith('.test.ts'));
  const expandedJourneys = expandTestTargets(journeyTargets);

  assert.equal(
    new Set(expandedJourneys).size,
    expandedJourneys.length,
    'journey target patterns may select each journey exactly once',
  );
  assert.deepEqual([...expandedJourneys].sort(), allJourneys);
  assert.deepEqual(
    [...new Set([...expandedBroad, ...expandedJourneys])].sort(),
    allTests,
    'the two gates must cover the full src/apps TypeScript test set without a hole',
  );
});

test('isolated test runner preserves an explicit targeted test without adding the full suite', () => {
  assert.deepEqual(
    isolatedTestArgs(['--test-reporter=spec', 'apps/desktop/src/workspace-navigation-policy.test.ts']),
    ['--import', TEST_ISOLATION_PRELOAD, '--test', '--test-timeout', '600000', '--test-reporter=spec', 'apps/desktop/src/workspace-navigation-policy.test.ts'],
  );
});

test('watchdog advances on ordered top-level TAP completions in a serialized suite', () => {
  const progress = createIsolatedRunnerProgressTracker(0);

  assert.equal(progress.observe('TAP version 13', 1), false);
  assert.equal(progress.observe('# Subtest: first named journey', 2), false);
  assert.equal(progress.observe('ok 1 - first named journey', 400_000), true);
  assert.deepEqual(progress.snapshot(), {
    currentFile: '(not reported by test reporter)',
    lastProgress: 'TAP test 1 completed',
    lastProgressAt: 400_000,
  });

  // The whole serialized run is now older than one file budget, but the next
  // owning test is only 250s past a trustworthy completion and must survive.
  assert.ok(650_000 - progress.snapshot().lastProgressAt < 600_000);
  assert.equal(progress.observe('ok 2 - second named journey', 650_000), true);
  assert.equal(progress.snapshot().lastProgressAt, 650_000);
});

test('watchdog ignores chatty output and only accepts exact reporter boundaries', () => {
  const progress = createIsolatedRunnerProgressTracker(10);

  for (const line of [
    'worker remains ok 1 - still polling',
    '# ok 1 - captured child output',
    'heartbeat from src/journeys/chatty.test.ts',
    '✔ an ordinary assertion, not a file',
    'ok 2 - out of sequence',
  ]) {
    assert.equal(progress.observe(line, 20), false, line);
  }
  assert.equal(progress.snapshot().lastProgressAt, 10);

  progress.observe('TAP version 13', 30);
  assert.equal(progress.observe('ok 2 - still out of sequence', 40), false);
  assert.equal(progress.snapshot().lastProgressAt, 10);
  assert.equal(progress.observe('ok 1 - real completion', 50), true);
  assert.equal(progress.observe('ok 1 - repeated chatter', 60), false);
  assert.equal(progress.snapshot().lastProgressAt, 50);

  assert.equal(progress.observe('# Subtest: src/journeys/file-boundary.test.ts', 70), true);
  assert.deepEqual(progress.snapshot(), {
    currentFile: 'src/journeys/file-boundary.test.ts',
    lastProgress: 'file boundary src/journeys/file-boundary.test.ts',
    lastProgressAt: 70,
  });

  // stderr is eligible for exact file reporter markers, never TAP results.
  assert.equal(progress.observe('ok 2 - forged stderr completion', 80, { allowTap: false }), false);
  assert.equal(progress.snapshot().lastProgressAt, 70);
});

test('repository test scripts route through the isolated runner', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts ?? {};
  for (const name of ['test', 'test:prospective', 'test:public-hygiene', 'test:release-assets', 'test:release-closure', 'test:packaged-upgrade', 'proof:selftest', 'journeys', 'test:measurement']) {
    assert.match(
      String(scripts[name] ?? ''),
      /run-tests-isolated\.mjs/,
      `${name} must use the isolated test runner`,
    );
    assert.doesNotMatch(
      String(scripts[name] ?? ''),
      /(?:^|\s)(?:npx\s+)?(?:tsx|node)\s+--test(?:\s|$)/,
      `${name} must not invoke node/tsx --test directly`,
    );
  }
  assert.match(
    String(scripts.journeys ?? ''),
    /(?:^|\s)--test-concurrency(?:=|\s+)1(?:\s|$)/,
    'journeys must serialize test files so the canonical latency gate is not contending with sibling journey processes',
  );
});

test('concurrently executed test files never share a home', () => {
  // The runner used to pin one CLEMENTINE_HOME for the whole run, which
  // disabled the preload's per-process minting. Files execute concurrently, so
  // they then contended on the same SQLite databases and a failure moved
  // between runs — a suite in that state cannot gate a release. Two files
  // reporting the same home is the exact regression.
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runner-home-isolation-'));
  const reportPath = path.join(fixtureDir, 'homes.txt');
  for (const name of ['alpha', 'beta']) {
    writeFileSync(path.join(fixtureDir, `${name}.test.mjs`), `
      import { test } from 'node:test';
      import { appendFileSync } from 'node:fs';

      test('${name} records the home it was given', () => {
        appendFileSync(${JSON.stringify(reportPath)}, process.env.CLEMENTINE_HOME + '\\n');
      });
    `);
  }

  try {
    const result = spawnSync(
      process.execPath,
      [runnerPath, path.join(fixtureDir, 'alpha.test.mjs'), path.join(fixtureDir, 'beta.test.mjs')],
      { cwd: repoRoot, env: nestedRunnerEnv(), encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      0,
      `isolated runner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const homes = readFileSync(reportPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(homes.length, 2, 'both fixture files ran');
    assert.notEqual(homes[0], homes[1], 'each test file process minted its own home');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('isolated runner preserves the selected Node runtime even when PATH offers another node', {
  skip: process.platform === 'win32' ? 'POSIX shebang regression fixture' : false,
}, () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runner-node-identity-'));
  const marker = path.join(fixtureDir, 'wrong-node-used');
  const report = path.join(fixtureDir, 'runtime.json');
  const wrongNode = path.join(fixtureDir, 'node');
  const fixturePath = path.join(fixtureDir, 'runtime.test.mjs');
  writeFileSync(wrongNode, `#!/bin/sh\nprintf wrong > '${marker}'\nexit 86\n`);
  chmodSync(wrongNode, 0o755);
  writeFileSync(fixturePath, `
    import { test } from 'node:test';
    import { writeFileSync } from 'node:fs';
    test('records the actual test process runtime', () => {
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ executable: process.execPath, version: process.version }));
    });
  `);
  try {
    const result = spawnSync(process.execPath, [runnerPath, fixturePath], {
      cwd: repoRoot,
      env: { ...nestedRunnerEnv(), PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `runner failed\n${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(marker), false, 'PATH must not select the test runtime');
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), {
      executable: process.execPath,
      version: process.version,
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('isolated test runner contains home, provider, and nested temp state', () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-runner-contract-'));
  const fixturePath = path.join(fixtureDir, 'environment.test.mjs');
  writeFileSync(fixturePath, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import path from 'node:path';

    test('receives the safe isolated environment', () => {
      assert.equal(process.env.CLEMMY_LOCAL_EMBEDDINGS, 'off');
      assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
      assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
      assert.match(process.env.CLEMENTINE_HOME ?? '', /clementine-test-home-/);
      // Temp stays one level ABOVE the per-process home on purpose: macOS caps
      // a unix socket path at 104 bytes and tsx opens its IPC pipe under
      // TMPDIR, so nesting temp inside each home truncates that path and makes
      // unrelated subprocesses collide. Both still live in the one disposable
      // tree the runner tears down.
      const disposableRoot = path.dirname(os.tmpdir());
      assert.ok(
        process.env.CLEMENTINE_HOME.startsWith(disposableRoot + path.sep),
        \`home \${process.env.CLEMENTINE_HOME} escaped the disposable tree \${disposableRoot}\`,
      );
      assert.equal(process.env.TMPDIR, os.tmpdir());
      assert.equal(process.env.TMP, os.tmpdir());
      assert.equal(process.env.TEMP, os.tmpdir());
    });
  `);

  try {
    const result = spawnSync(process.execPath, [runnerPath, fixturePath], {
      cwd: repoRoot,
      env: {
        ...nestedRunnerEnv(),
        CLEMMY_LOCAL_EMBEDDINGS: 'on',
      },
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `isolated runner failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    // Exit status alone is not evidence: a nested run that executes zero files
    // also exits 0. Prove the fixture's assertions actually ran.
    assert.match(
      String(result.stdout),
      /^# pass 1$/m,
      `fixture did not run\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
