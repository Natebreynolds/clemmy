/**
 * Run: npx tsx --test src/runtime/harness/client-demo-golden-replay.test.ts
 *
 * LANE B — golden replay of the demo failure shape.
 *
 * This fixture is intended as a sanitized structural export of live local runs
 * (`client-demo-v35.sanitized.json`): event ordering, turn/role, event types,
 * and key structure are retained, while data-string leaves are opaque tokens
 * carrying a declared length plus the structural markers the projection must
 * defend against (`<br>`, envelope-shaped). Repository scans find no plaintext
 * client prose or credential-shaped values. Exact raw-log provenance and the
 * transform's completeness still require independent review by the private-log
 * owner; this test does not pretend a fixture hash can prove either one.
 *
 * Sanitized-source note (Lane B deliverable 3): 3 cases / 152 events, 292
 * distinct opaque tokens. The raw
 * sessions stay in the local event log and are never copied into tracked
 * source. Every string — replies, prompts, tool arguments, session titles, the
 * `rawOutput` of a discarded retry — is replaced by `text-t-<hash>-len<N>`,
 * which preserves presence and length class while carrying no content. Only
 * structural markers survive verbatim (`<br>`, `{envelope-shaped}`), because
 * those are precisely what the projection must defend against.
 *
 * These assert the release invariant the v3.6 boundary claims — exactly one
 * terminal public presentation per accepted source — against turns that really
 * happened, which is how the violation below was found. A synthetic fixture
 * asserts the shape its author already believed in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  projectHarnessEventsForPublic,
  publicReplyText,
} from './public-presentation.js';
import { humanHarnessText } from './transcript.js';
import type { EventRow } from './eventlog.js';

interface FixtureCase {
  label: string;
  sessionKind: string;
  events: Array<Pick<EventRow, 'seq' | 'turn' | 'role' | 'type' | 'data'>>;
}

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'client-demo-v35.sanitized.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: FixtureCase[] };

/** Control-plane shapes that must never reach a chat surface. Deliberately
 *  narrow: `"done": 1` is a batch PROGRESS count and is legitimately public,
 *  while `"done": true` is the decision envelope and is not. */
