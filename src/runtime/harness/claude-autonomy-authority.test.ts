/**
 * Release contract for decision-only autonomy on Claude OAuth.
 *
 * Every brain now enters through the production host owner. An empty per-call
 * allowlist must survive the bridge and reach that host-owned agent build
 * unchanged; Claude OAuth must not reopen the retired standalone SDK owner.
 *
 * Run:
 *   npx tsx --test src/runtime/harness/claude-autonomy-authority.test.ts
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-autonomy-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  _setBridgeImplsForTests,
  respondPreferHarness,
} = await import('./respond-bridge.js');
const { resetEventLog } = await import('./eventlog.js');

beforeEach(() => {
  resetEventLog();
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
  });
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_HARNESS_CRON = 'on';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
});

after(() => {
  _setBridgeImplsForTests({});
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('Claude OAuth cron honors explicit decision-only authority end to end', async () => {
  let builtWith: {
    allowedToolNames?: string[];
    excludeToolNames?: string[];
    allowToolJit?: boolean;
    acceptedRoute?: 'direct_reply' | 'retrieve' | 'act';
  } | undefined;
  let legacyCalls = 0;
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async (options: typeof builtWith) => {
      builtWith = options;
      return {};
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq: number;
      buildAgent?: (identity: {
        sessionId: string;
        sourceUserSeq: number;
        route: 'direct_reply' | 'retrieve' | 'act';
      }) => Promise<unknown>;
    }) => {
      await options.buildAgent?.({
        sessionId: options.sessionId,
        sourceUserSeq: options.sourceUserSeq,
        route: 'direct_reply',
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Decision only.',
          reply: JSON.stringify({ summary: 'Decision only.', commitments: [], actions: [] }),
          done: true,
          nextAction: 'completed',
          reason: null,
        },
      };
    }) as never,
  });

  const response = await respondPreferHarness('cron', {
    message: 'Return the closed autonomy decision JSON.',
    sessionId: 'agent:claude-decision-only',
    allowedToolNames: [],
  }, async (request) => {
    legacyCalls += 1;
    return { text: 'unsafe legacy fallback', sessionId: request.sessionId };
  });

  assert.equal(response.stoppedReason, 'success');
  assert.equal(legacyCalls, 0, 'an explicit authority boundary must never fall back to a wider legacy lane');
  assert.ok(builtWith, 'precondition: the production host owner built the cron turn');
  assert.equal(builtWith.acceptedRoute, 'direct_reply', 'the host binds the compiled decision route');
  assert.deepEqual(builtWith.allowedToolNames, [], 'the host tool surface remains explicitly empty');
  assert.equal(
    builtWith.allowToolJit,
    true,
    'execution-lane schema-on-demand admission is transport policy; the exact empty allowlist remains authority',
  );
  assert.equal(response.route?.routeKind, 'harness');
  assert.equal(response.route?.provider, 'claude');
  assert.equal(response.route?.transport, 'host_harness');
});

test('explicit decision-only authority blocks instead of using legacy fallback when cron harness is disabled', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalls = 0;

  const response = await respondPreferHarness('cron', {
    message: 'Return a decision.',
    sessionId: 'agent:claude-no-legacy',
    allowedToolNames: [],
  }, async (request) => {
    legacyCalls += 1;
    return { text: 'unsafe legacy fallback', sessionId: request.sessionId };
  });

  assert.equal(legacyCalls, 0);
  assert.equal(response.stoppedReason, 'blocked');
  assert.match(response.text, /runtime lane is temporarily unavailable/i);
  assert.doesNotMatch(response.text, /harness|CLEMMY_/i, 'public preflight copy stays free of runtime internals');
});
