/**
 * W1b — a direct call of a name that is not on this step's advertised surface
 * is carried through the acquisition carrier. The authored name stays sealed.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/off-surface-direct-carry.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveOffSurfaceDirectCarry } from './tool-effect.js';

const RUNNER = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');

const surface = (...names: string[]) => {
  const set = new Set(names);
  return (name: string) => set.has(name);
};

test('a local read off the surface carries through call_tool and keeps the authored name', () => {
  const carry = resolveOffSurfaceDirectCarry({
    authoredName: 'read_file',
    authoredArgs: { path: 'notes.md' },
    authoredArgumentsJson: '{"path":"notes.md"}',
    surfaceHas: surface('call_tool', 'work_call', 'tool_search'),
  });
  assert.ok(carry, 'a reachable local read must be carried, not "tool not found"');
  assert.equal(carry!.carrierName, 'call_tool');
  assert.equal(carry!.carrierArgs.name, 'read_file');
  assert.equal(JSON.parse(carry!.carrierArgs.args_json).path, 'notes.md');
});

test('a business write off the surface prefers work_call', () => {
  const carry = resolveOffSurfaceDirectCarry({
    authoredName: 'GMAIL_SEND_EMAIL',
    authoredArgs: { to: 'a@b.c', subject: 'hi', body: 'x' },
    authoredArgumentsJson: '{"to":"a@b.c","subject":"hi","body":"x"}',
    surfaceHas: surface('call_tool', 'work_call'),
  });
  assert.ok(carry);
  assert.equal(carry!.carrierName, 'work_call');
  assert.equal(carry!.carrierArgs.name, 'GMAIL_SEND_EMAIL');
});

test('a name already on the surface is not rewritten', () => {
  assert.equal(resolveOffSurfaceDirectCarry({
    authoredName: 'read_file',
    authoredArgs: { path: 'a' },
    authoredArgumentsJson: '{"path":"a"}',
    surfaceHas: surface('read_file', 'call_tool'),
  }), null);
});

test('a carrier named directly is not wrapped in itself', () => {
  assert.equal(resolveOffSurfaceDirectCarry({
    authoredName: 'call_tool',
    authoredArgs: { name: 'read_file', args_json: '{}' },
    authoredArgumentsJson: '{"name":"read_file","args_json":"{}"}',
    surfaceHas: surface('work_call'),
  }), null);
});

test('no advertised carrier stays an ordinary miss', () => {
  assert.equal(resolveOffSurfaceDirectCarry({
    authoredName: 'read_file',
    authoredArgs: { path: 'a' },
    authoredArgumentsJson: '{"path":"a"}',
    surfaceHas: surface('tool_search'),
  }), null);
});

test('admission keeps the authored sealed name when carrying (W1b)', () => {
  assert.match(RUNNER, /resolveOffSurfaceDirectCarry/,
    'executeCall must carry off-surface directs at admission');
  assert.match(RUNNER, /toolName: offSurfaceCarry/,
    'the host settlement identity branches on the carry');
  assert.match(RUNNER, /offSurfaceCarry\s*\n\s*\? call\.name/,
    'the host settlement identity stays the model\'s authored name');
  assert.doesNotMatch(
    RUNNER.slice(RUNNER.indexOf('const authoredName = call.name'), RUNNER.indexOf('type CanonicalHostCall')),
    /call\.name\s*=\s*offSurfaceCarry/,
    'the sealed call record must not be rewritten to the carrier',
  );
});
