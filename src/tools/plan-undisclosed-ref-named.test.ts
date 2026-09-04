import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExactPlanTaskRefusal } from '../runtime/harness/plan-task-result-contract.ts';

const PLAN_TOOLS = readFileSync(new URL('./plan-tools.ts', import.meta.url), 'utf8');
const ADMISSION = readFileSync(
  new URL('../runtime/semantic-boundary/admit-and-compile-accepted-source.ts', import.meta.url),
  'utf8',
);

// The host computes exactly which cited refs fell outside the bounded set. It
// must not throw that away: a four-leg plan refused with an unnamed ref gives
// the model no way to tell WHICH leg to fix.
test('admission names the undisclosed refs in the refusal reason', () => {
  const site = ADMISSION.split('cites a capability that was not disclosed to this source')[1] ?? '';
  assert.match(ADMISSION, /const undisclosed = \[\.\.\.selectedPrimaryCapabilityRefs\]/);
  assert.match(ADMISSION, /\.filter\(\(ref\) => !boundedIds\.has\(ref\)\)/);
  assert.ok(
    site.includes('undisclosed.join') || ADMISSION.includes('undisclosed.join'),
    'the named refs must reach the reason string',
  );
});

test('the refusal reason stays substring-matchable by the reason-code and routing helpers', () => {
  // Both helpers key off `.includes('capability that was not disclosed')`.
  // Appending the refs after a colon must not break either.
  const withRefs = 'primary model proposal cites a capability that was not disclosed to this source: cap:x, cap:y';
  assert.ok(withRefs.includes('capability that was not disclosed'));
  assert.match(PLAN_TOOLS, /reason\.includes\('capability that was not disclosed'\)/);
});

test('the repair instruction agrees with recoveryTool instead of contradicting it', () => {
  assert.match(PLAN_TOOLS, /function undisclosedRefRepairInstruction\(/);
  const fn = PLAN_TOOLS.split('function undisclosedRefRepairInstruction(')[1]!.split('\nfunction ')[0]!;
  // recoveryTool is 'tool_search' for this reason, so the instruction must
  // offer tool_search — not only "correct the proposal".
  assert.match(fn, /tool_search/);
  assert.match(fn, /to this source:/, 'must parse the named refs back out');
  assert.ok(
    PLAN_TOOLS.includes('?? undisclosedRefRepairInstruction(planned.reason, admissibleCapabilities.length)'),
    'the instruction must be wired into the repair chain before the generic fallback',
  );
});

// THE BREAK CLASS: `exactPlanTaskResultKeys` demands an exact key set, so a new
// payload field parses to null, the projection bails, and the turn dies with
// stop_factual. This change deliberately routes through `detail`/`repair`
// rather than adding a key — pin that the payload still parses.
test('the plan_not_admitted payload still parses through the exact contract', () => {
  const payload = {
    ok: false,
    code: 'plan_not_admitted',
    detail: 'primary model proposal cites a capability that was not disclosed to this source: cap:composio:OUTLOOK_CREATE_DRAFT',
    reasonCode: 'capability_not_disclosed',
    admissibleCapabilities: [
      { capabilityRef: 'cap:composio:OUTLOOK_SEND_MAIL', effect: 'external_write', purpose: 'send mail' },
    ],
    ceiling: 'external_write',
    withheld: [],
    repair: 'The cited capabilityRef(s) cap:composio:OUTLOOK_CREATE_DRAFT were not disclosed to this source, '
      + 'so the plan cannot cite them. Either cite a capabilityRef from admissibleCapabilities that fills the '
      + 'same role, or run tool_search once for that role and call plan_task with only the exact id it returns. '
      + 'Every other binding in this plan was fine — keep them.',
    recoveryTool: 'tool_search',
  };
  const parsed = parseExactPlanTaskRefusal(JSON.stringify(payload));
  assert.ok(parsed, 'the refusal must still parse — an unparsed refusal kills the turn');
  assert.equal(parsed.recoveryTool, 'tool_search');
});
