/**
 * Run: npx tsx --test src/runtime/harness/destination-candidate-ladder.test.ts
 *
 * A write destination is chosen by capability IDENTITY, never by the word the
 * model picked for the step.
 *
 * Measured live 2026-08-26 on "create a google sheet named ... and put a header
 * row in it": the accepted operation carried the exact capability ref
 * (cap:resolved:googlesheets_create_google_sheet1) and the frozen catalog held
 * exactly one matching create_new external writer — but candidate selection
 * compared the model's free-text `role` ("create_google_spreadsheet") against
 * the literals 'destination' and 'create', so the binder was handed an EMPTY
 * list. The bind failed, the accepted graph froze an UNBOUND destination, and
 * consent later refused the write as "prepared capability has no exact current
 * semantic basis" — a reason that names none of the above. The user saw only
 * "that exact capability is unavailable."
 *
 * With identity leading the ladder the same request created a real spreadsheet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { destinationCandidateLadder } from './destination-binding.js';

const CREATE_REF = 'cap:resolved:some_carrier_create_thing';
const UPDATE_REF = 'cap:resolved:some_carrier_update_thing';

test('a model-authored role name still offers its capability to the binder', () => {
  const ladder = destinationCandidateLadder([
    { role: 'create_google_spreadsheet', capabilityRef: CREATE_REF },
    { role: 'write_headers', capabilityRef: UPDATE_REF },
  ]);
  assert.ok(ladder.length > 0, 'the binder must never be handed an empty candidate list');
  assert.ok(ladder[0]!.includes(CREATE_REF),
    'the operation that names the destination capability must be a candidate whatever it called itself');
});

test('the catalog, not the role text, is left to disambiguate', () => {
  const ladder = destinationCandidateLadder([
    { role: 'whatever_the_model_wrote', capabilityRef: CREATE_REF },
    { role: 'also_arbitrary', capabilityRef: UPDATE_REF },
  ]);
  assert.deepEqual([...ladder[0]!], [CREATE_REF, UPDATE_REF],
    'every referenced capability is offered; bindExecutableDestination filters by effect and posture and demands a unique survivor');
});

test('self-declared destination roles remain a narrowing rung, not the gate', () => {
  const ladder = destinationCandidateLadder([
    { role: 'destination', capabilityRef: CREATE_REF },
    { role: 'something_else', capabilityRef: UPDATE_REF },
  ]);
  assert.equal(ladder.length, 2, 'a plan referencing several writers keeps the narrower question available');
  assert.deepEqual([...ladder[1]!], [CREATE_REF],
    'the declared-destination rung narrows to what declared itself');
});

test('no rung is offered when nothing carries a capability reference', () => {
  assert.deepEqual(destinationCandidateLadder([{ role: 'create', capabilityRef: null }]), [],
    'a role word alone never stands in for an exact capability identity');
  assert.deepEqual(destinationCandidateLadder([]), []);
  assert.deepEqual(destinationCandidateLadder(undefined), []);
});

test('a single self-declared destination is not offered twice', () => {
  const ladder = destinationCandidateLadder([{ role: 'create', capabilityRef: CREATE_REF }]);
  assert.equal(ladder.length, 1, 'an identical narrowing rung is redundant work, not a second chance');
});
