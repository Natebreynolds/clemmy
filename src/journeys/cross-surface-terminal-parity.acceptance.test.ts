/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/cross-surface-terminal-parity.acceptance.test.ts
 *
 * Release matrix row 15 — one execution owner and one typed terminal algebra
 * across the real foreground entrypoints. This cohort deliberately invokes
 * the exported production handlers (HTTP Home, Discord, mobile gateway, CLI,
 * and daemon cron scheduler) while replacing only the model/loop boundary.
 * Transport prose is observed as delivery, never used to infer durable truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {
  PresentationEvent,
  TurnOutcome,
} from '../runtime/harness/turn-outcome.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cross-surface-parity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_VERIFY_DELIVERED = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.DISCORD_ENABLED = 'false';
process.env.SLACK_ENABLED = 'false';
process.env.WEBHOOK_ENABLED = 'false';

mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
  accessToken: 'sk-ant-oat01-cross-surface-parity',
  refreshToken: 'cross-surface-parity-refresh',
  expiresAt: Date.now() + 60 * 60_000,
  scopes: ['user:inference'],
}), 'utf8');

const { registerConsoleRoutes } = await import('../dashboard/console-routes.js');
const {
  createMobileRouter,
  MOBILE_SESSION_COOKIE,
  _clearMobileChatInFlightForTests,
} = await import('../channels/mobile-routes.js');
const { runDiscordHarnessConversation } = await import('../channels/discord-harness.js');
const { runHarnessCli } = await import('../cli/harness.js');
const { HARNESS_HELD_EXIT_CODE } = await import('../cli/harness-status.js');
const {
  _testOnly_processCronSchedules: processCronSchedules,
  _testOnly_waitForCronScheduleIdle: waitForCronScheduleIdle,
  cronOccurrenceSessionId,
} = await import('../daemon/runner.js');
const { CRON_FILE } = await import('../memory/vault.js');
const { CRON_RUNS_DIR } = await import('../tools/shared.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const {
  _setBridgeImplsForTests,
} = await import('../runtime/harness/respond-bridge.js');
const {
  appendEvent,
  getLatestRunAttempt,
  listEvents,
  listSessions,
  openEventLog,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const {
  presentationEventFromCompletionData,
  turnOutcomeId,
} = await import('../runtime/harness/turn-outcome.js');
const {
  configureHarnessRuntime,
  resetHarnessRuntimeConfig,
} = await import('../runtime/harness/codex-client.js');
const { _clearIdempotencyForTests } = await import('../runtime/idempotency.js');
const { closePlanScope } = await import('../agents/plan-scope.js');

type CaseName =
  | 'done'
  | 'needs_input'
  | 'blocked'
  | 'uncertain'
  | 'failed'
  | 'cancelled'
  | 'transferred'
  | 'held';
type TerminalOutcomeName = Exclude<CaseName, 'held'>;
type SurfaceName = 'home' | 'discord' | 'mobile' | 'cli' | 'cron';

interface TerminalFixture {
  mode: 'terminal';
  name: TerminalOutcomeName;
  text: string;
  presentationKind: PresentationEvent['kind'];
  resumable: boolean;
  needsKind?: NonNullable<PresentationEvent['needs']>['kind'];
}

interface HeldOwnership {
  owner: 'host';
  wake: 'peer' | 'recovery';
  reason: 'peer_in_progress' | 'recovery_pending';
}

interface HeldFixture {
  mode: 'held';
  name: 'held';
  text: string;
  hold: HeldOwnership;
}

type ParityFixture = TerminalFixture | HeldFixture;

const HELD_OWNERSHIP: HeldOwnership = {
  owner: 'host',
  wake: 'peer',
  reason: 'peer_in_progress',
};

const HELD_REPLY = 'This exact task is still owned by Clem\'s recovery system. I did not start a duplicate attempt; the existing work will continue from its durable checkpoint.';

const CASES: readonly ParityFixture[] = [
  {
    mode: 'terminal',
    name: 'done',
    text: 'The parity fixture completed.',
    presentationKind: 'answer',
    resumable: false,
  },
  {
    mode: 'terminal',
    name: 'needs_input',
    text: 'Which parity input should I use?',
    presentationKind: 'question',
    resumable: true,
    needsKind: 'input',
  },
  {
    mode: 'terminal',
    name: 'blocked',
    text: 'The parity fixture is blocked before execution.',
    presentationKind: 'blocked',
    resumable: true,
  },
  {
    mode: 'terminal',
    name: 'uncertain',
    text: 'The parity fixture may have crossed its boundary and requires reconciliation.',
    presentationKind: 'blocked',
    resumable: true,
  },
  {
    mode: 'terminal',
    name: 'failed',
    text: 'The parity fixture failed at its durable boundary.',
    presentationKind: 'error',
    resumable: false,
  },
  {
    mode: 'terminal',
    name: 'cancelled',
    text: 'The parity fixture was cancelled.',
    presentationKind: 'stopped',
    resumable: false,
  },
  {
    mode: 'terminal',
    name: 'transferred',
    text: 'The parity fixture transferred to its durable background owner.',
    presentationKind: 'transferred',
    resumable: false,
  },
  {
    mode: 'held',
    name: 'held',
    text: HELD_REPLY,
    hold: HELD_OWNERSHIP,
  },
] as const;

const EXPECTED_BRIDGE_SURFACE: Readonly<Record<SurfaceName, string>> = {
  home: 'home',
  discord: 'discord',
  // Mobile enters through ClementineGateway, whose canonical bridge lane is
  // webhook. The accepted source still carries channel/source=mobile.
  mobile: 'webhook',
  cli: 'cli',
  cron: 'cron',
};

const loopEntries: Array<{
  sessionId: string;
  sourceUserSeq: number;
  turnEngine: unknown;
  input: string;
}> = [];
let legacyAssistantCalls = 0;

function fixtureFromInput(input: string): ParityFixture {
  const match = /\[parity:(done|needs_input|blocked|uncertain|failed|cancelled|transferred|held)\]/.exec(input);
  const fixture = CASES.find((candidate) => candidate.name === match?.[1]);
  if (!fixture) throw new Error(`Missing parity fixture marker in: ${input}`);
  return fixture;
}

function outcomeForFixture(
  fixture: TerminalFixture,
  identity: { sessionId: string; turn: number; sourceUserSeq: number },
): TurnOutcome {
  const common = {
    version: 2 as const,
    id: turnOutcomeId(identity),
    identity,
  };
  switch (fixture.name) {
    case 'done':
      return {
        ...common,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: fixture.text },
      };
    case 'needs_input':
      return {
        ...common,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'input' },
        presentation: { kind: 'question', text: fixture.text },
      };
    case 'blocked':
      return {
        ...common,
        status: 'blocked',
        resumable: true,
        presentation: { kind: 'blocked', text: fixture.text },
      };
    case 'uncertain':
      return {
        ...common,
        status: 'uncertain',
        resumable: true,
        presentation: { kind: 'blocked', text: fixture.text },
      };
    case 'failed':
      return {
        ...common,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: fixture.text },
      };
    case 'cancelled':
      return {
        ...common,
        status: 'cancelled',
        resumable: false,
        presentation: { kind: 'stopped', text: fixture.text },
      };
    case 'transferred':
      return {
        ...common,
        status: 'transferred',
        resumable: false,
        presentation: { kind: 'transferred', text: fixture.text },
      };
  }
}

