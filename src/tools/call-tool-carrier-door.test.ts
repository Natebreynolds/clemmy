/** Run: node scripts/run-tests-isolated.mjs src/tools/call-tool-carrier-door.test.ts
 *
 * A carrier refusal must name a door that matches the effect being attempted.
 *
 * The text said "Invoke business/provider WRITES through work_call", which
 * reads as writes-ONLY. Live 2026-09-03: a correct reviewed-CLI SOQL READ was
 * attempted through run_shell_command, refused with this text, and the turn
 * ended asking the user how to proceed — while the exact operation tool_search
 * had disclosed was reachable through work_call the whole time, which is how
 * the identical read succeeded on an earlier run:
 *   work_call {"name":"<operation>","args_json":"{\"query\":\"SELECT ...\"}"}
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./call-tool.ts', import.meta.url), 'utf8');

test('the carrier refusal offers work_call for reads, not writes only', () => {
  const i = SRC.indexOf('is not a registry-declared control or read on this turn');
  assert.ok(i > 0, 'the refusal text must exist');
  const detail = SRC.slice(i, i + 700);
  assert.match(detail, /READS included/, 'a read must be told the carrier applies to it');
  assert.match(detail, /work_call \{"name"/, 'the exact carrier shape must be shown');
  assert.doesNotMatch(
    detail.slice(0, detail.indexOf('READS included')),
    /WRITES through work_call\.`/,
    'the writes-only framing must be gone',
  );
});

test('both initial carrier descriptions offer prepared formal approval before an execution refusal', () => {
  const guidance = SRC.match(/const FORMAL_APPROVAL_PREPARATION_GUIDANCE =\s*'([^\n]+)'/u)?.[1];
  assert.ok(guidance, 'the initial approval preparation guidance must exist');
  assert.match(guidance, /prepared action needing a formal card/);
  assert.match(guidance, /discover `pending_action_queue` if its schema is missing/);
  assert.match(guidance, /exact payload[^.]*request_now[^.]*before execution or a generic sign-off question/);
  assert.match(guidance, /Already sealed work stays on `work_call`; the target still validates consent/);
  for (const name of ['DESCRIPTION', 'CONTROL_ONLY_DESCRIPTION']) {
    const block = SRC.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join`))?.[1];
    assert.ok(block?.includes('FORMAL_APPROVAL_PREPARATION_GUIDANCE'), `${name}: the initial callable must carry the guidance`);
  }
});
