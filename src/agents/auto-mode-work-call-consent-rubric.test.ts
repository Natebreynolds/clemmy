/**
 * Auto-mode instruction pin: an accepted plan-bound call goes straight to the
 * canonical work_call consent boundary. Prepared formal-card requests use the
 * queue upfront, while a sealed call must not acquire a second approval owner.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/agents/auto-mode-work-call-consent-rubric.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAUDE_BRAIN_RUBRIC,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
} from './clem-rubric.js';

test('every flagship brain routes plan-bound work directly through one canonical consent boundary', () => {
  for (const [lane, rubric] of [
    ['codex-legacy', ORCHESTRATOR_INSTRUCTIONS],
    ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
    ['codex-auto', ORCHESTRATOR_INSTRUCTIONS_LEAN],
    ['claude-auto', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(
      rubric,
      /accepted(?: plan-bound)? (?:action|work)[^.]*work_call[^.]*(?:directly|canonical consent|formal card)/i,
      `${lane}: accepted work has one direct carrier and consent owner`,
    );
    assert.match(
      rubric,
      /Never wrap that sealed call in `pending_action_queue`/,
      `${lane}: an existing sealed call keeps its consent owner`,
    );
    assert.match(
      rubric,
      /prepared action needing a formal card[^.]*discover `pending_action_queue` if its schema is missing[^.]*exact payload[^.]*request_now[^.]*do not attempt execution or ask a generic approval question first/i,
      `${lane}: a prepared formal approval does not require a refused execution or generic ask first`,
    );
    assert.match(
      rubric,
      /`queue_only` solely for explicit stage-for-later requests/,
      `${lane}: staging without a card retains its separate intent`,
    );
    assert.match(
      rubric,
      /The host validates consent; approval executes stored authority only\./,
      `${lane}: prose grants no execution authority`,
    );
    assert.match(
      rubric,
      /Reads and exact reversible creates\/updates need no card/,
      `${lane}: ordinary work acquires no extra approval requirement`,
    );
    assert.doesNotMatch(
      rubric,
      /(?:large, )?irreversible,? or (?:BATCH|batch) external write[^.]*pending_action_queue|At an irreversible or batch external-write boundary, `pending_action_queue`/i,
      `${lane}: current accepted work must not be wrapped in a second queue`,
    );
  }
});