const CONTROL_PLANE_RE =
  /(?:<\/?(?:analysis|reasoning|invoke|tool_call)\b|\[tool\s*:|"tool_call"\s*:|"nextAction"\s*:|"done"\s*:\s*(?:true|false)|\[harness |\[confirm-first\]|\[fan-out|\[within-task|\[close-the-loop|\[standard\]|\[destination\])/i;

function rows(fixtureCase: FixtureCase): EventRow[] {
  return fixtureCase.events.map((event) => ({
    ...event,
    id: `fixture-${event.seq}`,
    sessionId: `fixture-${fixtureCase.label}`,
    parentEventId: null,
    createdAt: new Date(1785000000000 + event.seq).toISOString(),
  })) as EventRow[];
}

/**
 * Terminals per accepted source, for sources that OWE one.
 *
 * A source is only owed a terminal once its turn has demonstrably closed —
 * here, because a LATER source exists. The final source in a fixture window may
 * still have been in flight when the window was cut, and demanding a terminal
 * from it would assert an artifact of where the slice ends rather than a
 * property of the runtime.
 */
function presentationsPerSettledTurn(publicRows: EventRow[], all: EventRow[]): Map<number, EventRow[]> {
  const inputs = all.filter((event) => event.type === 'user_input_received');
  const byTurn = new Map<number, EventRow[]>();
  for (let i = 0; i < inputs.length; i += 1) {
    const lo = inputs[i]!.seq;
    const hi = inputs[i + 1]?.seq ?? Number.MAX_SAFE_INTEGER;
    const inWindow = publicRows.filter((event) => event.seq > lo && event.seq < hi);
    const completions = inWindow.filter((event) => event.type === 'conversation_completed');
    const awaiting = inWindow.filter((event) => event.type === 'awaiting_user_input');

    // Match the real chat/transcript state machine: a committed completion
    // supersedes a provisional awaiting edge in the same assistant slot. When
    // no completion follows, the awaiting question is itself the settled
    // presentation that the user's next input answers. A final source with no
    // presentation may simply still be active at the end of the fixture; a
    // source followed by another user input may not disappear silently.
    if (completions.length > 0) byTurn.set(lo, completions);
    else if (awaiting.length > 0) byTurn.set(lo, awaiting);
    else if (inputs[i + 1]) byTurn.set(lo, []);
  }
  return byTurn;
}

test('no control-plane payload survives the public projection', () => {
  for (const fixtureCase of fixture.cases) {
    for (const event of projectHarnessEventsForPublic(rows(fixtureCase))) {
      const blob = JSON.stringify(event.data ?? {});
      assert.doesNotMatch(
        blob,
        CONTROL_PLANE_RE,
        `${fixtureCase.label} seq=${event.seq} type=${event.type} leaked control-plane payload`,
      );
    }
  }
});

test('a settled public presentation is never empty', () => {
  // The new failure mode of a single committer is silence. Prove it cannot
  // happen: every terminal the user can see must carry text.
  for (const fixtureCase of fixture.cases) {
    const all = rows(fixtureCase);
    for (const event of projectHarnessEventsForPublic(all)) {
      if (event.type !== 'conversation_completed' && event.type !== 'awaiting_user_input') continue;
      const presentationText = event.type === 'conversation_completed'
        // This row has already crossed the public boundary. Read its projected
        // reply port instead of asking the raw-ledger compatibility parser to
        // reinterpret the added legacy presentation wrapper as a new typed
        // completion claim.
        ? publicReplyText(event.data.reply, '')
        : publicReplyText(event.data.question, '');
      assert.ok(
        presentationText.length > 0,
        `${fixtureCase.label} seq=${event.seq} is a settled presentation with no public text`,
      );
    }
  }
});

test('the observed duplicate-terminal source collapses from two raw terminals to one public presentation', () => {
  const duplicateCase = fixture.cases.find((candidate) => candidate.label === 'two_terminals_one_turn');
  assert.ok(duplicateCase, 'the observed duplicate-terminal fixture case must exist');
  const all = rows(duplicateCase);
  const raw = all.filter((event) => event.type === 'conversation_completed');
  const projected = projectHarnessEventsForPublic(all)
    .filter((event) => event.type === 'conversation_completed');
  assert.equal(raw.length, 2, 'the fixture must retain the duplicate that reproduced the reconnect defect');
  assert.equal(projected.length, 1, 'the public reader must elect one canonical terminal');
});

test('exactly one settled presentation belongs to every closed accepted source', () => {
  // RELEASE INVARIANT (Clementine 4 roadmap, Lane B). The retained observed
  // case above contains two raw completion rows for one accepted source. The
  // commit-side fix stops new doubles; this asserts the read side, which is
  // what a reconnect or transcript replay renders.
  for (const fixtureCase of fixture.cases) {
    const all = rows(fixtureCase);
    const byTurn = presentationsPerSettledTurn(projectHarnessEventsForPublic(all), all);
    for (const [sourceSeq, presentations] of byTurn) {
      // EQUALITY, not `<= 1`. The first draft asserted at-most-one, which the
      // title already contradicted: a source that produced NOTHING would have
      // passed a test named "exactly one". Silence is not success.
      assert.equal(
        presentations.length,
        1,
        `${fixtureCase.label}: accepted source seq=${sourceSeq} projected ${presentations.length} settled presentations `
        + `(${presentations.map((event) => `${event.type}@${event.seq}`).join(', ')})`,
      );
    }
  }
});

// ── Reconnect / transcript parity ───────────────────────────────────────────

test('every reader of a terminal produces the same bytes', () => {
  // Transport parity is structural, not coincidental: the live projection, the
  // transcript rebuild, the transports, and the out-of-band report-back all
  // derive terminal text from ONE function. Assert that shared derivation
  // directly — if a transport ever grows its own formatting, this fails.
  for (const fixtureCase of fixture.cases) {
    for (const event of projectHarnessEventsForPublic(rows(fixtureCase))) {
      if (event.type !== 'conversation_completed') continue;
      const viaProjection = publicReplyText(event.data.reply, '');
      // Desktop/mobile consumers historically receive the projected reply
      // string, not the private completion envelope.
      const viaTranscript = humanHarnessText(event.data.reply, '');
      const viaPresentation = typeof event.data.presentation === 'object'
        && event.data.presentation !== null
        && typeof (event.data.presentation as { text?: unknown }).text === 'string'
        ? (event.data.presentation as { text: string }).text
        : '';
      assert.ok(viaProjection.length > 0, `${fixtureCase.label} seq=${event.seq}: projected reply is empty`);
      assert.equal(
        viaTranscript,
        viaProjection,
        `${fixtureCase.label} seq=${event.seq}: transcript replay and live projection disagree byte-for-byte`,
      );
      assert.equal(
        viaPresentation,
        viaProjection,
        `${fixtureCase.label} seq=${event.seq}: typed/public presentation and reply disagree byte-for-byte`,
      );
    }
  }
});

// ── Retry / fallover ownership ──────────────────────────────────────────────

test('a retry is a physical child attempt, never a second logical user turn', () => {
  // Live shape: one accepted source, two stall retries with NO user input
  // between them, one terminal. A retry that minted a second logical turn
  // would show up here as an extra accepted source.
  const retryCase = fixture.cases.find((c) => c.label === 'retry_boundary_one_turn');
  assert.ok(retryCase, 'the retry fixture case must exist');
  const all = rows(retryCase);

  const retries = all.filter((event) => event.type === 'stall_retry_attempted');
  assert.ok(retries.length >= 2, `expected real retries in the fixture, got ${retries.length}`);

  const acceptedSources = all.filter((event) => event.type === 'user_input_received');
  const publicSources = projectHarnessEventsForPublic(all).filter((event) => event.type === 'user_input_received');
  assert.equal(
    publicSources.length,
    acceptedSources.length,
    'retries must not add accepted sources — a child attempt is not a new user turn',
  );
});

test('a retry never publishes the draft it discarded', () => {
  // CORRECTED after checking rather than reporting. `stall_retry_attempted`
  // DOES reach the public projection — but its payload is dropped, so the
  // `rawOutput` it carries (the model's abandoned partial answer) never
  // renders. That is the fail-closed contract working as documented: a new
  // event type receives no payload until it is explicitly projected.
  //
  // So the invariant is about the PAYLOAD, not the type. Whether a bare retry
  // row should appear in the activity feed at all is a product judgement for
  // the boundary's owner; a leaked draft would be a defect either way.
  const PRIVATE_PAYLOAD_KEYS = ['rawOutput', 'signal', 'maxRetries', 'model', 'provider', 'transport'];
  for (const fixtureCase of fixture.cases) {
    for (const event of projectHarnessEventsForPublic(rows(fixtureCase))) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      for (const key of PRIVATE_PAYLOAD_KEYS) {
        assert.equal(
          key in data,
          false,
          `${fixtureCase.label} seq=${event.seq} (${event.type}) published control-plane key "${key}"`,
        );
      }
    }
  }
});
