import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  exactProviderPayloadObservation,
  parseProofComposioPayloadLog,
} from './scenarios/pending-action-exact-once.js';
import { createProofComposioShim } from './provision.js';

test('proof Composio payload log preserves the exact provider argument bytes', () => {
  const payload = '{"to":"proof+approve@example.com","subject":"Exact \\"quoted\\" subject","body":"line one\\nline two"}';
  const rows = parseProofComposioPayloadLog([
    JSON.stringify({ slug: 'GMAIL_SEND_EMAIL', payload }),
    '{bad json',
    JSON.stringify({ slug: '', payload: '{}' }),
    '',
  ].join('\n'));

  assert.deepEqual(rows, [{ slug: 'GMAIL_SEND_EMAIL', payload }]);
  assert.equal(rows[0]?.payload, payload);
});

test('exact provider observation requires one byte-identical dispatch', () => {
  const expected = '{"to":"proof+approve@example.com","subject":"Proof exact once","body":"Only once."}';
  const exact = exactProviderPayloadObservation(expected, [
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
  ]);
  assert.equal(exact.pass, true);
  assert.equal(exact.exactCount, 1);

  const reordered = exactProviderPayloadObservation(expected, [
    {
      slug: 'GMAIL_SEND_EMAIL',
      payload: '{"subject":"Proof exact once","to":"proof+approve@example.com","body":"Only once."}',
    },
  ]);
  assert.equal(reordered.pass, false, 'semantic equality is not byte equality');

  const duplicate = exactProviderPayloadObservation(expected, [
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
  ]);
  assert.equal(duplicate.pass, false);
  assert.equal(duplicate.exactCount, 2);
});

test('proof-local Composio shim records the raw provider argument and keeps the legacy slug log', {
  skip: process.platform === 'win32' ? 'POSIX proof shim execution test' : false,
}, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-composio-shim-'));
  try {
    createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const payload = '{"to":"proof+shim@example.com","subject":"Exact \\"shim\\" bytes","body":"line one\\nline two"}';
    execFileSync(
      path.join(home, 'proof-bin', 'composio'),
      ['execute', 'GMAIL_SEND_EMAIL', '-d', payload],
      {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      },
    );

    assert.deepEqual(
      parseProofComposioPayloadLog(readFileSync(path.join(home, 'proof-composio-payloads.log'), 'utf8')),
      [{ slug: 'GMAIL_SEND_EMAIL', payload }],
    );
    assert.equal(
      readFileSync(path.join(home, 'proof-composio-dispatches.log'), 'utf8'),
      'GMAIL_SEND_EMAIL\n',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
