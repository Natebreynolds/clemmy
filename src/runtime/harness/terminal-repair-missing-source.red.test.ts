/**
 * RED: partial unavailability names the exact missing source.
 *
 * When a turn grounded most of its answer but one source was unavailable, the
 * user gets the grounded subset plus the NAME of the exact source that is
 * missing — not a generic "I haven't been able to verify the result yet."
 * Today the repair boundary flattens every preparation gap into ten fixed
 * generic facts and its fallback is one canned sentence, so the one thing the
 * user could act on (which source failed) is discarded (live 2026-08-11).
 *
 * These pins target the typed carrier the repair packet must gain: the exact
 * unavailable source identity, preserved through to the sealed render.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-repair-missing-source-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-repair-missing-source\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const repair = await import('./terminal-presentation-repair.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;
function acceptedAction(displayText: string) {
  const session = eventlog.createSession({ id: `repair-missing-source-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: displayText },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed');
  const frozen = contracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [{
        id: 'commit',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

/** The typed carrier the fix introduces: the caller knows exactly which source
 * failed and hands that identity to the repair boundary. */
const KNOWN_MISSING_SOURCE = {
  source: 'google_calendar',
  reason: 'the calendar connection is expired',
};

test('the sealed repair packet carries the exact unavailable source, not only generic gap facts', async () => {
  const task = acceptedAction('Send my day summary from calendar and tasks to alex@example.com.');
  let captured: repair.TerminalPresentationRepairPacketV1 | undefined;
  const result = await repair.repairTerminalPresentation({
    ...task,
    proposedReply: 'Here is your day: 3 meetings and 2 open tasks.',
    missing: ['cardinality_item_missing'],
    unavailableSources: [KNOWN_MISSING_SOURCE],
    port: {
      async render(packet) {
        captured = packet;
        return 'I could reach your tasks, but the calendar connection is expired, so the meeting list is missing.';
      },
    },
  } as never);
  assert.ok(result.status === 'blocked_repaired' || result.status === 'blocked_fallback');
  const packet = captured as (repair.TerminalPresentationRepairPacketV1 & {
    unavailableSources?: Array<{ source?: string }>;
  }) | undefined;
  assert.ok(packet, 'the sealed render ran once');
  assert.ok(
    packet.unavailableSources?.some((entry) => entry.source === KNOWN_MISSING_SOURCE.source),
    'the repair packet must carry the exact missing source identity as a typed '
    + 'field so the render can name it — got only generic gaps: '
    + JSON.stringify(packet),
  );
});

test('a failed repair model call is the only path allowed to use the constant fallback', async () => {
  const task = acceptedAction('Send my day summary from calendar and tasks to alex@example.com.');
  const result = await repair.repairTerminalPresentation({
    ...task,
    proposedReply: 'Here is your day: 3 meetings and 2 open tasks.',
    missing: ['cardinality_item_missing'],
    unavailableSources: [KNOWN_MISSING_SOURCE],
    port: {
      async render() {
        throw new Error('render offline');
      },
    },
  } as never);
  assert.equal(result.status, 'blocked_fallback');
  assert.equal(
    result.text,
    'I haven\'t been able to verify the result yet. I can keep working from here once we resume.',
    'the renderer was actually attempted and failed, so the one constant fallback is permitted',
  );
});
