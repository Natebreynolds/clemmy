/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/sliced-pass.test.ts
 *
 * The sliced-pass primitive: a slice ends on its unit, write or time budget,
 * commits, and only then hands the loop a turn. Every pin counts units,
 * writes and turns; none measures wall time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const {
  NIGHTLY_SLICE,
  SliceClock,
  runSliced,
  runUnsliced,
  setSliceResumeHook,
  stepsOf,
} = await import('./sliced-pass.js');

function scratchDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  return db;
}

/** Counts macrotask turns that ran while the code under test was awaited. */
function turnCounter(): { stop: () => number } {
  let turns = 0;
  let on = true;
  (function tick() {
    turns += 1;
    if (on) setImmediate(tick);
  })();
  return { stop: () => { on = false; return turns; } };
}

test('the nightly budget is 25 ms, 50 units or 100 writes per slice', () => {
  assert.deepEqual({ ...NIGHTLY_SLICE }, { maxMs: 25, maxUnits: 50, maxWrites: 100 });
  assert.throws(() => { (NIGHTLY_SLICE as { maxMs: number }).maxMs = 1; });
  assert.throws(() => new SliceClock({ maxUnits: 0 }), RangeError);
});

test('a slice ends at maxUnits', async () => {
  const slices: Array<{ units: number; writes: number }> = [];
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 3, maxWrites: 1_000 }, {
    onSlice: (s) => slices.push({ units: s.units, writes: s.writes }),
  });
  for (let i = 0; i < 7; i += 1) {
    clock.unit();
    await clock.next();
  }
  clock.finish();
  assert.deepEqual(slices, [{ units: 3, writes: 0 }, { units: 3, writes: 0 }, { units: 1, writes: 0 }]);
  assert.equal(clock.turns, 2);
});

test('a slice ends at maxWrites', async () => {
  const slices: number[] = [];
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 1_000, maxWrites: 4 }, {
    onSlice: (s) => slices.push(s.writes),
  });
  for (let i = 0; i < 10; i += 1) {
    clock.wrote(1);
    await clock.next();
  }
  clock.finish();
  assert.deepEqual(slices, [4, 4, 2]);
  assert.equal(clock.turns, 2);
});

test('a slice ends at maxMs by the injected clock, and waiting for a turn is not work time', async () => {
  let now = 0;
  const clock = new SliceClock({ maxMs: 10, maxUnits: 1_000, maxWrites: 1_000 }, {
    now: () => now,
    yieldTurn: async () => { now += 1_000; },
  });
  now = 9;
  assert.equal(clock.due, false);
  now = 10;
  assert.equal(clock.due, true);
  await clock.next();
  assert.equal(clock.turns, 1);
  assert.equal(clock.due, false, 'the 1 s spent waiting for the turn does not count against the next slice');
});

test('a boundary ends the slice whatever the counts say', async () => {
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 1_000, maxWrites: 1_000 });
  assert.equal(clock.due, false);
  clock.boundary();
  assert.equal(clock.due, true);
  await clock.next();
  assert.equal(clock.due, false);
});

test('runSliced commits before every turn: the connection is never in a transaction while the loop runs', async () => {
  const db = scratchDb();
  let seenInTransactionAtTurn = 0;
  let turnsTaken = 0;
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 5, maxWrites: 1_000 }, {
    yieldTurn: async () => {
      turnsTaken += 1;
      if (db.inTransaction) seenInTransactionAtTurn += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });
  const insert = db.prepare('INSERT INTO rows (v) VALUES (?)');
  let i = 0;
  const counter = turnCounter();
  await runSliced(db, clock, () => {
    if (i >= 23) return 'done';
    insert.run(i);
    i += 1;
    clock.unit();
    clock.wrote(1);
    return 'more';
  });
  const loopTurns = counter.stop();
  assert.equal(seenInTransactionAtTurn, 0);
  assert.equal(turnsTaken, 4, '23 units at 5 per slice: 4 turns between 5 slices');
  assert.ok(loopTurns >= 4, `the loop ran ${loopTurns} turns while the pass was awaited`);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM rows').get() as { c: number }).c, 23);
  assert.equal(db.inTransaction, false);
});

