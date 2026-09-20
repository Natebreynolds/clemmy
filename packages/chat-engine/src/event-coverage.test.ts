/**
 * The chat surface must account for every event the harness actually publishes
 * to it — and must not pretend to render events it never receives.
 *
 * THE TRAP THIS CLOSES. It is natural to read `EVENT_TYPES` minus
 * `PRIVATE_EVENT_TYPES` as "what chat can see". That is wrong, and expensively
 * so: it suggests ~151 types reach the client when the true number is 47. The
 * real gate is `projectData()` in public-presentation.ts, a fail-closed
 * allowlist whose `default: return null` drops the event outright. An event not
 * cased there never leaves the daemon, so client code written to render it is
 * dead on arrival — which is exactly the mistake this test now prevents.
 *
 * So two invariants, in both directions:
 *   1. Every PROJECTED type is classified — a lifecycle row, or owned by the
 *      activity/message folds. Nothing arrives and falls on the floor.
 *   2. Every type in AWAITING_PROJECTION really is unprojected. The moment the
 *      server admits one, this fails and tells you to move it into
 *      LIFECYCLE_ROWS, so the backlog can never quietly rot into fiction.
 *
 * It reads the harness sources as text on purpose: `eventlog.ts` pulls in
 * better-sqlite3 at import time, which has no business loading inside a
 * presentation package's test. Both literals are plain switch/Set syntax, so a
 * strict parse is cheap — and it fails loudly if their shape changes rather
 * than silently asserting over an empty set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ACTIVITY_FOLD_EVENTS,
  AWAITING_PROJECTION,
  LIFECYCLE_ROWS,
} from './reduce-lifecycle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(path.join(REPO, 'src/runtime/harness/public-presentation.ts'), 'utf8');

/** The `case 'x':` labels inside projectData — the true public event set. */
function projectedTypes(): Set<string> {
  const start = source.indexOf('function projectData(event: EventRow)');
  assert.ok(start >= 0, 'projectData moved; update this test.');
  const end = source.indexOf('export function projectHarnessEventForPublic', start);
  assert.ok(end > start, 'Could not find the end of projectData.');
  const body = source.slice(start, end);
  assert.ok(/default:\s*\n?\s*(\/\/[^\n]*\n\s*)*return null;/.test(body),
    'projectData no longer fails closed — this test’s whole premise was that it does.');
  const types = new Set([...body.matchAll(/^\s*case '([a-z][a-z0-9_]*)':/gm)].map((m) => m[1]));
  assert.ok(types.size > 20, `Parsed only ${types.size} projected types.`);
  return types;
}

const PROJECTED = projectedTypes();
const PRIVATE = new Set(
  (() => {
    const start = source.indexOf('const PRIVATE_EVENT_TYPES: ReadonlySet<string> = new Set([');
    const end = source.indexOf(']);', start);
    return [...source.slice(start, end).matchAll(/^\s*'([a-z][a-z0-9_]*)',?\s*$/gm)].map((m) => m[1]);
  })(),
);
/** Private wins: an event on both lists is still dropped before projection. */
const PUBLIC = [...PROJECTED].filter((type) => !PRIVATE.has(type));

test('the projection boundary still looks like a fail-closed allowlist', () => {
  assert.ok(PUBLIC.length > 20, `Only ${PUBLIC.length} publicly projected types.`);
  assert.ok(PROJECTED.has('tool_called'), 'Sanity: tool_called should be projected.');
  assert.ok(PROJECTED.has('conversation_completed'), 'Sanity: terminals should be projected.');
  assert.ok(!PROJECTED.has('memory_correction'),
    'memory_correction is now projected — move it from AWAITING_PROJECTION into LIFECYCLE_ROWS.');
});

test('every event chat actually receives is accounted for', () => {
  const unclassified = PUBLIC.filter((type) => (
    !(type in LIFECYCLE_ROWS) && !ACTIVITY_FOLD_EVENTS.has(type)
  ));
  assert.deepEqual(unclassified, [],
    'These events reach chat and nothing renders or dismisses them:\n'
    + `  ${unclassified.join('\n  ')}\n\n`
    + 'Classify each in packages/chat-engine/src/reduce-lifecycle.ts:\n'
    + '  LIFECYCLE_ROWS       — give it a row\n'
    + '  ACTIVITY_FOLD_EVENTS — reduce-activity or a message-level presenter renders it');
});

test('no lifecycle row promises something the server never sends', () => {
  // A row for an unprojected event is dead code that reads as a feature.
  for (const type of Object.keys(LIFECYCLE_ROWS)) {
    assert.ok(PROJECTED.has(type),
      `LIFECYCLE_ROWS has '${type}', but projectData never emits it, so the row can never render. `
      + 'Move it to AWAITING_PROJECTION, or add the projection case server-side.');
    assert.ok(!PRIVATE.has(type), `LIFECYCLE_ROWS has '${type}', which PRIVATE_EVENT_TYPES drops.`);
  }
});

test('the AWAITING_PROJECTION backlog is still accurate', () => {
  const nowProjected = Object.keys(AWAITING_PROJECTION).filter((type) => PROJECTED.has(type));
  assert.deepEqual(nowProjected, [],
    'These are now published by the server, so chat can finally render them:\n'
    + `  ${nowProjected.join('\n  ')}\n\n`
    + 'Move each from AWAITING_PROJECTION into LIFECYCLE_ROWS in reduce-lifecycle.ts.');
});

test('nothing is classified twice', () => {
  const seen = new Map<string, string>();
  const buckets: [string, Iterable<string>][] = [
    ['LIFECYCLE_ROWS', Object.keys(LIFECYCLE_ROWS)],
    ['ACTIVITY_FOLD_EVENTS', ACTIVITY_FOLD_EVENTS],
    ['AWAITING_PROJECTION', Object.keys(AWAITING_PROJECTION)],
  ];
  for (const [bucket, types] of buckets) {
    for (const type of types) {
      const already = seen.get(type);
      assert.equal(already, undefined,
        `'${type}' is in both ${already} and ${bucket}; it belongs to exactly one.`);
      seen.set(type, bucket);
    }
  }
});

test('every classified type is a real harness event', () => {
  const eventlog = readFileSync(path.join(REPO, 'src/runtime/harness/eventlog.ts'), 'utf8');
  const start = eventlog.indexOf('export const EVENT_TYPES = [');
  const end = eventlog.indexOf('] as const;', start);
  const known = new Set(
    [...eventlog.slice(start, end).matchAll(/^\s*'([a-z][a-z0-9_]*)',?\s*$/gm)].map((m) => m[1]),
  );
  assert.ok(known.size > 100, `Parsed only ${known.size} event types.`);
  for (const [bucket, types] of [
    ['LIFECYCLE_ROWS', Object.keys(LIFECYCLE_ROWS)],
    ['ACTIVITY_FOLD_EVENTS', [...ACTIVITY_FOLD_EVENTS]],
    ['AWAITING_PROJECTION', Object.keys(AWAITING_PROJECTION)],
  ] as [string, string[]][]) {
    for (const type of types) {
      assert.ok(known.has(type),
        `${bucket} lists '${type}', which is not in the harness EVENT_TYPES enum — renamed or removed.`);
    }
  }
});