_setBridgeImplsForTests({
  configure: (async () => ({ ok: true })) as never,
  buildAgent: (async () => {
    throw new Error('The generated parity loop fixture must not build or run a model.');
  }) as never,
  runConversation: (async (options: {
    sessionId: string;
    sourceUserSeq?: number;
    turnEngine?: unknown;
    input: string;
  }) => {
    const sourceUserSeq = Number(options.sourceUserSeq);
    assert.ok(Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0,
      'the production entrypoint must bind an exact accepted source before the loop');
    const source = listEvents(options.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === sourceUserSeq);
    assert.ok(source, 'the source sequence must resolve to its durable user event');
    const fixture = fixtureFromInput(options.input);
    loopEntries.push({
      sessionId: options.sessionId,
      sourceUserSeq,
      turnEngine: options.turnEngine,
      input: options.input,
    });

    if (fixture.mode === 'held') {
      return {
        sessionId: options.sessionId,
        status: 'held',
        steps: 0,
        lastTurn: source.turn,
        hold: fixture.hold,
      };
    }

    if (fixture.name === 'needs_input') {
      appendEvent({
        sessionId: options.sessionId,
        turn: source.turn,
        role: 'system',
        type: 'awaiting_user_input',
        data: {
          question: fixture.text,
          sourceUserSeq,
        },
      });
    }

    const committed = commitTurnOutcome(outcomeForFixture(fixture, {
      sessionId: options.sessionId,
      turn: source.turn,
      sourceUserSeq,
    }), {
      legacyReason: fixture.name === 'done'
        ? 'success'
        : fixture.name === 'needs_input'
          ? 'awaiting_user_input'
          : fixture.name === 'uncertain'
            ? 'reconciliation_required'
            : fixture.name,
      metadata: { transport: 'cross_surface_parity_fixture' },
    });

    const status = fixture.name === 'done' || fixture.name === 'transferred'
      ? 'completed'
      : fixture.name === 'needs_input'
        ? 'awaiting_user_input'
        : fixture.name === 'failed'
          ? 'failed'
        : fixture.name === 'cancelled'
          ? 'killed'
          : 'blocked';
    return {
      sessionId: options.sessionId,
      status,
      steps: 1,
      lastTurn: source.turn,
      publicPresentation: committed.presentation,
      lastDecision: {
        summary: fixture.text,
        reply: fixture.text,
        done: fixture.name === 'done',
        nextAction: fixture.name === 'needs_input' ? 'awaiting_user_input' : null,
        reason: null,
      },
    };
  }) as never,
});

