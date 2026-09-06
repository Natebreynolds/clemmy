import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  actionStreamStillLive,
  applyActionFrame,
  CONSOLE_LIVE_QUERY_KEYS,
  createActionStreamState,
  flushDelayMs,
  mergeInvalidations,
  nextReconnectDelayMs,
  parseActionEvent,
  pollIntervalForStream,
  queryKeysForActionEvent,
  STREAM_SILENCE_LIMIT_MS,
  subscribeActionStream,
  actionStreamStatus,
} from './action-stream';

const runEvent = (runId: string, eventId: string, at: string, runStatus = 'running') => ({
  kind: 'run.event',
  runId,
  sessionId: 'sess-1',
  runTitle: 'Collect the prospects',
  runStatus,
  event: { id: eventId, type: 'tool_called', message: 'searching', createdAt: at },
});

const harnessEvent = (eventId: string, type: string, at = '2026-09-06T10:00:00.000Z') => ({
  kind: 'harness.event',
  sessionId: 'sess-1',
  event: { id: eventId, seq: 4, type, createdAt: at },
});

test('a frame from a newer daemon, or one missing its identity, is dropped rather than routed', () => {
  assert.equal(parseActionEvent({ kind: 'something.new', id: 'x' }), null);
  assert.equal(parseActionEvent({ kind: 'run.event', runId: 'run-1', event: {} }), null);
  assert.equal(parseActionEvent({ kind: 'approval.created', approval: {} }), null);
  assert.equal(parseActionEvent('not an object'), null);
  assert.equal(parseActionEvent(runEvent('run-1', 'ev-1', 'x'))?.kind, 'run.event');
});

test('routing: a run that ENDED also settles the history queries; an open one does not', () => {
  const open = parseActionEvent(runEvent('run-1', 'ev-1', '2026-09-06T10:00:00.000Z', 'running'))!;
  const ended = parseActionEvent(runEvent('run-1', 'ev-2', '2026-09-06T10:00:01.000Z', 'completed'))!;
  assert.deepEqual([...queryKeysForActionEvent(open)], ['board', 'working-now-badge', 'command-center']);
  assert.ok(queryKeysForActionEvent(ended).includes('delivered'), 'the delivered shelf gains the finished run');
});

test('routing: transcript chatter refreshes nothing, progress refreshes only the live work', () => {
  const token = parseActionEvent(harnessEvent('ev-token', 'stream_token'))!;
  const tool = parseActionEvent(harnessEvent('ev-tool', 'tool_called'))!;
  const approval = parseActionEvent(harnessEvent('ev-appr', 'approval_requested'))!;
  assert.deepEqual([...queryKeysForActionEvent(token)], []);
  assert.deepEqual([...queryKeysForActionEvent(tool)], ['board', 'working-now-badge']);
  assert.ok(queryKeysForActionEvent(approval).includes('approvals'));
  assert.ok(queryKeysForActionEvent(approval).includes('inbox-questions'));
});

test('routing: the telemetry feed is not re-routed here, it has its own stream', () => {
  // Belt and braces: the transport does not even listen for this kind, but a
  // replay frame could still carry one and it must route to nothing.
  const operational = parseActionEvent({
    kind: 'operational.event',
    event: { eventId: 'op-1', ts: '2026-09-06T10:00:00.000Z', source: 'tool', type: 'tool_call' },
  })!;
  assert.deepEqual([...queryKeysForActionEvent(operational)], []);
});

test('replay then live: an event already in the replay invalidates nothing a second time', () => {
  const start = createActionStreamState();
  const replay = applyActionFrame(start, {
    kind: 'replay',
    events: [
      runEvent('run-1', 'ev-1', '2026-09-06T10:00:00.000Z'),
      runEvent('run-1', 'ev-2', '2026-09-06T10:00:01.000Z'),
    ],
  });
  assert.equal(replay.state.seen.length, 2);
  assert.ok(replay.invalidate.includes('board'));

  const echoed = applyActionFrame(replay.state, {
    kind: 'event',
    event: runEvent('run-1', 'ev-2', '2026-09-06T10:00:01.000Z'),
  });
  assert.equal(echoed.state.seen.length, 2, 'the duplicate never applied');
  assert.deepEqual(echoed.invalidate, [], 'and so cost no refetch');

  const fresh = applyActionFrame(echoed.state, {
    kind: 'event',
    event: runEvent('run-1', 'ev-3', '2026-09-06T10:00:02.000Z'),
  });
  assert.equal(fresh.state.seen.length, 3);
  assert.ok(fresh.invalidate.includes('board'));
});

