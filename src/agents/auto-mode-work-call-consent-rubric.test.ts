/**
 * Auto-mode instruction pin: an accepted plan-bound call goes straight to the
 * canonical work_call consent boundary. A pending action is a user-requested
 * stage-for-later artifact, not a second approval carrier around current work.
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
      /pending_action_queue[^.]*(?:only|solely)[^.]*explicit[^.]*(?:stage|later)/i,
      `${lane}: pending actions are explicit staging only`,
    );
    assert.doesNotMatch(
      rubric,
      /(?:large, )?irreversible,? or (?:BATCH|batch) external write[^.]*pending_action_queue|At an irreversible or batch external-write boundary, `pending_action_queue`/i,
      `${lane}: current accepted work must not be wrapped in a second queue`,
    );
  }
});
