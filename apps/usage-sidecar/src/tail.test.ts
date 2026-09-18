import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emptyTail, primeToEnd, readNewLines } from './tail.js';

test('tail reads only new complete lines and survives appends', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meter-tail-'));
  const file = path.join(dir, 'a.ndjson');
  writeFileSync(file, '{"a":1}\n{"a":2}\n');
  let state = emptyTail();
  let out = readNewLines(file, state);
  assert.equal(out.lines.length, 2);
  state = out.state;
  out = readNewLines(file, state);
  assert.equal(out.lines.length, 0);
  appendFileSync(file, '{"a":3}\n');
  out = readNewLines(file, out.state);
  assert.deepEqual(out.lines, ['{"a":3}']);
});

test('primeToEnd skips existing bytes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'meter-tail-'));
  const file = path.join(dir, 'b.ndjson');
  writeFileSync(file, '{"old":true}\n');
  const primed = primeToEnd(file);
  appendFileSync(file, '{"new":true}\n');
  const out = readNewLines(file, primed);
  assert.deepEqual(out.lines, ['{"new":true}']);
});