// A frame that arrives out of order must not be mistaken for one already seen:
// the reducer folds on identity alone, never on when an event claims to have
// happened, so the newer-then-older order below lands exactly like the reverse.
test('an event arriving out of order is applied, not dropped as stale', () => {
  const newestFirst = [
    runEvent('run-1', 'ev-late', '2026-09-06T10:00:05.000Z'),
    runEvent('run-1', 'ev-early', '2026-09-06T10:00:01.000Z'),
  ];
  let out = createActionStreamState();
  const invalidations: string[][] = [];
  for (const event of newestFirst) {
    const step = applyActionFrame(out, { kind: 'event', event });
    out = step.state;
    invalidations.push(step.invalidate);
  }
  assert.equal(out.seen.length, 2, 'the late-arriving earlier event is new information');
  assert.ok(invalidations[1].includes('board'));

  let reversed = createActionStreamState();
  for (const event of [...newestFirst].reverse()) {
    reversed = applyActionFrame(reversed, { kind: 'event', event }).state;
  }
  assert.deepEqual([...reversed.seen].sort(), [...out.seen].sort(), 'arrival order changes nothing');
});

test('a reconnect replays the same window without a refetch storm', () => {
  const window = [
    runEvent('run-1', 'ev-1', '2026-09-06T10:00:00.000Z'),
    { kind: 'approval.created', approval: { id: 'appr-1', createdAt: '2026-09-06T10:00:01.000Z' } },
    { kind: 'notification.created', notification: { id: 'notif-1', createdAt: '2026-09-06T10:00:02.000Z' } },
  ];
  const first = applyActionFrame(createActionStreamState(), { kind: 'replay', events: window });
  assert.equal(first.state.seen.length, 3);

  const reconnect = applyActionFrame(first.state, { kind: 'replay', events: window });
  assert.equal(reconnect.state.seen.length, 3, 'nothing re-applied');
  assert.deepEqual(reconnect.invalidate, []);
  assert.equal(reconnect.state, first.state, 'and the state is not even re-allocated');

  const withNew = applyActionFrame(first.state, {
    kind: 'replay',
    events: [...window, runEvent('run-1', 'ev-4', '2026-09-06T10:00:03.000Z')],
  });
  assert.equal(withNew.state.seen.length, 4, 'the one genuinely new event in the window still lands');
  assert.ok(withNew.invalidate.includes('board'));
});

test('a focus change refreshes the focus rail and nothing else', () => {
  const focus = { kind: 'focus.changed', reason: 'set', activeTitle: 'X', activeId: 2 };
  const applied = applyActionFrame(createActionStreamState(), { kind: 'event', event: focus });
  assert.deepEqual([...applied.invalidate], ['focus', 'command-center']);
});

test('a kind with no durable identity always applies — a repeated transition is real', () => {
  const transition = {
    kind: 'execution.transitioned',
    executionId: 'exec-1',
    title: 'Nurture sequence',
    previousState: 'active',
    nextState: 'review',
  };
  const once = applyActionFrame(createActionStreamState(), { kind: 'event', event: transition });
  const twice = applyActionFrame(once.state, { kind: 'event', event: transition });
  assert.ok(once.invalidate.includes('board'));
  assert.ok(twice.invalidate.includes('board'), 'the repeat refreshes again rather than being swallowed');
});

test('the seen ring stays bounded on a console left open all day', () => {
  let state = createActionStreamState();
  for (let index = 0; index < 700; index += 1) {
    state = applyActionFrame(state, {
      kind: 'event',
      event: harnessEvent(`ev-${index}`, 'heartbeat'),
    }).state;
  }
  assert.ok(state.seen.length <= 600, `seen grew to ${state.seen.length}`);
  const newest = applyActionFrame(state, { kind: 'event', event: harnessEvent('ev-699', 'heartbeat') });
  assert.equal(newest.state, state, 'the most recent events are still deduped');
});

test('invalidations merge without duplicating a key', () => {
  assert.deepEqual(mergeInvalidations(['board'], ['board', 'command-center']), ['board', 'command-center']);
  assert.deepEqual(mergeInvalidations([], []), []);
  assert.deepEqual(mergeInvalidations(['a'], []), ['a']);
});

test('reconnect backoff climbs and then holds at the ceiling', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(nextReconnectDelayMs), [1000, 2000, 4000, 8000, 8000, 8000]);
});

test('a burst of events coalesces into about one refresh a second', () => {
  // Idle: the first event flushes on the short trailing gap.
  assert.equal(flushDelayMs({ now: 10_000, lastFlushAt: 0 }), 150);
  // Mid-burst: the next batch waits out the minimum gap instead of refetching
  // once per tool call.
  assert.equal(flushDelayMs({ now: 10_100, lastFlushAt: 10_000 }), 800);
  assert.equal(flushDelayMs({ now: 11_000, lastFlushAt: 10_000 }), 150);
});

