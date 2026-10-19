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
      /accepted plan-bound work[^.]*work_call[^.]*consent/i,
      `${lane}: accepted work has one direct carrier and consent owner`,
    );
    assert.match(
      rubric,
      /never requeue its sealed call/i,
      `${lane}: an existing sealed call keeps its consent owner`,
    );
    assert.match(
      rubric,
      /Prepared formal card[^.]*discover missing `pending_action_queue` schema[^.]*queue exact payload[^.]*request_now[^.]*before execution or a generic approval question/i,
      `${lane}: a prepared formal approval does not require a refused execution or generic ask first`,
    );
    assert.match(
      rubric,
      /`approvalIntent:"queue_only"` only stages/,
      `${lane}: staging without a card retains its separate intent`,
    );
    assert.match(
      rubric,
      /Approval executes stored authority only\./,
      `${lane}: prose grants no execution authority`,
    );
    assert.match(
      rubric,
      /Reads\/exact reversible creates\/updates need no card/,
      `${lane}: ordinary work acquires no extra approval requirement`,
    );
    assert.doesNotMatch(
      rubric,
      /(?:large, )?irreversible,? or (?:BATCH|batch) external write[^.]*pending_action_queue|At an irreversible or batch external-write boundary, `pending_action_queue`/i,
      `${lane}: current accepted work must not be wrapped in a second queue`,
    );
  }
});