const assistant = {
  respond: async () => {
    legacyAssistantCalls += 1;
    throw new Error('No production surface may enter its legacy assistant executor.');
  },
  getRuntime: () => ({ listPendingApprovals: () => [] }),
};

interface HttpHarness {
  url: string;
  close(): Promise<void>;
  mobileStateDir: string;
}

interface SurfaceObservation {
  sessionId: string;
  text: string;
  stoppedReason?: string;
  terminal?: PresentationEvent;
  heldOwnership?: HeldOwnership;
}

async function startHttpHarness(): Promise<HttpHarness> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const mobileStateDir = path.join(TEST_HOME, 'mobile-state');
  app.use('/m', createMobileRouter({
    stateDir: mobileStateDir,
    cookieSecure: false,
    pwaDistDir: null,
    isAdminAuthorized: () => true,
    assistant: assistant as never,
  }));
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mobileStateDir,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function promptFor(surface: SurfaceName, fixture: ParityFixture): string {
  return `Return the generated ${surface} parity fixture. [parity:${fixture.name}]`;
}

function onlyNewSession(before: Set<string>, label: string): string {
  const fresh = listSessions({ status: 'any', limit: 500 })
    .map((session) => session.id)
    .filter((id) => !before.has(id));
  assert.equal(fresh.length, 1, `${label} must create exactly one session; saw ${fresh.join(', ')}`);
  return fresh[0]!;
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${MOBILE_SESSION_COOKIE}=([^;]+)`).exec(raw);
  assert.ok(match, 'mobile login must issue its session cookie');
  return `${MOBILE_SESSION_COOKIE}=${match[1]}`;
}

async function invokeHome(http: HttpHarness, fixture: ParityFixture): Promise<SurfaceObservation> {
  const requestedSessionId = `surface-parity-home-${fixture.name}`;
  const response = await fetch(`${http.url}/api/console/home/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: promptFor('home', fixture),
      sessionId: requestedSessionId,
      clientRequestId: `surface-parity-home-${fixture.name}`,
    }),
  });
  assert.equal(response.status, 200);
  const frames = (await response.text()).trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      type?: string;
      sessionId?: string;
      text?: string;
      error?: string;
      stoppedReason?: string;
    });
  if (fixture.name === 'failed') {
    const failed = frames.findLast((frame) => frame.type === 'error');
    assert.ok(failed, 'Home surfaces a failed terminal through its SSE error frame');
    return {
      sessionId: requestedSessionId,
      text: failed.error ?? '',
      stoppedReason: 'error',
    };
  }
  const done = frames.findLast((frame) => frame.type === 'done');
  assert.equal(done?.sessionId, requestedSessionId, 'Home returns the exact durable session');
  assert.equal(done?.text, fixture.text);
  return {
    sessionId: requestedSessionId,
    text: done.text ?? '',
    stoppedReason: done.stoppedReason,
  };
}

