/**
 * A write refused for want of a verifier must say what to go and find.
 *
 * Every external write needs a partner read that reads it back, and the partner
 * is searched only among capabilities staged for THIS turn. A model that
 * discovered the write but not the readback is therefore refused through no
 * fault of its own — nothing told it a readback was required.
 *
 * Live 2026-08-29: "find me the deals Tim still has to close and drop them in a
 * new Google sheet" was refused
 * `verification_successor_required:no_compatible_verifier:GOOGLESHEETS_CREATE_GOOGLE_SHEET`,
 * the create was withheld from the catalog, and Clem — with no vocabulary for
 * "withheld" — told the owner his Google Sheets CONNECTOR was down and needed
 * restoring. It was healthy. A refusal the model cannot repeat accurately gets
 * narrated to the user as an outage.
 *
 * The old repair text named nothing searchable, so recovery required inferring
 * the harness's proof rules. This has to work on a small model: putting rows in
 * a sheet is an ordinary request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PLAN = new URL('./plan-tools.ts', import.meta.url);
const ADMIT = new URL('../runtime/semantic-boundary/admit-and-compile-accepted-source.ts', import.meta.url);

test('the refusal carries the two facts that decide a verifier match', () => {
  const src = readFileSync(ADMIT, 'utf8');
  // resourceFamily and producedHandleKind are exactly what
  // readbackContractMatchesMutation compares. Without them the instruction
  // cannot name a search.
  assert.match(src, /family=\$\{contract\.mutation\.resourceFamily\}/);
  assert.match(src, /handle=\$\{contract\.mutation\.producedHandleKind\}/);
  assert.doesNotMatch(
    src,
    /reason: candidates\.length === 0\s*\n\s*\? `verification_successor_required:no_compatible_verifier:\$\{mutation\.identifier\}`/,
    'the bare refusal, with no searchable shape, must not come back',
  );
  assert.match(
    src,
    /verificationSuccessorDisposition/,
    'zero staged verifiers are a disposition, not an inline ternary refusal',
  );
});

test('the repair names a READ to search for, not a substitute to pick', () => {
  const src = readFileSync(PLAN, 'utf8');
  assert.match(src, /function verifierRepairInstruction/);
  const fn = src.slice(src.indexOf('function verifierRepairInstruction'), src.indexOf('async function executePlanTask'));
  assert.match(fn, /tool_search/, 'it must tell the model to search');
  assert.match(fn, /reads back a "\$\{family\}"/, 'it must name the resource family');
  assert.match(fn, /accepts a\s*\n?\s*`?\s*\+?\s*`?"\$\{handle\}" handle/, 'it must name the handle kind');
  assert.match(fn, /cite BOTH/, 'it must say the write cannot be admitted alone');
});

test('both refusal paths use it — a verifier refusal is never given the generic advice', () => {
  const src = readFileSync(PLAN, 'utf8');
  // The generic "pick from admissibleCapabilities" advice is actively wrong
  // here: the cited write is correct and no substitute exists. It sent the
  // model round the admissible list looking for something that isn't there.
  const uses = src.match(/verifierRepairInstruction\(/g) ?? [];
  assert.ok(uses.length >= 3, `expected the helper plus both call sites, saw ${uses.length}`);
  assert.doesNotMatch(
    src,
    /detail: bindingSeal\.reason,\s*\n\s*repair: 'Select an exact current capability set/,
    'the binding-seal path must not fall back to advice that names nothing',
  );
});

test('an ambiguous verifier gets different advice from a missing one', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('function verifierRepairInstruction'), src.indexOf('async function executePlanTask'));
  // Telling a model to go searching when the problem is that TOO MANY matched
  // would send it in the wrong direction entirely.
  assert.match(fn, /ambiguous/);
  assert.match(fn, /Cite exactly one of them/);
});