test('a step that throws rolls back only its own slice', async () => {
  const db = scratchDb();
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 4, maxWrites: 1_000 });
  const insert = db.prepare('INSERT INTO rows (v) VALUES (?)');
  let i = 0;
  await assert.rejects(runSliced(db, clock, () => {
    if (i === 10) throw new Error('unit failed');
    insert.run(i);
    i += 1;
    clock.unit();
    return 'more';
  }), /unit failed/);
  // Slices [0..3] and [4..7] committed; the slice holding 8 and 9 rolled back.
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM rows').get() as { c: number }).c, 8);
  assert.equal(db.inTransaction, false);
});

test('a sliced pass refuses to start inside an open transaction', async () => {
  const db = scratchDb();
  db.exec('BEGIN');
  await assert.rejects(runSliced(db, new SliceClock(), () => 'done'), /inside an open transaction/);
  db.exec('ROLLBACK');
});

test('afterSlice runs after every commit, including the final slice', async () => {
  const db = scratchDb();
  const committedAtAfterSlice: number[] = [];
  const clock = new SliceClock({ maxMs: Infinity, maxUnits: 3, maxWrites: 1_000 });
  const insert = db.prepare('INSERT INTO rows (v) VALUES (?)');
  let i = 0;
  await runSliced(db, clock, () => {
    if (i >= 7) return 'done';
    insert.run(i);
    i += 1;
    clock.unit();
    return 'more';
  }, {
    afterSlice: () => {
      assert.equal(db.inTransaction, false);
      committedAtAfterSlice.push((db.prepare('SELECT COUNT(*) AS c FROM rows').get() as { c: number }).c);
    },
  });
  assert.deepEqual(committedAtAfterSlice, [3, 6, 7]);
});

test('the process-wide resume hook runs once after every turn; a clock hook overrides it', async () => {
  let resumed = 0;
  setSliceResumeHook(() => { resumed += 1; });
  try {
    const clock = new SliceClock({ maxMs: Infinity, maxUnits: 1, maxWrites: 1_000 });
    for (let i = 0; i < 3; i += 1) { clock.unit(); await clock.next(); }
    assert.equal(resumed, 3);

    let own = 0;
    const withOwn = new SliceClock({ maxMs: Infinity, maxUnits: 1, maxWrites: 1_000 }, { resume: () => { own += 1; } });
    withOwn.unit();
    await withOwn.next();
    assert.equal(own, 1);
    assert.equal(resumed, 3, 'the process hook is not called when the clock has its own');

    setSliceResumeHook(() => { throw new Error('hook failure'); });
    const survives = new SliceClock({ maxMs: Infinity, maxUnits: 1, maxWrites: 1_000 });
    survives.unit();
    await survives.next();
    assert.equal(survives.turns, 1, 'a throwing resume hook never stops the pass');
  } finally {
    setSliceResumeHook(null);
  }
});

test('a generator pass yields at every unit and write; the unsliced driver runs the same steps in one transaction', async () => {
  const run = async (sliced: boolean) => {
    const db = scratchDb();
    const reports: Array<{ units: number; writes: number }> = [];
    const clock = new SliceClock({ maxMs: Infinity, maxUnits: 4, maxWrites: 6 }, {
      onSlice: (s) => reports.push({ units: s.units, writes: s.writes }),
    });
    const insert = db.prepare('INSERT INTO rows (v) VALUES (?)');
    function* pass(): Generator<void, void, undefined> {
      clock.boundary(); // a setup step of its own
      yield;
      for (let unit = 0; unit < 9; unit += 1) {
        clock.unit();
        yield;
        for (let w = 0; w < 3; w += 1) {
          insert.run(unit * 10 + w);
          clock.wrote(1);
          yield;
        }
      }
    }
    if (sliced) await runSliced(db, clock, stepsOf(pass()));
    else runUnsliced(db, stepsOf(pass()));
    const rows = (db.prepare('SELECT v FROM rows ORDER BY v').all() as Array<{ v: number }>).map((r) => r.v);
    return { rows, reports, turns: clock.turns };
  };
  const sliced = await run(true);
  const unsliced = await run(false);
  assert.deepEqual(sliced.rows, unsliced.rows);
  assert.equal(unsliced.turns, 0);
  assert.ok(sliced.turns >= Math.ceil(27 / 6) - 1);
  for (const report of sliced.reports) {
    assert.ok(report.units <= 4, `units per slice ${report.units}`);
    assert.ok(report.writes <= 6, `writes per slice ${report.writes}`);
  }
  assert.deepEqual(sliced.reports[0], { units: 0, writes: 0 }, 'the setup step had a slice of its own');
});
