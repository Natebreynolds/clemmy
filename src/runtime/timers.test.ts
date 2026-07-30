/**
 * Run: npx tsx --test src/runtime/timers.test.ts
 * set_timer firing half (2026-07-20): the tool used to be WRITE-ONLY — no
 * consumer existed, every reminder silently lost. These tests pin the
 * late-but-never-lost contract.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-timers-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { appendTimer, readTimers, writeTimers, fireDueTimers } = await import('./timers.js');
const { TIMERS_FILE } = await import('../tools/shared.js');
const {
  listNotifications,
  listQueuedNotificationDeliveries,
  getNotificationDestinationsForRecord,
  _failNextNotificationDeliveryQueueWriteForTest,
} = await import('./notifications.js');
const { registerAdminTools } = await import('../tools/admin-tools.js');
const { withToolOutputContext } = await import('./harness/tool-output-context.js');
const { createSession } = await import('./harness/eventlog.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

const NOW = 1_780_000_000_000;

type SetTimerHandler = (input: {
  message: string;
  minutes?: number;
  fire_at?: string;
}) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function captureSetTimerHandler(): SetTimerHandler {
  let handler: SetTimerHandler | undefined;
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      candidate: SetTimerHandler,
    ): void {
      if (name === 'set_timer') handler = candidate;
    },
  };
  registerAdminTools(fakeServer as unknown as McpServer);
  assert.ok(handler, 'set_timer should register');
  return handler!;
}

test('absolute reminder preserves its offset + Discord origin and fires exactly once', async () => {
  const sessionId = 'discord-reminder-incident';
  const discordUserId = 'discord-user-42';
  const fireAtInput = '2026-07-30T22:00:00-07:00';
  const fireAt = Date.parse(fireAtInput);
  createSession({
    id: sessionId,
    kind: 'chat',
    channel: 'discord',
    userId: discordUserId,
    title: 'Reminder incident replay',
  });

  const handler = captureSetTimerHandler();
  const result = await (async () => {
    const realDateNow = Date.now;
    Date.now = () => Date.parse('2026-07-30T20:00:00-07:00');
    try {
      return await withToolOutputContext(
        { sessionId },
        () => handler({
          fire_at: fireAtInput,
          message: 'Authenticate Railway and finish the deployment',
        }),
      );
    } finally {
      Date.now = realDateNow;
    }
  })();

  const [stored] = readTimers() as Array<{
    id: string;
    message: string;
    fireAt: number;
    metadata?: Record<string, unknown>;
  }>;
  assert.ok(stored, 'the absolute reminder must be persisted');
  assert.equal(stored.fireAt, fireAt, 'the offset-bearing timestamp must resolve to the exact requested instant');
  assert.match(
    result.content[0]?.text ?? '',
    new RegExp(fireAtInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the confirmation must preserve the user-requested offset instead of silently rewriting the wall clock',
  );
  assert.equal(stored.metadata?.originSessionId, sessionId);
  assert.equal(stored.metadata?.discordUserId, discordUserId);

  assert.equal(fireDueTimers(fireAt - 1), 0, 'the reminder never fires early');
  assert.equal(fireDueTimers(fireAt), 1, 'the reminder fires when its exact instant is due');
  assert.equal(fireDueTimers(fireAt + 60_000), 0, 'a subsequent daemon tick cannot fire it twice');

  const matching = listNotifications().filter((notification) => notification.id === `timer-fired-${stored.id}`);
  assert.equal(matching.length, 1, 'exactly one durable notification is materialized');
  const reminder = matching[0]!;
  assert.equal(reminder.metadata?.originSessionId, sessionId);
  assert.equal(reminder.metadata?.discordUserId, discordUserId);
  assert.ok(
    getNotificationDestinationsForRecord(reminder)
      .some((destination) => destination.type === 'discord_user' && destination.userId === discordUserId),
    'delivery resolves to the Discord user who requested the reminder, not a primary-user fallback',
  );
});

test('a production-shaped Discord gateway session routes the reminder to its exact channel', async () => {
  writeTimers([]);
  const sessionId = 'discord-gateway-reminder';
  const channelId = 'discord-channel-84';
  createSession({
    id: sessionId,
    kind: 'chat',
    channel: `discord:guild:${channelId}`,
    userId: 'discord-user-84',
    title: 'Gateway reminder',
    metadata: {
      source: 'discord-gateway',
      channelId,
      guildId: 'discord-guild-84',
    },
  });

  const handler = captureSetTimerHandler();
  const now = Date.parse('2026-07-30T20:00:00-07:00');
  const realDateNow = Date.now;
  Date.now = () => now;
  try {
    await withToolOutputContext(
      { sessionId },
      () => handler({
        fire_at: '2026-07-30T22:00:00-07:00',
        message: 'Review the deployment',
      }),
    );
  } finally {
    Date.now = realDateNow;
  }

  const [stored] = readTimers();
  assert.equal(stored?.metadata?.originSessionId, sessionId);
  assert.equal(stored?.metadata?.discordChannelId, channelId);
  assert.equal(stored?.metadata?.discordUserId, undefined);

  assert.equal(fireDueTimers(stored!.fireAt), 1);
  const reminder = listNotifications().find(
    (notification) => notification.id === `timer-fired-${stored!.id}`,
  );
  assert.ok(reminder);
  assert.ok(
    getNotificationDestinationsForRecord(reminder)
      .some((destination) => destination.type === 'discord_channel' && destination.channelId === channelId),
    'the notification must return to the exact Discord channel that requested it',
  );
});

test('set_timer rejects ambiguous, stale, timezone-less, and over-horizon exact times without writing', async () => {
  writeTimers([]);
  const handler = captureSetTimerHandler();
  const now = Date.parse('2026-07-30T20:00:00-07:00');
  const realDateNow = Date.now;
  Date.now = () => now;
  try {
    const invalidInputs: Array<Parameters<SetTimerHandler>[0]> = [
      { message: 'missing schedule' },
      {
        message: 'two schedules',
        minutes: 30,
        fire_at: '2026-07-30T22:00:00-07:00',
      },
      { message: 'past schedule', fire_at: '2026-07-30T19:59:00-07:00' },
      { message: 'ambiguous local time', fire_at: '2026-07-30T22:00:00' },
      { message: 'too far away', fire_at: '2026-08-01T20:00:01-07:00' },
    ];
    for (const input of invalidInputs) {
      const result = await handler(input);
      assert.match(result.content[0]?.text ?? '', /refused/i, JSON.stringify(input));
      assert.match(result.content[0]?.text ?? '', /No reminder was scheduled/i, JSON.stringify(input));
    }
  } finally {
    Date.now = realDateNow;
  }
  assert.deepEqual(readTimers(), [], 'invalid schedules have zero durable side effects');
});

test('relative minutes remains backwards-compatible', async () => {
  writeTimers([]);
  const handler = captureSetTimerHandler();
  const now = Date.parse('2026-07-30T20:00:00-07:00');
  const realDateNow = Date.now;
  Date.now = () => now;
  try {
    const result = await handler({ message: 'check the oven', minutes: 15 });
    assert.match(result.content[0]?.text ?? '', /15 minutes from now/);
  } finally {
    Date.now = realDateNow;
  }
  const [stored] = readTimers();
  assert.equal(stored?.fireAt, now + 15 * 60_000);
});

test('a cross-process lock held past the old fail-open window cannot erase a concurrent append', async () => {
  writeTimers([]);
  const lockFile = `${TIMERS_FILE}.lock`;
  const childScript = `
    const fs = require('node:fs');
    const timerFile = process.argv[1];
    const lockFile = timerFile + '.lock';
    fs.writeFileSync(lockFile, process.pid + ':' + Date.now(), { flag: 'wx' });
    process.stdout.write('locked\\n');
    setTimeout(() => {
      fs.writeFileSync(timerFile, JSON.stringify([{
        id: 'child-timer',
        message: 'written by the lock holder',
        fireAt: ${NOW + 60_000},
        createdAt: ${NOW}
      }]));
      fs.unlinkSync(lockFile);
      process.exit(0);
    }, 2300);
  `;
  const child = spawn(process.execPath, ['-e', childScript, TIMERS_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.stdout?.once('data', (chunk) => {
      if (String(chunk).includes('locked')) resolve();
      else reject(new Error(`unexpected child output: ${String(chunk)} ${stderr}`));
    });
  });
  const childExit = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
  });

  appendTimer({
    id: 'parent-timer',
    message: 'appended after waiting for the lock',
    fireAt: NOW + 120_000,
    createdAt: NOW,
  });
  await childExit;

  assert.deepEqual(
    readTimers().map((timer) => timer.id).sort(),
    ['child-timer', 'parent-timer'],
    'the contender waits for ownership and preserves both durable commitments',
  );
  assert.equal(existsSync(lockFile), false);
});

test('a partial notification-queue write retains the timer and retry repairs delivery exactly once', () => {
  const timerId = 'queue-repair-timer';
  writeTimers([{
    id: timerId,
    message: 'retry this reminder safely',
    fireAt: NOW,
    createdAt: NOW - 60_000,
    metadata: { discordUserId: 'discord-user-retry' },
  }]);
  _failNextNotificationDeliveryQueueWriteForTest();

  assert.equal(fireDueTimers(NOW), 0, 'a queue persistence failure is not counted as a fired reminder');
  assert.ok(readTimers().some((timer) => timer.id === timerId), 'the timer remains durable for retry');
  assert.equal(
    listNotifications().filter((notification) => notification.id === `timer-fired-${timerId}`).length,
    1,
    'the first durable half exists with a stable notification id',
  );

  assert.equal(fireDueTimers(NOW + 1_000), 1, 'the next daemon tick repairs the missing queue job');
  assert.equal(readTimers().some((timer) => timer.id === timerId), false, 'the timer clears only after queue repair');
  assert.equal(
    listQueuedNotificationDeliveries()
      .filter((job) => job.notificationId === `timer-fired-${timerId}`).length,
    1,
    'retry produces exactly one outbound delivery job',
  );
});

test('a due timer fires as a notification and is removed; a future one stays', () => {
  writeTimers([
    { id: 'due-1', message: 'call the client back', fireAt: NOW - 60_000, createdAt: NOW - 30 * 60_000 },
    { id: 'future-1', message: 'file the brief', fireAt: NOW + 60 * 60_000, createdAt: NOW },
  ]);
  const fired = fireDueTimers(NOW);
  assert.equal(fired, 1);
  const notes = listNotifications();
  const reminder = notes.find((n) => n.id === 'timer-fired-due-1');
  assert.ok(reminder, 'the reminder actually reaches the user');
  assert.match(reminder!.body, /call the client back/);
  const remaining = readTimers();
  assert.deepEqual(remaining.map((t) => t.id), ['future-1'], 'fired removed, future kept');
});

test('late-but-never-lost: a timer overdue by hours fires with an honest delay note', () => {
  writeTimers([{ id: 'late-1', message: 'send the retainer', fireAt: NOW - 3 * 60 * 60_000, createdAt: NOW - 4 * 60 * 60_000 }]);
  assert.equal(fireDueTimers(NOW), 1);
  const reminder = listNotifications().find((n) => n.id === 'timer-fired-late-1');
  assert.ok(reminder);
  assert.match(reminder!.body, /delayed 180 min/, 'the user is told it is late, not gaslit');
});

test('a just-in-time fire carries no delay note', () => {
  writeTimers([{ id: 'ontime-1', message: 'stand-up', fireAt: NOW - 10_000, createdAt: NOW - 60_000 }]);
  fireDueTimers(NOW);
  const reminder = listNotifications().find((n) => n.id === 'timer-fired-ontime-1');
  assert.ok(reminder);
  assert.doesNotMatch(reminder!.body, /delayed/);
});

test('a corrupt store is quarantined + surfaced, never silently emptied', () => {
  writeFileSync(TIMERS_FILE, '{ not json', 'utf-8');
  const timers = readTimers();
  assert.deepEqual(timers, []);
  assert.equal(existsSync(TIMERS_FILE), false, 'corrupt file moved aside, not left to re-fail');
  const dir = path.dirname(TIMERS_FILE);
  assert.ok(readdirSync(dir).some((f) => f.includes('.timers.json.corrupt-')), 'bytes survive for repair');
  assert.ok(
    listNotifications().some((n) => n.title === 'Reminder store was corrupt'),
    'the user learns reminders are in limbo',
  );
});

test('an empty/absent store is a cheap no-op', () => {
  assert.equal(fireDueTimers(NOW), 0);
});