async function invokeDiscord(fixture: ParityFixture): Promise<SurfaceObservation> {
  const before = new Set(listSessions({ status: 'any', limit: 500 }).map((session) => session.id));
  const delivered: string[] = [];
  const held: HeldOwnership[] = [];
  await runDiscordHarnessConversation({
    prompt: promptFor('discord', fixture),
    rawPrompt: promptFor('discord', fixture),
    channelId: `surface-parity-channel-${fixture.name}`,
    userId: `surface-parity-user-${fixture.name}`,
    guildId: 'surface-parity-guild',
    transport: {
      async sendInitial(content) {
        delivered.push(content);
        return {
          async edit(next) { delivered.push(next); },
        };
      },
      async sendError(content) { delivered.push(content); },
      async sendFollowup(content) { delivered.push(content); },
      onState(state) {
        if (state.typedExecutionHold) held.push(state.typedExecutionHold);
      },
    },
  });
  assert.ok(delivered.some((text) => text.includes(fixture.text)),
    `Discord must deliver the committed presentation for ${fixture.name}`);
  if (fixture.mode === 'held') assert.deepEqual(held.at(-1), fixture.hold);
  return {
    sessionId: onlyNewSession(before, `Discord ${fixture.name}`),
    text: fixture.text,
    ...(fixture.mode === 'held'
      ? { stoppedReason: 'in-progress', heldOwnership: held.at(-1) }
      : {}),
  };
}

async function invokeMobile(
  http: HttpHarness,
  cookie: string,
  fixture: ParityFixture,
): Promise<SurfaceObservation> {
  const response = await fetch(`${http.url}/m/api/chat/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': `surface-parity-mobile-${fixture.name}`,
    },
    body: JSON.stringify({ message: promptFor('mobile', fixture) }),
  });
  const rawBody = await response.text();
  assert.equal(response.status, fixture.name === 'failed' ? 500 : 200, rawBody);
  const body = JSON.parse(rawBody) as {
    sessionId?: string;
    reply?: string;
    message?: string;
    stoppedReason?: string;
    terminal?: PresentationEvent;
  };
  assert.ok(body.sessionId, 'mobile returns its accepted durable session');
  if (fixture.mode === 'held') {
    assert.equal(body.reply, fixture.text);
    assert.equal(body.stoppedReason, 'in-progress');
    assert.equal(body.terminal, undefined, 'held mobile work stays nonterminal');
  } else {
    assert.equal(body.terminal?.status, fixture.name);
    assert.equal(body.terminal?.identity.sessionId, body.sessionId);
    assert.equal(body.terminal?.text, fixture.text);
    if (fixture.name === 'failed') {
      assert.equal(body.stoppedReason, 'error');
    } else {
      assert.equal(body.reply, fixture.text, 'mobile delivers the committed presentation text');
    }
  }
  return {
    sessionId: body.sessionId,
    text: body.terminal?.text ?? body.reply ?? body.message ?? '',
    stoppedReason: body.stoppedReason,
    terminal: body.terminal,
  };
}

async function invokeCli(fixture: ParityFixture): Promise<SurfaceObservation> {
  const before = new Set(listSessions({ status: 'any', limit: 500 }).map((session) => session.id));
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const output: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await runHarnessCli(['run', promptFor('cli', fixture)]);
    const expectedExitCode = fixture.name === 'held'
      ? HARNESS_HELD_EXIT_CODE
      : fixture.name === 'blocked' || fixture.name === 'uncertain' || fixture.name === 'failed'
        ? 1
        : 0;
    assert.equal(exitCode, expectedExitCode);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  const rendered = output.join('');
  assert.ok(rendered.includes(fixture.text), `CLI must print ${fixture.name} presentation`);
  if (fixture.mode === 'held') {
    assert.match(rendered, /status:\s+held/);
    assert.match(rendered, /owner:\s+host\/peer \(peer_in_progress\)/);
  }
  return {
    sessionId: onlyNewSession(before, `CLI ${fixture.name}`),
    text: fixture.text,
    ...(fixture.mode === 'held'
      ? { stoppedReason: 'in-progress', heldOwnership: fixture.hold }
      : {}),
  };
}

type CronState = {
  lastCronRunByMinute: Record<string, string>;
  lastCronRunAtMs?: Record<string, number>;
  pendingCronOccurrences?: Record<string, {
    atMs: number;
    minuteKey: string;
    scheduleKey: string;
    firstDueAtMs: number;
    missed: number;
  }>;
  lastCronEvaluatedAtMs?: number;
};

const heldCronSessions = new Set<string>();

async function invokeCron(fixture: ParityFixture): Promise<SurfaceObservation> {
  const jobName = `surface-parity-cron-${fixture.name}`;
  mkdirSync(path.dirname(CRON_FILE), { recursive: true });
  writeFileSync(CRON_FILE, [
    '---',
    'jobs:',
    `  - name: ${jobName}`,
    '    schedule: "* * * * *"',
    `    prompt: "${promptFor('cron', fixture)}"`,
    '    enabled: true',
    '---',
    '',
    '# Cross-surface parity fixture',
  ].join('\n'), 'utf8');
  const now = new Date(Date.UTC(2026, 7, 27, 18, CASES.indexOf(fixture), 10));
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: now.getTime() - 60_000,
  };
  await processCronSchedules(assistant as never, state as never, now);
  await waitForCronScheduleIdle();
  const sessionId = cronOccurrenceSessionId(jobName, Math.floor(now.getTime() / 60_000) * 60_000);
  const records = readFileSync(path.join(CRON_RUNS_DIR, `${jobName}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as {
      status?: string;
      response?: string;
      nonterminal?: {
        kind?: string;
        stoppedReason?: string;
        ownership?: HeldOwnership;
      };
    });
  const record = records.at(-1);
  assert.ok(record);
  if (fixture.mode === 'held') {
    heldCronSessions.add(sessionId);
    assert.equal(record.status, 'held');
    assert.equal(record.nonterminal?.kind, 'held');
    assert.equal(record.nonterminal?.stoppedReason, 'in-progress');
    assert.deepEqual(record.nonterminal?.ownership, fixture.hold);
  }
  return {
    sessionId,
    text: record.response ?? '',
    ...(fixture.mode === 'held'
      ? {
          stoppedReason: record.nonterminal?.stoppedReason,
          heldOwnership: record.nonterminal?.ownership,
        }
      : {}),
  };
}

