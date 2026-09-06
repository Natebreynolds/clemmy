import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldWriteLedger,
  sealOpenWrites,
  writeRowLabel,
  writeRowStatus,
  writeRowTone,
  writeReversibilityLabel,
  writeCallId,
} from './write-ledger.js';
import type { WriteEventInput } from './write-ledger.js';

let seq = 0;
function ev(type: string, data: Record<string, unknown>): WriteEventInput {
  seq += 1;
  return { seq, type, data };
}

/** The exact public payload the projection ships for a write. */
function write(callId: string, extra: Record<string, unknown> = {}) {
  return {
    shapeKey: 'OUTLOOK_CREATE_DRAFT',
    toolName: 'outlook_create_draft',
    callId,
    targets: ['paul@example.com'],
    ...extra,
  };
}

const only = (m: Map<string, ReturnType<typeof foldWriteLedger> extends Map<string, infer R> ? R : never>) => {
  assert.equal(m.size, 1, `expected exactly one row, got ${m.size}`);
  return [...m.values()][0]!;
};

test('THE defect: a reservation is never a receipt', () => {
  const row = only(foldWriteLedger([ev('external_write', write('c1', { preDispatch: true }))]));
  assert.equal(row.disposition, 'reserved');
  assert.equal(writeRowStatus(row), 'running');
  assert.notEqual(writeRowTone(row), 'success');
  // Present tense: it has not happened yet, so it must not be claimed.
  assert.match(writeRowLabel(row), /^Creating a draft/);
});

test('a settled write says so in the past tense, once', () => {
  const rows = foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write_succeeded', write('c1')),
  ]);
  const row = only(rows); // one call, one row -- not two
  assert.equal(row.disposition, 'confirmed');
  assert.equal(writeRowStatus(row), 'done');
  assert.match(writeRowLabel(row), /^Created a draft to paul@example\.com$/);
});

test('the reservation and its terminal collapse to ONE row', () => {
  // The old reducer keyed on `x-${ev.type}-${callId}`, so the same draft was
  // listed twice -- once as an intention, once as an outcome.
  for (const terminal of ['external_write_succeeded', 'external_write_failed', 'external_write_orphaned']) {
    const rows = foldWriteLedger([
      ev('external_write', write('c1', { preDispatch: true })),
      ev(terminal, write('c1')),
    ]);
    assert.equal(rows.size, 1, `${terminal} produced ${rows.size} rows`);
  }
});

test('a failure reads as a failure, not a success', () => {
  const row = only(foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write_failed', write('c1')),
  ]));
  assert.equal(row.disposition, 'failed');
  assert.equal(writeRowTone(row), 'danger');
  assert.match(writeRowLabel(row), /failed$/);
});

test('an orphan says it may have landed -- never "failed", never "done"', () => {
  const row = only(foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write_orphaned', write('c1')),
  ]));
  assert.equal(row.disposition, 'orphaned');
  assert.equal(writeRowStatus(row), 'interrupted');
  assert.match(writeRowLabel(row), /may have landed$/);
});

test('a decisive terminal outranks an orphan, in either arrival order', () => {
  const forward = only(foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write_orphaned', write('c1')),
    ev('external_write_succeeded', write('c1')),
  ]));
  assert.equal(forward.disposition, 'confirmed');

  // A read-back can settle an orphan later; the reverse must not un-settle it.
  const backward = only(foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write_succeeded', write('c1')),
    ev('external_write_orphaned', write('c1')),
  ]));
  assert.equal(backward.disposition, 'confirmed');
});

test('a terminal that arrives without its reservation still settles', () => {
  // Replay is capped, so the reservation can fall off the front of the window.
  const row = only(foldWriteLedger([ev('external_write_succeeded', write('c1'))]));
  assert.equal(row.disposition, 'confirmed');
});

test('two open reservations sharing one callId both go unknown, never "never dispatched"', () => {
  const rows = foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true })),
    ev('external_write', write('c1', { preDispatch: true })),
  ]);
  const row = only(rows);
  assert.equal(row.disposition, 'unknown');
  assert.match(writeRowLabel(row), /couldn't confirm this one$/);
});

test('a write with no callId is kept, and cannot claim a settlement', () => {
  const rows = foldWriteLedger([
    ev('external_write', { shapeKey: 'X_CREATE', toolName: 'x_create', targets: [] }),
    ev('external_write', { shapeKey: 'X_CREATE', toolName: 'x_create', targets: [] }),
  ]);
  // Two unpairable observations stay two rows -- collapsing them would invent
  // an identity the wire never gave.
  assert.equal(rows.size, 2);
  for (const row of rows.values()) assert.equal(row.disposition, 'reserved');
});

test('an unsettled reservation at turn end is unknown, not success', () => {
  const open = foldWriteLedger([ev('external_write', write('c1', { preDispatch: true }))]);
  const sealed = sealOpenWrites(open);
  assert.equal(only(sealed).disposition, 'unknown');
  // Sealing a settled ledger changes nothing.
  const settled = foldWriteLedger([
    ev('external_write', write('c2', { preDispatch: true })),
    ev('external_write_succeeded', write('c2')),
  ]);
  assert.equal(only(sealOpenWrites(settled)).disposition, 'confirmed');
});

test('irreversible is null on the public bus, and null never reads as irreversible', () => {
  // The allowlist is shapeKey/toolName/tool/callId/call_id/preDispatch + targets.
  // `irreversible` is written durably and stripped here, so it is always absent.
  const row = only(foldWriteLedger([ev('external_write_succeeded', write('c1'))]));
  assert.equal(row.irreversible, null);
  assert.equal(writeReversibilityLabel(row), null, 'a null must render as silence, not "can\'t be undone"');
});

test('reversibility renders three ways once the field is allowlisted', () => {
  const rev = only(foldWriteLedger([ev('external_write_succeeded', write('c1', { irreversible: false }))]));
  assert.equal(writeReversibilityLabel(rev), 'reversible');
  const irr = only(foldWriteLedger([ev('external_write_succeeded', write('c2', { irreversible: true }))]));
  assert.equal(writeReversibilityLabel(irr), "can't be undone");
});

test('both public spellings of the call id pair to the same row', () => {
  assert.equal(writeCallId({ callId: 'a' }), 'a');
  assert.equal(writeCallId({ call_id: 'b' }), 'b');
  assert.equal(writeCallId({ callId: '', call_id: 'b' }), 'b');
  assert.equal(writeCallId({}), '');
  const rows = foldWriteLedger([
    ev('external_write', { ...write('c1', { preDispatch: true }), callId: undefined, call_id: 'c1' }),
    ev('external_write_succeeded', write('c1')),
  ]);
  assert.equal(rows.size, 1);
});

test('non-write events are ignored entirely', () => {
  assert.equal(foldWriteLedger([
    ev('tool_called', { tool: 'x' }),
    ev('turn_started', {}),
  ]).size, 0);
});

test('the terminal descriptor wins over the reservation for targets', () => {
  const row = only(foldWriteLedger([
    ev('external_write', write('c1', { preDispatch: true, targets: ['a@x.com', 'b@x.com'] })),
    ev('external_write_succeeded', write('c1', { targets: ['a@x.com'] })),
  ]));
  assert.deepEqual(row.targets, ['a@x.com'], 'a reservation can over-state what actually went out');
});
