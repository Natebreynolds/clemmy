import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MeetingRecordInventory } from './meeting-record-inventory.js';

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-inventory-'));
  const inventory = new MeetingRecordInventory(directory);
  const writes = (name: string, value: unknown) => {
    const target = path.join(directory, name);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value));
    renameSync(temporary, target);
    return target;
  };
  const record = (id: string, extra = {}) => ({ id, windowId: `window-${id}`, sdkUploadId: `upload-${id}`,
    status: 'recording', startedAt: '2026-10-17T12:00:00.000Z', segments: [], ...extra });
  return { directory, inventory, writes, record, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('unchanged history is decoded once; selected records are always freshly decoded', () => {
  const f = fixture();
  try {
    const reads: Array<{ filePath: string; kind: string }> = [];
    f.inventory.observeReadsForTests((event) => reads.push(event));
    for (let i = 0; i < 25; i++) f.writes(`history-${i}.json`, f.record(`history-${i}`, { segments: [{ text: 'x'.repeat(20_000) }] }));
    f.writes('active.json', f.record('active'));
    const first = f.inventory.lookup('id', 'active');
    assert.equal(first.certain, true);
    assert.equal(reads.filter((read) => read.kind === 'inventory').length, 26);
    const value = f.inventory.readSelected(first.entries[0]) as { segments: unknown[] };
    value.segments.push('caller mutation');
    for (let i = 0; i < 5; i++) {
      const selected = f.inventory.lookup('id', 'active');
      assert.equal((f.inventory.readSelected(selected.entries[0]) as { segments: unknown[] }).segments.length, 0);
    }
    assert.equal(reads.filter((read) => read.kind === 'inventory').length, 26);
    assert.equal(reads.filter((read) => read.kind === 'selected').length, 6);
    f.writes('history-7.json', f.record('changed-history-7'));
    assert.equal(f.inventory.lookup('id', 'history-7').entries.length, 0);
    assert.equal(f.inventory.lookup('id', 'changed-history-7').entries.length, 1);
    assert.equal(reads.filter((read) => read.kind === 'inventory').length, 27, 'only the changed generation is decoded');
  } finally { f.cleanup(); }
});

test('corrupt, removed, and duplicate identities remain explicit inventory uncertainty', () => {
  const f = fixture();
  try {
    f.writes('active.json', f.record('active'));
    f.writes('duplicate.json', f.record('other', { sdkUploadId: 'upload-active' }));
    assert.equal(f.inventory.lookup('sdkUploadId', 'upload-active').entries.length, 2);
    f.writes('duplicate.json', f.record('active'));
    assert.equal(f.inventory.lookup('id', 'active').entries.length, 2);
    f.writes('duplicate.json', '{ invalid JSON');
    let reads = 0;
    f.inventory.observeReadsForTests(() => { reads++; });
    assert.equal(f.inventory.lookup('id', 'active').certain, false);
    assert.equal(f.inventory.lookup('id', 'active').certain, false);
    assert.equal(reads, 1, 'unchanged corrupt bytes are not reparsed on every request');
    rmSync(path.join(f.directory, 'duplicate.json'));
    const recovered = f.inventory.lookup('id', 'active');
    assert.equal(recovered.certain, true);
    assert.equal(recovered.entries.length, 1);
  } finally { f.cleanup(); }
});

test('a selected generation that changes after lookup is refused, then recovered from its actual bytes', () => {
  const f = fixture();
  try {
    f.writes('active.json', f.record('active'));
    const prior = f.inventory.lookup('id', 'active').entries[0];
    f.writes('active.json', f.record('replacement'));
    assert.equal(f.inventory.readSelected(prior), null);
    assert.equal(f.inventory.lookup('id', 'active').entries.length, 0);
    const replacement = f.inventory.lookup('id', 'replacement');
    assert.equal(replacement.certain, true);
    assert.equal((f.inventory.readSelected(replacement.entries[0]) as { id: string }).id, 'replacement');
  } finally { f.cleanup(); }
});

test('a new pathname during selected read prevents using a partial identity inventory', () => {
  const f = fixture();
  try {
    f.writes('active.json', f.record('active'));
    const selected = f.inventory.lookup('id', 'active').entries[0];
    f.inventory.observeReadsForTests(({ kind }) => {
      if (kind === 'selected') f.writes('new-alias.json', f.record('active'));
    });
    assert.equal(f.inventory.readSelected(selected), null);
    f.inventory.observeReadsForTests(undefined);
    assert.equal(f.inventory.lookup('id', 'active').entries.length, 2);
  } finally { f.cleanup(); }
});
