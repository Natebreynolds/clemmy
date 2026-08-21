/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/single-read-act-execution.test.ts
 *
 * RETIRED SUITE — THE CLEAN LOOP (2026-08-19, Nathan): live turns never run
 * the semantic ceremony, so "single-read act executes as the admitted
 * graph" is not a reachable chat shape. Typed execution enters only via the
 * workflow-replay engine (future seam); the original pins are recoverable
 * from this file's git history when that seam lands. The replacement pin
 * below asserts the shape that DID replace it: a single-act read lands the
 * model turn with tools, zero ceremony.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-single-read-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-single-read\n', 'utf8');

const { appendEvent, createSession } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { readSemanticDisposition } = await import('./semantic-disposition.js');

test('a single-act read participates and never falls through to an untyped loop', async () => {
  const session = createSession({ id: 'single-read-clean-loop', kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'whats on my calendar for tomorrow' },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(readSemanticDisposition(session.id, source.seq)?.participation, 'participated');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.notEqual(dispatched.kind, 'conversation');
  assert.ok(dispatched.kind === 'typed' || dispatched.kind === 'blocked', dispatched.kind);
});