test('a live stream slows the poll to a safety net; a degraded one restores it', () => {
  // The net is also the query's staleTime (lib/poll.ts), so it is kept well
  // under a minute: a long one suppresses refetch-on-focus too, and the last
  // thing the stream heard would be all a returning user sees for that window.
  assert.equal(pollIntervalForStream('live', 4000), 20_000);
  assert.ok(pollIntervalForStream('live', 4000) < 60_000);
  assert.equal(pollIntervalForStream('degraded', 4000), 4000);
  assert.equal(pollIntervalForStream('connecting', 4000), 4000);
  // A poll already slower than the safety net is never sped UP by the stream.
  assert.equal(pollIntervalForStream('live', 300_000), 300_000);
});

// ─── The ring must survive the traffic it ignores ────────────────────────────

test('events that invalidate nothing never cost a dedupe slot', () => {
  let state = createActionStreamState();
  const replayable = [
    runEvent('run-1', 'ev-1', '2026-09-06T10:00:00.000Z'),
    { kind: 'approval.created', approval: { id: 'apr-1' } },
  ];
  state = applyActionFrame(state, { kind: 'replay', events: replayable }).state;
  assert.equal(state.seen.length, 2);

  // One 700-token chat reply. Every eventlog row reaches this module as a
  // harness.event with a durable id, stream_token included — recording those
  // would evict the whole ring and leave the next reconnect's replay to
  // re-invalidate everything it re-delivers.
  for (let index = 0; index < 700; index += 1) {
    const applied = applyActionFrame(state, {
      kind: 'event',
      event: harnessEvent(`tok-${index}`, 'stream_token'),
    });
    assert.deepEqual(applied.invalidate, [], 'a token routes to no query');
    state = applied.state;
  }
  assert.equal(state.seen.length, 2, 'the ring is untouched by traffic it routes nowhere');

  const reconnect = applyActionFrame(state, { kind: 'replay', events: replayable });
  assert.deepEqual(reconnect.invalidate, [], 'so a reconnect after a long reply still costs no refetch');
});

// ─── 'live' is a claim about NOW ─────────────────────────────────────────────

test("a stream that has gone quiet stops being called live, and a closed socket never was", () => {
  const base = { status: 'live' as const, socketOpen: true, now: 100_000, silenceLimitMs: 45_000 };
  assert.equal(actionStreamStillLive({ ...base, lastHeardAt: 99_000 }), true);
  assert.equal(actionStreamStillLive({ ...base, lastHeardAt: 55_001 }), true, 'just inside the window');
  // The half-open socket after a laptop sleep: readyState still says OPEN, no
  // onerror ever fires, and the only observable is that nothing has arrived.
  assert.equal(actionStreamStillLive({ ...base, lastHeardAt: 55_000 }), false);
  assert.equal(actionStreamStillLive({ ...base, lastHeardAt: 10 }), false);
  assert.equal(actionStreamStillLive({ ...base, socketOpen: false, lastHeardAt: 99_999 }), false);
  // A tab nobody is looking at is owed nothing — return-to-visible re-verifies
  // and re-asks unconditionally, so churning a hidden tab buys nothing.
  assert.equal(actionStreamStillLive({ ...base, lastHeardAt: 10, hidden: true }), true);
  // And a channel that never claimed live cannot be kept alive by silence.
  assert.equal(actionStreamStillLive({ ...base, status: 'connecting', lastHeardAt: 99_999 }), false);
  assert.equal(actionStreamStillLive({ ...base, status: 'degraded', lastHeardAt: 99_999 }), false);
});

// ─── The transport, against a fake socket ────────────────────────────────────
//
// The reconnect ladder and the visibility rules are where the "stale shown as
// live" defect lives, so they are exercised rather than reasoned about: a fake
// EventSource plus node's mock timers make a two-minute laptop sleep a
// deterministic sequence of calls.

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();

  constructor(readonly url: string) { FakeEventSource.opened.push(this); }

  addEventListener(name: string, fn: (e: unknown) => void): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }

  close(): void { this.closed = true; this.readyState = FakeEventSource.CLOSED; }

  /** The daemon accepted the connection. */
  accept(): void { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }

  /** One named SSE frame arrives. */
  deliver(name: string, payload: unknown): void {
    for (const fn of this.handlers.get(name) ?? []) fn({ data: JSON.stringify(payload) });
  }
}

