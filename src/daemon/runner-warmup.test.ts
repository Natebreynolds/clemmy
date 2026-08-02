/**
 * Run: npx tsx --test src/daemon/runner-warmup.test.ts
 *
 * Focused boot-warmup gate tests. These do not start the daemon loop or call a
 * model provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-daemon-warmup-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';

const {
  bootAuthSetupSatisfied,
  bootModelWarmupEnabled,
  cliDiscoveryWarmupEnabled,
  resolveBootModelWarmupGate,
} = await import('./runner.js');

const RUNNER_SOURCE = readFileSync(new URL('./runner.ts', import.meta.url), 'utf-8');
const INDEX_SOURCE = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');

function parseSource(name: string, source: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  matches: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function callName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return undefined;
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  return descendants(
    root,
    (node): node is ts.CallExpression => ts.isCallExpression(node) && callName(node) === name,
  );
}

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const functions = descendants(
    sourceFile,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node),
  );
  const fn = functions.find((candidate) => candidate.name?.text === name);
  assert.ok(fn, `${name} declaration must exist`);
  return fn;
}

function containingIf(node: ts.Node): ts.IfStatement | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isIfStatement(current)) return current;
  }
  return undefined;
}

function isInsideOnReady(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isPropertyAssignment(current)
      && current.name.getText() === 'onReady'
    ) {
      return true;
    }
  }
  return false;
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('boot model warmup is explicit opt-in', () => {
  const prior = process.env.CLEMMY_BOOT_WARMUP;
  try {
    delete process.env.CLEMMY_BOOT_WARMUP;
    assert.equal(bootModelWarmupEnabled(), false);
    process.env.CLEMMY_BOOT_WARMUP = 'on';
    assert.equal(bootModelWarmupEnabled(), true);
    process.env.CLEMMY_BOOT_WARMUP = 'off';
    assert.equal(bootModelWarmupEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_BOOT_WARMUP;
    else process.env.CLEMMY_BOOT_WARMUP = prior;
  }
});

test('CLI discovery warmup is default-on but has an explicit recovery switch', () => {
  const prior = process.env.CLEMMY_CLI_DISCOVERY_WARMUP;
  try {
    delete process.env.CLEMMY_CLI_DISCOVERY_WARMUP;
    assert.equal(cliDiscoveryWarmupEnabled(), true);
    process.env.CLEMMY_CLI_DISCOVERY_WARMUP = 'off';
    assert.equal(cliDiscoveryWarmupEnabled(), false);
    process.env.CLEMMY_CLI_DISCOVERY_WARMUP = '0';
    assert.equal(cliDiscoveryWarmupEnabled(), false);
    process.env.CLEMMY_CLI_DISCOVERY_WARMUP = 'on';
    assert.equal(cliDiscoveryWarmupEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_CLI_DISCOVERY_WARMUP;
    else process.env.CLEMMY_CLI_DISCOVERY_WARMUP = prior;
  }
});

test('BYO all_in satisfies the boot auth check without an OpenAI key', () => {
  const keys = ['MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY', 'BYO_MODEL_ID'] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.MODEL_ROUTING_MODE;
    delete process.env.BYO_MODEL_BASE_URL;
    delete process.env.BYO_MODEL_API_KEY;
    delete process.env.BYO_MODEL_ID;
    assert.equal(bootAuthSetupSatisfied(false), false);

    process.env.MODEL_ROUTING_MODE = 'all_in';
    process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
    process.env.BYO_MODEL_API_KEY = 'byo-key';
    process.env.BYO_MODEL_ID = 'byo-brain';
    assert.equal(bootAuthSetupSatisfied(false), true);
  } finally {
    for (const key of keys) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Claude OAuth satisfies the boot auth check without Codex credentials', () => {
  const priorMode = process.env.AUTH_MODE;
  const vault = path.join(TMP_HOME, 'state', 'claude-auth.json');
  try {
    process.env.AUTH_MODE = 'claude_oauth';
    mkdirSync(path.dirname(vault), { recursive: true });
    writeFileSync(vault, JSON.stringify({
      accessToken: 'sk-ant-oat01-boot-auth-test',
      refreshToken: 'refresh-test',
      expiresAt: Date.now() + 3_600_000,
    }), 'utf-8');
    assert.equal(bootAuthSetupSatisfied(false), true);
  } finally {
    rmSync(vault, { force: true });
    if (priorMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = priorMode;
  }
});

test('resolveBootModelWarmupGate runs when the harness router configures', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: true }),
    () => '',
  );

  assert.deepEqual(gate, {
    run: true,
    harnessConfigured: true,
    directOpenAiKey: false,
  });
});

test('resolveBootModelWarmupGate skips cleanly when no model runtime or direct key is available', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: false, reason: 'No AI model is signed in yet.' }),
    () => '',
  );

  assert.deepEqual(gate, {
    run: false,
    harnessConfigured: false,
    directOpenAiKey: false,
    reason: 'No AI model is signed in yet.',
  });
});

test('resolveBootModelWarmupGate preserves direct OpenAI-key fallback compatibility', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => ({ ok: false, reason: 'No AI model is signed in yet.' }),
    () => 'sk-test',
  );

  assert.deepEqual(gate, {
    run: true,
    harnessConfigured: false,
    directOpenAiKey: true,
    reason: 'No AI model is signed in yet.',
  });
});

test('resolveBootModelWarmupGate treats configure exceptions as skip unless a direct key exists', async () => {
  const gate = await resolveBootModelWarmupGate(
    async () => { throw new Error('router not ready'); },
    () => '',
  );

  assert.deepEqual(gate, {
    run: false,
    harnessConfigured: false,
    directOpenAiKey: false,
    reason: 'router not ready',
  });
});

test('daemon readiness hook is awaited once after recovery and workflow-lane registration', () => {
  const sourceFile = parseSource('runner.ts', RUNNER_SOURCE);
  const startDaemon = namedFunction(sourceFile, 'startDaemon');

  const readyCalls = callsNamed(startDaemon, 'onReady').filter((call) => {
    const receiver = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.expression
      : undefined;
    return receiver !== undefined && ts.isIdentifier(receiver) && receiver.text === 'options';
  });
  assert.equal(readyCalls.length, 1, 'startDaemon must expose one readiness release point');
  const [readyCall] = readyCalls;
  assert.ok(ts.isAwaitExpression(readyCall.parent), 'the readiness hook must finish before boot proceeds');

  const canonicalToolMigration = callsNamed(startDaemon, 'migrateToolChoicesToCanonicalProcedures');
  const orphanFence = callsNamed(startDaemon, 'interruptOrphanedRunAttemptsAtBoot');
  const approvalDrain = callsNamed(startDaemon, 'startChatApprovalResume');
  const genericChatRecovery = callsNamed(startDaemon, 'reportInterruptedChatRuns');
  const terminalReportBack = callsNamed(startDaemon, 'startTerminalReportBackWatcher');
  for (const [label, calls] of [
    ['canonical tool-memory migration', canonicalToolMigration],
    ['orphan fencing', orphanFence],
    ['approval drain', approvalDrain],
    ['generic chat recovery', genericChatRecovery],
    ['terminal report-back', terminalReportBack],
  ] as const) {
    assert.equal(calls.length, 1, `${label} must have one boot registration`);
  }

  const laneRegistrations = callsNamed(startDaemon, 'setImmediate').filter((call) =>
    call.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === 'drainWorkflowRunsTick')
  );
  assert.equal(laneRegistrations.length, 1, 'workflow recovery lane must be registered once during boot');

  const orderedBootNodes = [
    canonicalToolMigration[0],
    orphanFence[0],
    approvalDrain[0],
    genericChatRecovery[0],
    terminalReportBack[0],
    laneRegistrations[0],
    readyCall,
  ];
  assert.deepEqual(
    [...orderedBootNodes].sort((left, right) => left.getStart() - right.getStart()),
    orderedBootNodes,
    'boot must migrate explicitly, fence, drain exact approvals, recover generic chats, arm report-back, register lanes, then release ingress',
  );

  const cliWarmCalls = callsNamed(startDaemon, 'warmCliScan');
  assert.equal(cliWarmCalls.length, 1, 'CLI discovery warmup must be scheduled once');
  assert.ok(
    cliWarmCalls[0].getStart() > readyCall.getStart(),
    'speculative CLI discovery must not start until ingress readiness succeeds',
  );
});

test('combined daemon and service listeners open only inside onReady', () => {
  const sourceFile = parseSource('index.ts', INDEX_SOURCE);
  const main = namedFunction(sourceFile, 'main');
  const combinedStarts = callsNamed(main, 'startDaemon').filter((call) =>
    call.arguments.some((argument) =>
      ts.isObjectLiteralExpression(argument)
      && argument.properties.some((property) => property.name?.getText() === 'onReady')
    )
  );
  assert.equal(combinedStarts.length, 2, 'foreground daemon and combined service must both use the readiness barrier');

  const expectedListeners = ['startDiscordBot', 'startSlackBot', 'startWebhookServer'];
  const guardedBranches: string[] = [];
  for (const start of combinedStarts) {
    assert.ok(ts.isAwaitExpression(start.parent), 'combined startup must await startDaemon');
    const branch = containingIf(start);
    assert.ok(branch, 'combined startup must remain in an explicit command branch');
    guardedBranches.push(branch.expression.getText(sourceFile).replaceAll(' ', ''));

    const listenerCalls = descendants(
      branch.thenStatement,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && expectedListeners.includes(callName(node) ?? ''),
    );
    assert.deepEqual(
      listenerCalls.map((call) => callName(call)).sort(),
      expectedListeners,
      'each combined mode must register every listener exactly once',
    );
    assert.ok(
      listenerCalls.every(isInsideOnReady),
      'combined-mode listeners must not accept work until daemon recovery is ready',
    );
  }

  assert.ok(guardedBranches.some((condition) => condition.includes("sub==='--foreground'")));
  assert.ok(guardedBranches.some((condition) => condition === "command==='service'"));
});
