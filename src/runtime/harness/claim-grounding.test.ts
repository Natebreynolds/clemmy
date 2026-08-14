/**
 * Run: npx tsx --test src/runtime/harness/claim-grounding.test.ts
 *
 * Pins claim grounding — the pointer-shaped sibling of the figures judge
 * (live 2026-07-30: a reply handed over a production URL nothing in the run
 * had ever fetched; the general class covers file paths and any deliverable
 * pointer). Structural only: no provider rules, no verification recipes —
 * the nudge asks the model to check in whatever way fits, or speak honestly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimGroundingNudge,
  extractDeliverablePointers,
  normalizeUrl,
  pointerEvidenceForms,
  recallReadCallIdsForSource,
  ungroundedPointers,
} from './claim-grounding.js';

test('extraction: URLs and paths come out of prose; trivia and bare prose words stay out', () => {
  const pointers = extractDeliverablePointers(
    'Yes—the brief finished. It lives at https://myatt-bell-brief.netlify.app and the QA shots are in '
    + '`myatt-bell-brief/screenshots/` plus the deck at /opt/workspace/client/deck.pptx. '
    + 'I also updated the README.md wording and we should talk pricing.',
  );
  const kinds = new Map(pointers.map((p) => [p.raw, p.kind]));
  assert.equal(kinds.get('https://myatt-bell-brief.netlify.app'), 'url');
  assert.equal(kinds.get('myatt-bell-brief/screenshots'), 'path');
  assert.equal(kinds.get('/opt/workspace/client/deck.pptx'), 'path');
  // "README.md" with no directory context is prose about a file, not a handoff.
  assert.ok(![...kinds.keys()].some((raw) => raw.toLowerCase() === 'readme.md'));
});

test('grounding: evidence anywhere in the run covers a pointer — scheme-insensitive URLs, tail-segment paths', () => {
  const pointers = extractDeliverablePointers(
    'Deployed to https://myatt-bell-brief.netlify.app — screenshots in myatt-bell-brief/screenshots/dark.png.',
  );
  // The live incident shape: a curl read-back + a changedFiles listing.
  const evidence = [
    'HTTP: 200\nbytes: 175030\ntitle: <title>Myatt & Bell\nurl checked: MYATT-BELL-BRIEF.netlify.app/',
    'Files created/changed:\n- screenshots/dark.png\n- index.html',
  ];
  assert.deepEqual(ungroundedPointers(pointers, evidence), [], 'observed pointers are grounded');

  // NOTHING observed → both come back, and the nudge stays model-owned.
  const ungrounded = ungroundedPointers(pointers, ['unrelated tool output']);
  assert.equal(ungrounded.length, 2);
  const nudge = claimGroundingNudge(ungrounded)!;
  assert.match(nudge, /nothing in this run ever observed/i);
  assert.match(nudge, /in whatever way fits/i, 'no verification recipe is dictated');
  assert.match(nudge, /re-state your reply unchanged/i, 'advisory — never a gate');
  assert.doesNotMatch(nudge, /netlify\b(?!\.app)/i, 'no provider-specific advice');
  assert.equal(claimGroundingNudge([]), null);
});

test('forms: URL normalization and path tail tolerance are structural, not provider-aware', () => {
  assert.equal(normalizeUrl('https://Foo.example.com/x/'), 'foo.example.com/x');
  const [pathPointer] = extractDeliverablePointers('the report is at output/reports/q3-final.pdf');
  assert.deepEqual(
    pointerEvidenceForms(pathPointer),
    ['output/reports/q3-final.pdf', 'reports/q3-final.pdf'],
    'absolute-vs-relative tolerance uses the last two segments',
  );
});

test('prose word/word pairs are not deliverable paths (live 2026-08-12 draft bounce)', () => {
  // "call/task" and "yes/no" in a quoted draft were judged as undelivered
  // file paths, which bounced the user's own requested content into a
  // verification summary.
  const pointers = extractDeliverablePointers(
    'The draft notes **6 call/task records** for Madison and asks for a clear yes/no decision, 24/7 coverage and/or fallback.',
  );
  assert.deepEqual(pointers, [], 'single-slash extension-less word pairs are prose');

  // Real deliverable paths keep their pointer status: extension, depth,
  // explicit marker, and hyphenated segments all still qualify.
  const real = extractDeliverablePointers(
    'Saved to drafts/lead-001.md, source in src/runtime/harness/loop.ts, '
    + 'staged at ./out/brief, shots in `myatt-bell/screenshots/`.',
  );
  assert.deepEqual(
    real.map((pointer) => pointer.normalized).sort(),
    ['./out/brief', 'drafts/lead-001.md', 'myatt-bell/screenshots', 'src/runtime/harness/loop.ts'],
  );
});

test('recall reads this run are collected as grounding evidence sources', () => {
  const events = [
    { type: 'tool_called', data: { sourceUserSeq: 100, tool: 'recall_tool_result', callId: 'call_recall_1' } },
    { type: 'tool_called', data: { sourceUserSeq: 100, tool: 'tool_output_query', callId: 'call_query_1' } },
    { type: 'tool_called', data: { sourceUserSeq: 100, tool: 'recall_tool_result', callId: 'call_recall_1' } },
    // Other turns and other tools never leak in.
    { type: 'tool_called', data: { sourceUserSeq: 99, tool: 'recall_tool_result', callId: 'call_prior_turn' } },
    { type: 'tool_called', data: { sourceUserSeq: 100, tool: 'run_shell_command', callId: 'call_shell' } },
    { type: 'tool_returned', data: { sourceUserSeq: 100, tool: 'recall_tool_result', callId: 'call_ret_only' } },
  ];
  assert.deepEqual(
    recallReadCallIdsForSource(events, 100),
    ['call_recall_1', 'call_query_1'],
  );
  // And quoted recalled content grounds the pointer end to end.
  const pointers = extractDeliverablePointers('Full draft saved at drafts/tyler-analysis.md.');
  assert.equal(
    ungroundedPointers(pointers, ['Recalled chars 0–8531 … body includes drafts/tyler-analysis.md …']).length,
    0,
  );
});