const fakeDocument = {
  hidden: false,
  handlers: new Set<() => void>(),
  addEventListener(_name: string, fn: () => void) { this.handlers.add(fn); },
  removeEventListener(_name: string, fn: () => void) { this.handlers.delete(fn); },
  setHidden(hidden: boolean) { this.hidden = hidden; for (const fn of [...this.handlers]) fn(); },
};

function installBrowser(): void {
  FakeEventSource.opened = [];
  fakeDocument.hidden = false;
  fakeDocument.handlers.clear();
  const g = globalThis as Record<string, unknown>;
  // Read once by getAuthToken; supplying it keeps the module off Vite's
  // import.meta.env, which does not exist under the node test runner.
  g.window = { __CLEM_BOOTSTRAP__: { token: 'test-token' } };
  g.document = fakeDocument;
  g.EventSource = FakeEventSource;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}

function uninstallBrowser(stop: () => void): void {
  stop();
  mock.timers.tick(1_000); // let the StrictMode close grace run
  mock.timers.reset();
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.EventSource;
}

test('return-to-visible always re-asks, and a socket the console cannot vouch for is replaced', () => {
  installBrowser();
  const invalidated: string[][] = [];
  const stop = subscribeActionStream({ onInvalidate: (keys) => invalidated.push([...keys]) });
  try {
    const first = FakeEventSource.opened.at(-1)!;
    first.accept();
    mock.timers.tick(1_000);
    assert.deepEqual(invalidated, [[...CONSOLE_LIVE_QUERY_KEYS]], 'connecting re-asks everything');
    assert.equal(actionStreamStatus(), 'live');
    invalidated.length = 0;

    // A short tab-away. The socket has been quiet but not for long, so it is
    // still credible — and the console re-asks anyway, because what it heard
    // before the tab hid is not evidence about now.
    fakeDocument.setHidden(true);
    mock.timers.tick(2_000);
    fakeDocument.setHidden(false);
    assert.deepEqual(invalidated, [[...CONSOLE_LIVE_QUERY_KEYS]], 'the board is re-asked on return');
    assert.equal(FakeEventSource.opened.length, 1, 'a credible socket is left alone');
    invalidated.length = 0;

    // Now the laptop sleeps. The socket goes half-open: readyState still reads
    // OPEN, onerror never fires, and nothing arrives for two minutes. This is
    // the case that used to leave a finished run rendered as running.
    fakeDocument.setHidden(true);
    mock.timers.tick(120_000);
    assert.equal(FakeEventSource.opened.length, 1, 'a hidden tab is never churned');
    assert.deepEqual(invalidated, [], 'and nothing refetches behind the user’s back');

    fakeDocument.setHidden(false);
    assert.deepEqual(invalidated, [[...CONSOLE_LIVE_QUERY_KEYS]], 'the held batch and the resync land at once');
    assert.equal(first.closed, true, 'the socket it could not vouch for is closed');
    assert.equal(FakeEventSource.opened.length, 2, 'and replaced');
    assert.equal(actionStreamStatus(), 'degraded', 'until the new one opens, the polls carry the UI');

    FakeEventSource.opened.at(-1)!.accept();
    mock.timers.tick(1_000);
    assert.equal(actionStreamStatus(), 'live');
  } finally {
    uninstallBrowser(stop);
  }
});

test('a live-but-silent channel stops calling itself live; traffic keeps it honest', () => {
  installBrowser();
  const stop = subscribeActionStream({ onInvalidate: () => {} });
  try {
    FakeEventSource.opened.at(-1)!.accept();
    mock.timers.tick(1_000);
    assert.equal(actionStreamStatus(), 'live');

    // Traffic is proof: while frames keep arriving the channel is left alone,
    // even past the silence limit in total elapsed time.
    for (let index = 0; index < 6; index += 1) {
      mock.timers.tick(STREAM_SILENCE_LIMIT_MS - 5_000);
      FakeEventSource.opened.at(-1)!.deliver('harness.event', harnessEvent(`ev-${index}`, 'heartbeat'));
    }
    assert.equal(FakeEventSource.opened.length, 1, 'a channel proving itself is never reconnected');
    assert.equal(actionStreamStatus(), 'live');

    // Then it goes quiet with the tab in front of the user. Silence is the only
    // observable there is — the route's keep-alive is a comment EventSource
    // never surfaces — so past the limit the console stops claiming live and
    // goes and finds out.
    mock.timers.tick(STREAM_SILENCE_LIMIT_MS + 5_000);
    assert.equal(FakeEventSource.opened.length, 2, 'the watchdog reopened the channel');
    assert.equal(actionStreamStatus(), 'degraded', 'and the polls are back at their real interval meanwhile');
  } finally {
    uninstallBrowser(stop);
  }
});