function assertOneExecutionOwner(
  surface: SurfaceName,
  fixture: ParityFixture,
  sessionId: string,
  sourceUserSeq: number,
): void {
  const routed = listEvents(sessionId, { types: ['turn_model_routed'] })
    .filter((event) => event.data.sourceUserSeq === sourceUserSeq);
  assert.equal(routed.length, 1, `${surface}/${fixture.name} has one routed execution owner`);
  assert.equal(routed[0]!.data.routeKind, 'harness');
  assert.equal(routed[0]!.data.transport, 'host_harness');
  assert.equal(routed[0]!.data.surface, EXPECTED_BRIDGE_SURFACE[surface]);

  const owner = openEventLog().prepare(`
    SELECT COUNT(*) AS count
      FROM run_attempts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as { count: number };
  assert.equal(owner.count, 1, `${surface}/${fixture.name} has exactly one physical run owner`);

  const entries = loopEntries.filter((entry) =>
    entry.sessionId === sessionId
    && entry.sourceUserSeq === sourceUserSeq);
  assert.equal(entries.length, 1, `${surface}/${fixture.name} enters the shared loop exactly once`);
  assert.equal(entries[0]!.turnEngine, 'host_v1', `${surface}/${fixture.name} is host_v1-owned`);
}

function assertDurableCase(
  surface: SurfaceName,
  fixture: TerminalFixture,
  sessionId: string,
): PresentationEvent {
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, `${surface}/${fixture.name} has one durable terminal`);
  const presentation = presentationEventFromCompletionData(terminals[0]!.data);
  assert.ok(presentation, `${surface}/${fixture.name} terminal has a typed presentation`);
  assert.equal(presentation.status, fixture.name);
  assert.equal(presentation.kind, fixture.presentationKind);
  assert.equal(presentation.resumable, fixture.resumable);
  assert.equal(presentation.needs?.kind, fixture.needsKind);
  assert.equal(presentation.text, fixture.text);
  assert.equal(terminals[0]!.data.terminalKey, `turn:${presentation.identity.sourceUserSeq}`);
  assertOneExecutionOwner(surface, fixture, sessionId, presentation.identity.sourceUserSeq);
  return presentation;
}

function assertHeldCase(
  surface: SurfaceName,
  fixture: HeldFixture,
  observation: SurfaceObservation,
): void {
  const { sessionId } = observation;
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0,
    `${surface}/held stays nonterminal`);
  const sources = listEvents(sessionId, { types: ['user_input_received'] });
  assert.equal(sources.length, 1, `${surface}/held has one exact accepted source`);
  const source = sources[0]!;
  assert.equal(observation.stoppedReason, 'in-progress', `${surface}/held reports its typed stop`);
  assert.equal(observation.text, fixture.text, `${surface}/held delivers the canonical acknowledgement`);
  if (observation.heldOwnership) assert.deepEqual(observation.heldOwnership, fixture.hold);
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt, `${surface}/held retains its durable run attempt`);
  assert.equal(attempt.sourceUserSeq, source.seq);
  assert.equal(attempt.status, 'active');
  assert.equal(attempt.finishedAt, null);
  assertOneExecutionOwner(surface, fixture, sessionId, source.seq);
}

test('release row 15: Home, Discord, mobile, CLI, and cron share one host_v1 owner and typed outcome algebra', async () => {
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  resetHarnessRuntimeConfig();
  const configured = await configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.reason);
  const http = await startHttpHarness();
  try {
    await setPin('ParityPin1!', { stateDir: http.mobileStateDir });
    const login = await fetch(`${http.url}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'ParityPin1!', deviceLabel: 'Parity phone' }),
    });
    assert.equal(login.status, 200);
    const mobileCookie = cookieFrom(login);

    const terminalCohort = new Map<TerminalOutcomeName, Map<SurfaceName, PresentationEvent>>();
    for (const fixture of CASES) {
      const observations: Record<SurfaceName, SurfaceObservation> = {
        home: await invokeHome(http, fixture),
        discord: await invokeDiscord(fixture),
        mobile: await invokeMobile(http, mobileCookie, fixture),
        cli: await invokeCli(fixture),
        cron: await invokeCron(fixture),
      };
      if (fixture.mode === 'held') {
        for (const surface of Object.keys(observations) as SurfaceName[]) {
          assertHeldCase(surface, fixture, observations[surface]);
        }
        continue;
      }
      const presentations = new Map<SurfaceName, PresentationEvent>();
      for (const surface of Object.keys(observations) as SurfaceName[]) {
        presentations.set(surface, assertDurableCase(surface, fixture, observations[surface].sessionId));
      }
      terminalCohort.set(fixture.name, presentations);
    }

    for (const fixture of CASES) {
      if (fixture.mode === 'held') continue;
      const shapes = [...terminalCohort.get(fixture.name)!.values()].map((presentation) => ({
        status: presentation.status,
        kind: presentation.kind,
        resumable: presentation.resumable,
        needs: presentation.needs?.kind ?? null,
      }));
      assert.deepEqual(shapes, Array.from({ length: 5 }, () => shapes[0]),
        `${fixture.name} must retain the same typed terminal shape across every surface`);
    }
    assert.equal(legacyAssistantCalls, 0, 'no alternate/legacy execution engine ran');
    assert.equal(loopEntries.length, CASES.length * 5, 'one shared loop activation per generated case');
  } finally {
    await http.close();
    await waitForCronScheduleIdle();
    for (const sessionId of heldCronSessions) closePlanScope(sessionId, 'journey-cleanup');
  }
});

test.after(async () => {
  await waitForCronScheduleIdle();
  _setBridgeImplsForTests({});
  resetHarnessRuntimeConfig();
  resetEventLog();
  _clearIdempotencyForTests();
  _clearMobileChatInFlightForTests();
  for (const sessionId of heldCronSessions) closePlanScope(sessionId, 'journey-cleanup');
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
