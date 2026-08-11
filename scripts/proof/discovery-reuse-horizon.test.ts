import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  hasProviderEvidence,
  markdownTableField,
  terminalConversationSurfacesPreserveBytes,
  verifiedReadOptimizationChecks,
} from './scenarios/discovery-reuse-horizon.js';

const SOURCE_MARKER = 'PROOF_RELEASE_QUEUE:LOCAL_ONLY';
const IDENTIFIER = 'PROOF_LIST_TASKS';

test('conversation preservation checks recorded surface bytes without claiming raw model provenance', () => {
  const prose = 'I checked again — the queue is clear. Want me to open the release notes next?';
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'success',
      transport: null,
      reply: prose,
      presentationText: prose,
    },
  }), true);
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'claude_agent_sdk_brain',
      transport: null,
      reply: prose,
      presentationText: prose,
    },
  }), true, 'Claude keeps its own ordinary completion reason and voice');
});

test('conversation preservation accepts only byte-equal awaiting-input surfaces', () => {
  const question = 'Would you like me to create the note, or leave it alone?';
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: question,
    terminal: {
      reason: 'awaiting_user_input',
      transport: null,
      reply: question,
      presentationText: question,
    },
  }), true);
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: question,
    terminal: {
      reason: 'awaiting_user_input',
      transport: null,
      reply: `${question} `,
      presentationText: question,
    },
  }), false, 'trim-equivalent replacement is not byte-equal terminal output');
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: question,
    terminal: {
      reason: 'awaiting_user_input',
      transport: 'completed_answer_replay',
      reply: question,
      presentationText: question,
    },
  }), false, 'a replay transport is not an ordinary conversation surface');
});

test('conversation preservation accepts byte-equal surfaces authorized by the stall judge', () => {
  const prose = "Got it — Cedar's current release is Cedar-12. I'll remember that.";
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'stall_judge_delivered',
      transport: null,
      reply: prose,
      presentationText: prose,
    },
  }), true);
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'stall_judge_delivered',
      transport: null,
      reply: `${prose} `,
      presentationText: prose,
    },
  }), false, 'a stall verdict cannot mask even a whitespace replacement');
});

test('conversation preservation rejects synthetic replacement and private control prose', () => {
  const prose = 'The queue is clear.';
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'completed_answer_replay',
      transport: 'completed_answer_replay',
      reply: prose,
      presentationText: prose,
    },
  }), false);
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: '[harness settled-read] Use it for the next step or answer naturally.',
    terminal: {
      reason: 'success',
      transport: null,
      reply: '[harness settled-read] Use it for the next step or answer naturally.',
      presentationText: '[harness settled-read] Use it for the next step or answer naturally.',
    },
  }), false);
  assert.equal(terminalConversationSurfacesPreserveBytes({
    deliveredText: prose,
    terminal: {
      reason: 'success',
      transport: null,
      reply: 'Harness replacement.',
      presentationText: 'Harness replacement.',
    },
  }), false);
});

test('verified-read optimization requires receipts only on supported paths and labels Claude honestly', () => {
  const deliveredText = 'Source marker: PROOF_RELEASE_QUEUE:LOCAL_ONLY\nRevision: 1\nStatus: open';
  const digest = createHash('sha256').update(deliveredText).digest('hex');
  const supported = verifiedReadOptimizationChecks('supported read', {
    completionVerdicts: 0,
    reason: 'success',
    receiptKind: 'single_collection_read',
    receiptPresentationDigest: digest,
    receiptSourceUserSeq: 41,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'codex', 'single_collection_read');
  assert.equal(supported[1]?.pass, true);
  assert.match(supported[1]?.name ?? '', /supported path has an exact verified-read receipt/i);

  const missingSupportedReceipt = verifiedReadOptimizationChecks('supported read', {
    completionVerdicts: 0,
    reason: 'success',
    receiptKind: null,
    receiptPresentationDigest: null,
    receiptSourceUserSeq: null,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'glm', 'single_collection_read');
  assert.equal(missingSupportedReceipt[1]?.pass, false);

  const wrongSupportedReceipt = verifiedReadOptimizationChecks('cold supported read', {
    completionVerdicts: 0,
    reason: 'success',
    receiptKind: 'single_collection_read',
    receiptPresentationDigest: digest,
    receiptSourceUserSeq: 41,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'codex', 'read_discovery_scaffold');
  assert.equal(wrongSupportedReceipt[1]?.pass, false, 'a supported leg must carry its exact expected receipt kind');

  for (const selectedBrain of ['codex', 'glm'] as const) {
    const spoofedClaudeReason = verifiedReadOptimizationChecks(`${selectedBrain} spoofed reason`, {
      completionVerdicts: 0,
      reason: 'claude_agent_sdk_brain',
      receiptKind: null,
      receiptPresentationDigest: null,
      receiptSourceUserSeq: null,
      transport: null,
      reply: deliveredText,
      presentationText: deliveredText,
    }, deliveredText, 41, selectedBrain, 'single_collection_read');
    assert.equal(
      spoofedClaudeReason[1]?.pass,
      false,
      `${selectedBrain} support comes from the selected leg, never a terminal reason`,
    );
  }

  const claudeUnsupported = verifiedReadOptimizationChecks('Claude read', {
    completionVerdicts: 0,
    reason: 'claude_agent_sdk_brain',
    receiptKind: null,
    receiptPresentationDigest: null,
    receiptSourceUserSeq: null,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'claude', 'single_collection_read');
  assert.equal(claudeUnsupported[1]?.pass, true);
  assert.match(claudeUnsupported[1]?.name ?? '', /outside verified-read receipt support/i);

  const claudeReasonMismatch = verifiedReadOptimizationChecks('Claude reason mismatch', {
    completionVerdicts: 0,
    reason: 'success',
    receiptKind: null,
    receiptPresentationDigest: null,
    receiptSourceUserSeq: null,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'claude', 'single_collection_read');
  assert.equal(
    claudeReasonMismatch[1]?.pass,
    false,
    'the selected Claude leg must agree with the Claude terminal reason',
  );

  const claudeMislabelled = verifiedReadOptimizationChecks('Claude read', {
    completionVerdicts: 0,
    reason: 'claude_agent_sdk_brain',
    receiptKind: 'single_collection_read',
    receiptPresentationDigest: digest,
    receiptSourceUserSeq: 41,
    transport: null,
    reply: deliveredText,
    presentationText: deliveredText,
  }, deliveredText, 41, 'claude', 'single_collection_read');
  assert.equal(claudeMislabelled[1]?.pass, false, 'unsupported Claude evidence cannot be presented as receipt proof');
});

test('provider evidence accepts the Markdown table emitted by the live horizon', () => {
  const answer = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | Open |`,
  ].join('\n');

  assert.equal(markdownTableField(answer, 'Revision'), '1');
  assert.equal(markdownTableField(answer, 'Status'), 'Open');
  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
});

test('provider evidence rejects a correct table contradicted by whole-reply status prose', () => {
  const answer = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
    '',
    'The item is closed.',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), false);
});

test('provider evidence rejects ID, negation, possessive, and current-state contradictions', () => {
  const table = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ].join('\n');
  for (const contradiction of [
    'proof-release-1 is closed.',
    'Item is not open.',
    'The item isn’t open.',
    'The item’s status is closed.',
    "proof-release-1's status is closed.",
    'Current state: closed.',
  ]) {
    assert.equal(
      hasProviderEvidence(`${table}\n${contradiction}`, 1, 'open'),
      false,
      contradiction,
    );
  }
});

test('provider evidence validates current prose assertions for all five snapshot fields', () => {
  const table = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ].join('\n');
  const matching = [
    'However, the source marker is PROOF_RELEASE_QUEUE:LOCAL_ONLY.',
    'But the revision is 1.',
    'In fact, the item ID is proof-release-1.',
    'For clarity, the title is Review the Clementine 4 release proof.',
    'However, the status is open.',
  ];
  assert.equal(hasProviderEvidence([table, ...matching].join('\n'), 1, 'open'), true);

  for (const contradiction of [
    'However, the source marker is WRONG_SOURCE.',
    'But the revision is 2.',
    'In fact, the item ID is proof-release-2.',
    'For clarity, the title is Publish the Clementine 4 release proof.',
    'However, the status is closed.',
    'But the current state is closed.',
  ]) {
    assert.equal(
      hasProviderEvidence(`${table}\n${contradiction}`, 1, 'open'),
      false,
      contradiction,
    );
  }
});

test('provider evidence preserves exact GLM summaries and validates transition targets', () => {
  const learned = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ].join('\n');
  const currentSummary = 'One open item in the queue, at revision 1.';
  assert.equal(hasProviderEvidence(`${learned}\n${currentSummary}`, 1, 'open'), true, currentSummary);
  const continuitySummary = 'Still one open item, at revision 1.';
  assert.equal(hasProviderEvidence(`${learned}\n${continuitySummary}`, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(`${learned}\n${continuitySummary}`, 1, 'open', 'snapshot'), false);
  assert.equal(hasProviderEvidence(`${learned}\n${continuitySummary}`, 1, 'open', 'cold'), false);
  assert.equal(
    hasProviderEvidence(`${learned}\nOne closed item in the queue, at revision 1.`, 1, 'open'),
    false,
  );
  assert.equal(
    hasProviderEvidence(`${learned}\nStill one open item, at revision 2.`, 1, 'open', 'reuse'),
    false,
  );

  const changed = learned
    .replace('| 1 | proof-release-1', '| 2 | proof-release-1')
    .replace('| open |', '| done |');
  const transition = 'The queue advanced from revision 1 to revision 2, and the status flipped from open to done.';
  assert.equal(hasProviderEvidence(`${changed}\n${transition}`, 2, 'done', 'correction'), true);
  assert.equal(
    hasProviderEvidence(`${changed}\n${transition.replace('revision 2', 'revision 3')}`, 2, 'done', 'correction'),
    false,
  );
  assert.equal(
    hasProviderEvidence(`${changed}\n${transition.replace('to done', 'to closed')}`, 2, 'done', 'correction'),
    false,
  );
});

test('provider evidence binds comparison language to the exact horizon phase', () => {
  const open = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ].join('\n');
  const unchanged = [
    'Unchanged since the last read.',
    'No changes since last check.',
    'Unchanged from before.',
    'Queue refreshed — unchanged from the last pull:',
    'Refreshed — the queue is unchanged:',
    'Still 1 item, unchanged since the last read — same source and revision via the local proof provider.',
  ];
  for (const line of unchanged) {
    assert.equal(hasProviderEvidence(`${open}\n${line}`, 1, 'open', 'reuse'), true, line);
    assert.equal(hasProviderEvidence(`${open}\n${line}`, 1, 'open', 'cold'), false, `cold: ${line}`);
  }

  const changed = open.replace(' | 1 | ', ' | 2 | ').replace(' | open |', ' | done |');
  const transitions = [
    'State changed since the last read — the item is now done.',
    'The item flipped from open to done since the last read.',
    'The state changed since last read: the item moved from open to done (revision 1 → 2).',
    'The queue advanced from revision 1 to revision 2, and the status flipped from open to done.',
  ];
  for (const line of transitions) {
    assert.equal(hasProviderEvidence(`${changed}\n${line}`, 2, 'done', 'correction'), true, line);
    assert.equal(hasProviderEvidence(`${changed}\n${line}`, 2, 'done', 'reuse'), false, `reuse: ${line}`);
  }
  for (const line of unchanged) {
    assert.equal(hasProviderEvidence(`${changed}\n${line}`, 2, 'done', 'correction'), false, `changed: ${line}`);
  }
});

test('provider evidence accepts explicit Markdown bullet labels', () => {
  const answer = [
    `Source marker: \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item ID:** proof-release-1',
    '- **Title:** Review the Clementine 4 release proof',
    '- **Status:** Open.',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
});

test('provider evidence accepts Claude\'s strict Source label and rejects conflicting aliases', () => {
  const answer = [
    'Results from `PROOF_LIST_TASKS`:',
    '',
    `- **Source:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item:** id `proof-release-1`, title "Review the Clementine 4 release proof", status **open**',
  ].join('\n');
  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer.replace(SOURCE_MARKER, 'WRONG_SOURCE'), 1, 'open'), false);
  assert.equal(
    hasProviderEvidence(`${answer}\nSource marker: WRONG_SOURCE`, 1, 'open'),
    false,
    'a correct Source alias cannot hide a conflicting Source marker',
  );
});

test('provider evidence binds neutral provenance prose to the exact proof tool and provider', () => {
  const snapshot = [
    `Source: ${SOURCE_MARKER}`,
    'Revision: 1',
    'Item: id proof-release-1, title "Review the Clementine 4 release proof", status open',
  ].join('\n');
  assert.equal(hasProviderEvidence(`Results from ${IDENTIFIER}:\n${snapshot}`, 1, 'open'), true);
  for (const heading of ['Results from WRONG_TOOL:', 'Results from PROOF_DELETE_TASKS:']) {
    assert.equal(hasProviderEvidence(`${heading}\n${snapshot}`, 1, 'open'), false, heading);
  }
  const provider = "Read fetched fresh via the authenticated Composio CLI's local proof provider (no account selected).";
  assert.equal(hasProviderEvidence(`${snapshot}\n${provider}`, 1, 'open'), true);
  assert.equal(
    hasProviderEvidence(`${snapshot}\n${provider.replace('local proof', 'fictional wrong')}`, 1, 'open'),
    false,
  );
});

test('provider evidence accepts the retained GLM heading/table voice and exact summaries', () => {
  const openTable = [
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | open |',
  ].join('\n');
  const cold = [
    `Here are the current items in the proof release queue (source marker \`${SOURCE_MARKER}\`, revision 1):`,
    '',
    openTable,
    '',
    'Total: 1 item. Read fetched fresh via the authenticated Composio CLI\'s local proof provider (no account selected).',
  ].join('\n');
  const reuse = [
    `Fresh read of the proof release queue (source marker \`${SOURCE_MARKER}\`, revision 1):`,
    '',
    openTable,
    '',
    'Still 1 item, unchanged since the last read — same source and revision via the local proof provider.',
  ].join('\n');
  const resumed = [
    `Fresh read of the proof release queue (source marker \`${SOURCE_MARKER}\`, now at **revision 2**):`,
    '',
    openTable.replace('| open |', '| done |'),
    '',
    'Still 1 item, but its status flipped from `open` → `done` and the revision advanced from 1 to 2 — the provider state changed since the last read.',
  ].join('\n');

  assert.equal(hasProviderEvidence(cold, 1, 'open', 'cold'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(resumed, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(resumed.replace('`done`', '`closed`'), 2, 'done', 'correction'), false);
  assert.equal(hasProviderEvidence(resumed.replace('from 1 to 2', 'from 1 to 3'), 2, 'done', 'correction'), false);

  const labeledResume = [
    "State has advanced — here's the refreshed queue:",
    '',
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 2 (up from 1)',
    '- **Total items:** 1',
    '',
    openTable.replace('| open |', '| done |'),
    '',
    'The only item flipped from **open** to **done** since the last read.',
  ].join('\n');
  assert.equal(hasProviderEvidence(labeledResume, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(labeledResume.replace('**done** since', '**closed** since'), 2, 'done', 'correction'), false);
  assert.equal(hasProviderEvidence(`${labeledResume}\nState is closed.`, 2, 'done', 'correction'), false);
  assert.equal(hasProviderEvidence(`${labeledResume}\nCurrent state: closed.`, 2, 'done', 'correction'), false);

  for (const [name, answer] of [
    ['detached table', cold.replace(`\n\n${openTable}`, `\n\n**Current snapshot:**\n\n${openTable}`)],
    ['quoted heading', cold.replace('Here are the current items', '> Here are the current items')],
    ['lazy blockquote heading', `> quoted snapshot:\n${cold}`],
    ['inline-code heading', cold.replace(/^Here[^\n]+/u, (line) => `\`${line}\``)],
    ['fenced heading', ['```', ...cold.split('\n'), '```'].join('\n')],
    ['mixed fence cannot close quoted content', ['```md', '~~~', ...cold.split('\n'), '```'].join('\n')],
    ['fence prefix with trailing text cannot close quoted content', ['```text', '``` still code', ...cold.split('\n'), '```'].join('\n')],
    ['raw HTML literal', ['<pre>', ...cold.split('\n'), '</pre>'].join('\n')],
    ['raw HTML block', ['<div>', ...cold.split('\n'), '</div>'].join('\n')],
    ['CDATA raw block', ['<![CDATA[', ...cold.split('\n'), ']]>'].join('\n')],
    ['stale heading', cold.replace('Here are the current items', 'Current snapshot may be stale; here are the current items')],
    ['unlabeled pair', cold.replace(`source marker \`${SOURCE_MARKER}\`, `, `\`${SOURCE_MARKER}\`, `)],
    ['wrong marker', cold.replace(SOURCE_MARKER, 'WRONG_SOURCE')],
    ['wrong revision', cold.replace('revision 1):', 'revision 2):')],
    ['duplicate pair/table', `${cold}\n\n${cold}`],
    ['duplicate pair on one heading', cold.replace('):', `) and (source marker \`${SOURCE_MARKER}\`, revision 1):`)],
    ['indented code snapshot', cold.split('\n').map((line) => line ? `    ${line}` : line).join('\n')],
    ['supposed current heading', cold.replace('Here are the current items', 'Here are supposedly the current items')],
    ['unverified relative clause', cold.replace(' in the proof release queue', " in the proof release queue I can’t verify")],
    ['fictional sample clause', cold.replace(' in the proof release queue', ' in the proof release queue copied from a fictional sample')],
    ['different queue scope', cold.replace('proof release queue', 'wrong queue')],
    ['fictional queue scope', cold.replace('proof release queue', 'fictional sample queue')],
    ['space-tab indented code', cold.split('\n').map((line) => line ? ` \t${line}` : line).join('\n')],
    ['orphan conflicting row', `${cold}\n\n| proof-release-1 | Fabricated title | closed |`],
  ] as const) {
    assert.equal(hasProviderEvidence(answer, 1, 'open'), false, name);
  }


  for (const [name, answer] of [
    ['fenced labels', ['```text', `Source: ${SOURCE_MARKER}`, 'Revision: 1', '```', openTable].join('\n')],
    ['blockquote labels', [`> Source: ${SOURCE_MARKER}`, '> Revision: 1', openTable].join('\n')],
    ['indented labels', [`    Source: ${SOURCE_MARKER}`, '    Revision: 1', openTable].join('\n')],
    ['HTML-commented labels', ['<!--', `Source: ${SOURCE_MARKER}`, 'Revision: 1', '-->', openTable].join('\n')],
  ] as const) {
    assert.equal(hasProviderEvidence(answer, 1, 'open'), false, name);
  }
});

test('provider evidence accepts the exact live mixed-horizon GLM voices', () => {
  const table = (status: string): string => [
    '| Item ID | Title | Status |',
    '|---|---|---|',
    `| proof-release-1 | Review the Clementine 4 release proof | ${status} |`,
  ].join('\n');
  const snapshot = (revision: number, status: string): string => [
    `- **Source marker:** ${SOURCE_MARKER}`,
    `- **Revision:** ${revision}`,
    '',
    table(status),
  ].join('\n');
  const cold = [
    'Here are the current items in the proof release queue:',
    '',
    snapshot(1, 'open'),
    '',
    '1 item total.',
  ].join('\n');
  const reuse = [
    'Fresh data from the same source:',
    '',
    snapshot(1, 'open'),
    '',
    'Unchanged from the last pull — still 1 item, revision 1.',
  ].join('\n');
  const correction = [
    'Fresh pull from the queue:',
    '',
    snapshot(2, 'done'),
    '',
    'The item moved from **open → done**, and the revision bumped from 1 → 2.',
  ].join('\n');

  assert.equal(hasProviderEvidence(cold, 1, 'open', 'cold'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'correction'), true);
  assert.equal(
    hasProviderEvidence(reuse.replace('revision 1.', 'revision 2.'), 1, 'open', 'reuse'),
    false,
  );
  assert.equal(
    hasProviderEvidence(correction.replace('open → done', 'closed → done'), 2, 'done', 'correction'),
    false,
  );
  assert.equal(
    hasProviderEvidence(correction.replace('Fresh pull from the queue:', 'Fresh pull from the wrong queue:'), 2, 'done', 'correction'),
    false,
  );
});

test('provider evidence accepts the exact second live GLM reuse and restart voices', () => {
  const snapshot = (revision: number, status: string): string => [
    '| Field | Value |',
    '|---|---|',
    `| Source marker | ${SOURCE_MARKER} |`,
    `| Revision | ${revision} |`,
    '',
    '**Items (1 total):**',
    '',
    '| Item ID | Title | Status |',
    '|---|---|---|',
    `| proof-release-1 | Review the Clementine 4 release proof | ${status} |`,
  ].join('\n');
  const reuse = [
    'Refreshed — queue is unchanged:',
    '',
    snapshot(1, 'open'),
  ].join('\n');
  const correction = [
    'Fresh read — the queue state has changed (revision bumped from 1 to 2):',
    '',
    snapshot(2, 'done'),
  ].join('\n');

  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'cold'), false);
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'reuse'), false);
  assert.equal(
    hasProviderEvidence(correction.replace('from 1 to 2', 'from 0 to 2'), 2, 'done', 'correction'),
    false,
  );
  assert.equal(
    hasProviderEvidence(correction.replace('from 1 to 2', 'from 1 to 3'), 2, 'done', 'correction'),
    false,
  );
});

test('provider evidence owns the 12:48 GLM count bridge and phase-bound prose', () => {
  const snapshot = (revision: number, status: string): string => [
    '| Field | Value |',
    '|---|---|',
    `| **Source marker** | \`${SOURCE_MARKER}\` |`,
    `| **Revision** | ${revision} |`,
    '',
    '**Items (1 total):**',
    '',
    '| Item ID | Title | Status |',
    '|---|---|---|',
    `| proof-release-1 | Review the Clementine 4 release proof | ${status} |`,
  ].join('\n');
  const cold = [
    'Proof release queue — current items:',
    '',
    `- **Source marker:** ${SOURCE_MARKER}`,
    '- **Revision:** 1',
    '- **Item id:** proof-release-1',
    '- **Title:** Review the Clementine 4 release proof',
    '- **Status:** open',
    '',
    'Total: 1 item.',
  ].join('\n');
  const reuse = [
    "Here's the current proof release queue:",
    '',
    snapshot(1, 'open'),
    '',
    'Pulled fresh from the same connected source via the proven capability. One open item in the queue.',
  ].join('\n');
  const correction = [
    'Fresh read complete — the provider state updated:',
    '',
    snapshot(2, 'done'),
    '',
    'The queue advanced from revision 1 → 2, and the single item flipped from **open** to **done**.',
  ].join('\n');

  assert.equal(hasProviderEvidence(cold, 1, 'open', 'cold'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'correction'), true);

  for (const phase of ['snapshot', 'cold', 'correction'] as const) {
    assert.equal(hasProviderEvidence(reuse, 1, 'open', phase), false, `reuse prose in ${phase}`);
  }
  for (const phase of ['snapshot', 'cold', 'reuse'] as const) {
    assert.equal(hasProviderEvidence(correction, 2, 'done', phase), false, `correction prose in ${phase}`);
  }
  for (const [name, answer, revision, status, phase] of [
    ['wrong bridge count', reuse.replace('Items (1 total)', 'Items (2 total)'), 1, 'open', 'reuse'],
    ['quoted bridge', reuse.replace('**Items (1 total):**', '> **Items (1 total):**'), 1, 'open', 'reuse'],
    ['extra bridge section', reuse.replace('**Items (1 total):**', '**Items (1 total):**\n\n**Current snapshot:**'), 1, 'open', 'reuse'],
    ['detached bridge', reuse.replace('\n**Items (1 total):**\n', '\n').concat('\n\n**Items (1 total):**'), 1, 'open', 'reuse'],
    ['wrong provenance', reuse.replace('same connected source', 'same fictional source'), 1, 'open', 'reuse'],
    ['wrong compact status', reuse.replace('One open item', 'One closed item'), 1, 'open', 'reuse'],
    ['wrong revision target', correction.replace('revision 1 → 2', 'revision 1 → 3'), 2, 'done', 'correction'],
    ['wrong status target', correction.replace('to **done**.', 'to **closed**.'), 2, 'done', 'correction'],
  ] as const) {
    assert.equal(hasProviderEvidence(answer, revision, status, phase), false, name);
  }
});

test('provider evidence composes 13:03 navigation and summary facts without erasing temporal words', () => {
  const table = (revision: number, status: string): string => [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---|---|---|---|',
    `| ${SOURCE_MARKER} | ${revision} | proof-release-1 | Review the Clementine 4 release proof | ${status} |`,
  ].join('\n');
  const cold = [
    'Proof release queue — current items:',
    '',
    table(1, 'open'),
    '',
    '1 item total, all open.',
  ].join('\n');
  const reuse = [
    'Proof release queue refreshed from the same source:',
    '',
    table(1, 'open'),
    '',
    '1 item total.',
  ].join('\n');
  const correction = [
    'Fresh read from the same source:',
    '',
    table(2, 'done'),
    '',
    'The item flipped from **open** to **done** since the last read (revision bumped 1 → 2).',
  ].join('\n');
  assert.equal(hasProviderEvidence(cold, 1, 'open', 'cold'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'correction'), true);
  for (const [name, candidate] of [
    ['invented prior status', correction.replace('from **open** to', 'from **fabricated** to')],
    ['invented prior revision', correction.replace('bumped 1 → 2', 'bumped 999 → 2')],
    ['false status continuity', correction.replace(
      'The item flipped from **open** to **done** since the last read (revision bumped 1 → 2).',
      'Still 1 done item.',
    )],
  ] as const) {
    assert.equal(hasProviderEvidence(candidate, 2, 'done', 'correction'), false, name);
  }

  const historicalHeadings = [
    'Here is a previous read:',
    'Current read from previous source:',
    'Read current previous state:',
    'Previous read current items:',
    'The previous read results:',
    'Current result from previous read:',
    'Fresh read from the wrong source:',
    'Unverified fresh read:',
  ];
  for (const heading of historicalHeadings) {
    assert.equal(hasProviderEvidence(`${heading}\n\n${table(1, 'open')}`, 1, 'open', 'cold'), false, heading);
  }

  const still = `${table(1, 'open')}\n\nStill 1 item total, all open.`;
  assert.equal(hasProviderEvidence(still, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(still, 1, 'open', 'cold'), false);
  assert.equal(hasProviderEvidence(still, 1, 'open', 'snapshot'), false);
  for (const summary of [
    '2 items total, all open.',
    '1 item total, all closed.',
    '1 item total, not all open.',
    'Previously 1 item total, all open.',
    'Maybe 1 item total, all open.',
  ]) {
    assert.equal(hasProviderEvidence(`${table(1, 'open')}\n\n${summary}`, 1, 'open', 'cold'), false, summary);
  }
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'cold'), false, 'same-source heading is temporal');
  assert.equal(hasProviderEvidence(correction, 2, 'done', 'reuse'), false, 'correction transition is phase-bound');
});

test('provider evidence owns the latest scoped GLM block as one exact unit', () => {
  const reply = (revision: number, status: string, suffix: string): string => [
    `Proof release queue (local provider, revision ${revision}):`,
    '',
    `- **proof-release-1** — "Review the Clementine 4 release proof" — status: **${status}**`,
    '',
    `Source marker: \`${SOURCE_MARKER}\`. ${suffix}`,
  ].join('\n');
  const cold = reply(1, 'open', "That's the only current item.");
  const reuse = reply(1, 'open', 'Unchanged since the last read.');
  const resumed = reply(2, 'done', 'State changed since the last read — the item is now done');
  assert.equal(hasProviderEvidence(cold, 1, 'open', 'cold'), true);
  assert.equal(hasProviderEvidence(reuse, 1, 'open', 'reuse'), true);
  assert.equal(hasProviderEvidence(resumed, 2, 'done', 'correction'), true);

  for (const [name, candidate, revision, status] of [
    ['wrong scope', reuse.replace('Proof release queue', 'Wrong queue'), 1, 'open'],
    ['mid-token scope', reuse.replace('Proof release queue', 'Roof release queue'), 1, 'open'],
    ['wrong revision', reuse.replace('revision 1', 'revision 2'), 1, 'open'],
    ['wrong marker', reuse.replace(SOURCE_MARKER, 'WRONG_SOURCE'), 1, 'open'],
    ['wrong item', reuse.replace('proof-release-1', 'proof-release-2'), 1, 'open'],
    ['wrong title', reuse.replace('Review the Clementine 4 release proof', 'Publish a fictional proof'), 1, 'open'],
    ['wrong status', reuse.replace('status: **open**', 'status: **closed**'), 1, 'open'],
    ['wrong suffix status', resumed.replace('item is now done', 'item is now closed'), 2, 'done'],
    ['reordered block', reuse.split('\n').reverse().join('\n'), 1, 'open'],
    ['detached block', reuse.replace('\n\n- **proof-release-1**', '\n\nHistorical snapshot:\n\n- **proof-release-1**'), 1, 'open'],
    ['extra sensitive suffix', reuse.replace('Unchanged since the last read.', 'Unchanged since the last read, but revision is 2.'), 1, 'open'],
    ['malformed scoped heading', reuse.replace('revision 1', 'rev 9'), 1, 'open'],
    ['duplicate block', `${reuse}\n\n${reuse}`, 1, 'open'],
    ['extra full table', `${reuse}\n\n| Source marker | Revision | Item ID | Title | Status |\n|---|---|---|---|---|\n| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`, 1, 'open'],
    ['extra labels', `${reuse}\n\nSource marker: ${SOURCE_MARKER}\nRevision: 1\nItem ID: proof-release-1\nTitle: Review the Clementine 4 release proof\nStatus: open`, 1, 'open'],
  ] as const) {
    assert.equal(hasProviderEvidence(candidate, revision, status), false, name);
  }
});

test('provider evidence abstains on unconsumed factual tails, quoted sections, and global disclaimers', () => {
  const changed = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 2 | proof-release-1 | Review the Clementine 4 release proof | done |`,
  ].join('\n');
  for (const [name, suffix] of [
    ['explicit field tail', 'However, the status is done, but now closed.'],
    ['one-item tail', 'One done item in the queue, at revision 2, but now closed.'],
    ['row transition tail', 'The only item flipped from open to done since the last read, but is now closed.'],
    ['invented row-transition history', 'The only item flipped from open to done since it actually became closed.'],
    ['combined transition tail', 'The queue advanced from revision 1 to revision 2, and the status flipped from open to done, but now closed.'],
    ['revision heading tail', 'Fresh read — the queue advanced to revision 2, but is now revision 3:'],
  ] as const) {
    assert.equal(hasProviderEvidence(`${changed}\n${suffix}`, 2, 'done'), false, name);
  }

  const historicalComposition = [
    'Historical snapshot:',
    `Source marker: ${SOURCE_MARKER}`,
    'Revision: 1',
    'Current items:',
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | open |',
  ].join('\n');
  const multilineQuote = historicalComposition
    .replace('Historical snapshot:', '“Quoted snapshot:')
    .replace('Current items:', '”\nCurrent items:');
  const complete = changed
    .replace('| 2 |', '| 1 |')
    .replace('| done |', '| open |');
  for (const [name, answer] of [
    ['historical section', historicalComposition],
    ['historical intro section', historicalComposition.replace('Historical snapshot:', 'Here is a historical snapshot:')],
    ['example intro section', historicalComposition.replace('Historical snapshot:', 'For example:')],
    ['reported section', historicalComposition.replace('Historical snapshot:', 'Reported snapshot:')],
    ['attributed section', historicalComposition.replace('Historical snapshot:', 'The previous answer said:')],
    ['copied section', historicalComposition.replace('Historical snapshot:', 'Copied from memory:')],
    ['malformed scoped near-miss section', historicalComposition.replace('Historical snapshot:', 'Proof release queue (local provider, rev 9):')],
    ['fictional section', historicalComposition.replace('Historical snapshot:', 'Fictional example:')],
    ['earlier section', historicalComposition.replace('Historical snapshot:', 'Earlier result:')],
    ['typographic multiline quote', multilineQuote],
    ['fictional disclaimer', `${complete}\nThis entire answer is fictional.`],
    ['trust disclaimer', `${complete}\nDo not trust these values.`],
    ['uncertain values disclaimer', `${complete}\nThese values may be wrong.`],
    ['stale data disclaimer', `${complete}\nThe data above is stale.`],
    ['example disclaimer', `${complete}\nThis is only an example.`],
    ['indirect trust disclaimer', `${complete}\nThe answer above should not be trusted.`],
    ['fabricated-table disclaimer', `${complete}\nIgnore the table above; it was fabricated.`],
    ['unbound verification disclaimer', `${complete}\nI cannot verify this.`],
    ['pronoun correction', `${complete}\nActually, it is closed.`],
    ['explicit pronoun correction', `${complete}\nCorrection: it is closed.`],
    ['pronoun-now contradiction', `${complete}\nIt is now closed.`],
    ['modal revision contradiction', `${complete}\nRevision should be 2.`],
    ['modal source contradiction', `${complete}\nSource marker may be WRONG_SOURCE.`],
    ['unverified whole answer', `${complete}\nNone of this is verified.`],
    ['reliance disclaimer', `${complete}\nDo not rely on the table above.`],
    ['currentness disclaimer', `${complete}\nThis may not be current.`],
    ['made-up values', `${complete}\nThese values are made up.`],
    ['unverified values', `${complete}\nI did not verify these values.`],
  ] as const) {
    assert.equal(hasProviderEvidence(answer, 1, 'open'), false, name);
  }
  assert.equal(
    hasProviderEvidence(`${complete}\nIt is open.`, 1, 'open'),
    true,
    'an exact pronoun status remains conversational and provider-bound',
  );
});

test('provider evidence requires all five requested fields for every provider shape', () => {
  const lines = [
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ];
  const headers = ['Source marker', 'Revision', 'Item ID', 'Title', 'Status'];
  const values = [SOURCE_MARKER, '1', 'proof-release-1', 'Review the Clementine 4 release proof', 'open'];
  const complete = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...lines,
  ].join('\n');
  assert.equal(hasProviderEvidence(complete, 1, 'open'), true);
  for (let omitted = 0; omitted < headers.length; omitted += 1) {
    const keptHeaders = headers.filter((_, index) => index !== omitted);
    const keptValues = values.filter((_, index) => index !== omitted);
    const incomplete = [
      `| ${keptHeaders.join(' | ')} |`,
      `| ${keptHeaders.map(() => '---').join(' | ')} |`,
      `| ${keptValues.join(' | ')} |`,
    ].join('\n');
    assert.equal(hasProviderEvidence(incomplete, 1, 'open'), false, `omitting ${headers[omitted]} fails`);
  }
});

test('provider evidence rejects incidental status prose and partial marker matches', () => {
  assert.equal(hasProviderEvidence([
    SOURCE_MARKER,
    'Revision: 1',
    'The prior status was open, but the current status is unknown.',
  ].join('\n'), 1, 'open'), false);

  assert.equal(hasProviderEvidence([
    `NOT_${SOURCE_MARKER}`,
    'Revision: 1',
    'Status: open',
  ].join('\n'), 1, 'open'), false);
});

test('provider evidence does not combine mismatched table rows', () => {
  const answer = [
    SOURCE_MARKER,
    '| Revision | Status |',
    '|---:|---|',
    '| 1 | closed |',
    '| 2 | open |',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), false);

  const conflictingExtraRow = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---:|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | closed |`,
  ].join('\n');
  assert.equal(
    hasProviderEvidence(conflictingExtraRow, 1, 'open'),
    false,
    'a correct first row cannot hide a contradictory structured assertion',
  );
  const identicalExtraRow = conflictingExtraRow.replace('| closed |', '| open |');
  assert.equal(
    hasProviderEvidence(identicalExtraRow, 1, 'open'),
    false,
    'provider total=1 rejects even an identical second structured row',
  );
  const oneRowTable = identicalExtraRow.split('\n').slice(0, 3).join('\n');
  assert.equal(
    hasProviderEvidence(`${oneRowTable}\n\n${oneRowTable}`, 1, 'open'),
    false,
    'duplicate horizontal snapshots cannot compose into one-row evidence',
  );
});

test('provider evidence rejects marker-adjacent prose as sole positive metadata evidence', () => {
  const learned = [
    `Refreshed from connected source (\`${SOURCE_MARKER}\`, revision 1):`,
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | open |',
  ].join('\n');
  const corrected = [
    `Refreshed from connected source (\`${SOURCE_MARKER}\`, revision 2 — updated from revision 1):`,
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | closed |',
  ].join('\n');

  assert.equal(hasProviderEvidence(learned, 1, 'open'), false);
  assert.equal(hasProviderEvidence(corrected, 2, 'closed'), false);
  assert.equal(hasProviderEvidence(corrected, 1, 'closed'), false, 'stale comparison revision cannot win');
});

test('provider evidence accepts a terminal status attribute inside a strict Item label', () => {
  const learned = [
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item:** `proof-release-1` — "Review the Clementine 4 release proof" — status: **open**',
  ].join('\n');
  const corrected = [
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 2',
    '- **Item:** `proof-release-1` — "Review the Clementine 4 release proof" — status: **done**',
  ].join('\n');

  assert.equal(hasProviderEvidence(learned, 1, 'open'), true);
  assert.equal(hasProviderEvidence(corrected, 2, 'done'), true);
  assert.equal(hasProviderEvidence(corrected, 1, 'done'), false);
  assert.equal(hasProviderEvidence([
    `Source marker: ${SOURCE_MARKER}`,
    'Revision: 1',
    'Item: proof-release-1 — prior status: open, but current status is unknown',
  ].join('\n'), 1, 'open'), false, 'incidental historical status prose is not a field');
});

test('provider evidence accepts Claude comma-delimited status in a strict known Item label', () => {
  const answer = [
    'Results from `PROOF_LIST_TASKS`:',
    '',
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item:** id `proof-release-1`, title "Review the Clementine 4 release proof", status **open**',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 2, 'open'), false);
  assert.equal(hasProviderEvidence(answer, 1, 'done'), false);
});

test('comma-delimited Item evidence rejects incidental and historical status mentions', () => {
  const incidental = [
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item:** id `proof-release-1`, title "Review the Clementine 4 release proof", prior status **open**, current state unknown',
  ].join('\n');
  const historical = [
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 1',
    '- **Item:** id `proof-release-1`, title "Review the Clementine 4 release proof", status **unknown** (was open)',
  ].join('\n');

  assert.equal(hasProviderEvidence(incidental, 1, 'open'), false);
  assert.equal(hasProviderEvidence(historical, 1, 'open'), false);

  const metadata = [`Source: ${SOURCE_MARKER}`, 'Revision: 1'];
  for (const itemLine of [
    'Item: id proof-release-1, title "Review the Clementine 4 release proof", current status closed, status open',
    'Item: id proof-release-1, title "Review the Clementine 4 release proof", current state closed, status open',
    'Item: id proof-release-1, title "Review the Clementine 4 release proof", revision 2, status open',
    'Item: id proof-release-1, title "Review the Clementine 4 release proof", source marker WRONG_SOURCE, status open',
    'Item: item id proof-release-2, id proof-release-1, title "Review the Clementine 4 release proof", status open',
    'Item: title "Fabricated title", id proof-release-1, title "Review the Clementine 4 release proof", status open',
    'Item: proof-release-1 — status closed — "Review the Clementine 4 release proof" — status: open',
    'Item: This is fictional — proof-release-1 — "Review the Clementine 4 release proof" — status: open',
    'This is fictional — proof-release-1 — "Review the Clementine 4 release proof" — status open',
  ]) {
    assert.equal(hasProviderEvidence([...metadata, itemLine].join('\n'), 1, 'open'), false, itemLine);
  }
});

test('provider evidence accepts Markdown emphasis around strict snapshot labels', () => {
  const answer = [
    `Source marker: **${SOURCE_MARKER}**`,
    'Revision: **1**',
    '- Item id: `proof-release-1`',
    '- Title: "Review the Clementine 4 release proof"',
    '- Status: open',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 2, 'open'), false);
});

test('provider evidence accepts a paired vertical Field/Value table', () => {
  const answer = [
    '| Field | Value |',
    '|---|---|',
    `| Source marker | ${SOURCE_MARKER} |`,
    '| Revision | 1 |',
    '| Item id | proof-release-1 |',
    '| Title | Review the Clementine 4 release proof |',
    '| Status | open |',
  ].join('\n');

  assert.equal(markdownTableField(answer, 'Revision'), '1');
  assert.equal(markdownTableField(answer, 'Status'), 'open');
  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 2, 'open'), false);
});

test('provider evidence consumes only closed, exact Markdown table schemas', () => {
  const full = [
    '| Source marker | Revision | Item ID | Title | Status |',
    '|---|---|---|---|---|',
    `| ${SOURCE_MARKER} | 1 | proof-release-1 | Review the Clementine 4 release proof | open |`,
  ].join('\n');
  assert.equal(hasProviderEvidence(full, 1, 'open'), true);

  for (const [header, value] of [
    ['Notes', 'current status closed'],
    ['Actual revision', '2'],
    ['Previous status', 'closed'],
    ['Status 2', 'done'],
    ['Source note', 'source marker WRONG_SOURCE'],
  ] as const) {
    const reply = full
      .replace(' | Status |', ` | Status | ${header} |`)
      .replace('|---|---|---|---|---|', '|---|---|---|---|---|---|')
      .replace(' | open |', ` | open | ${value} |`);
    assert.equal(hasProviderEvidence(reply, 1, 'open'), false, `extra column ${header}`);
  }

  for (const detached of [
    ['| Notes |', '|---|', '| current status closed |'],
    ['| Key | Value |', '|---|---|', '| warning | it is closed |'],
    ['| Kind | Claim |', '|---|---|', '| disclaimer | This snapshot is not current |'],
  ]) {
    assert.equal(hasProviderEvidence([full, '', ...detached].join('\n'), 1, 'open'), false, detached[0]);
  }

  const vertical = [
    '| Field | Value |',
    '|---|---|',
    `| Source marker | ${SOURCE_MARKER} |`,
    '| Revision | 1 |',
    '| Item id | proof-release-1 |',
    '| Title | Review the Clementine 4 release proof |',
    '| Status | open |',
  ];
  for (const extraRow of [
    '| Warning | current status closed |',
    '| Actual revision | 2 |',
    '| Current State | closed |',
    '| Other source | WRONG_SOURCE |',
    '| Status | open |',
  ]) {
    assert.equal(hasProviderEvidence([...vertical, extraRow].join('\n'), 1, 'open'), false, extraRow);
  }
  for (const divider of ['|-|-|-|-|-|', '|--|--|--|--|--|']) {
    assert.equal(
      hasProviderEvidence(full.replace('|---|---|---|---|---|', divider), 1, 'open'),
      false,
      divider,
    );
  }
});

test('provider evidence composes a metadata table with the exact known-item status table', () => {
  const answer = [
    '| Field | Value |',
    '|---|---|',
    `| **Source marker** | ${SOURCE_MARKER} |`,
    '| **Revision** | 1 |',
    '',
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | open |',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 2, 'open'), false, 'metadata revision remains exact');
  assert.equal(
    hasProviderEvidence(answer.replace('proof-release-1', 'unrelated-item'), 1, 'open'),
    false,
    'an unrelated item row cannot supply status',
  );
  assert.equal(
    hasProviderEvidence([
      `Historical source marker: ${SOURCE_MARKER}`,
      answer.replace(`| **Source marker** | ${SOURCE_MARKER} |\n`, ''),
    ].join('\n'), 1, 'open'),
    false,
    'a marker outside the metadata table cannot authorize its revision',
  );
  assert.equal(
    hasProviderEvidence([
      `Historical source marker: ${SOURCE_MARKER}`,
      answer.replace(`| **Source marker** | ${SOURCE_MARKER} |`, `| **Source marker** | NOT_${SOURCE_MARKER} |`),
    ].join('\n'), 1, 'open'),
    false,
    'the metadata table must carry the exact marker value',
  );
  assert.equal(
    hasProviderEvidence([
      answer.replace('| proof-release-1 | Review the Clementine 4 release proof | open |', '| unrelated-item | Other | open |'),
      '| proof-release-1 | Review the Clementine 4 release proof | done |',
    ].join('\n'), 1, 'open'),
    false,
    'the first unrelated row cannot be combined with the known item',
  );
  assert.equal(
    hasProviderEvidence(
      answer.replace('| proof-release-1 | Review the Clementine 4 release proof | open |', '| proof-release-1 | Review the Clementine 4 release proof | unknown (was open) |'),
      1,
      'open',
    ),
    false,
    'historical status text cannot replace the exact item current status',
  );
  assert.equal(
    hasProviderEvidence(answer.replace('\n\n| Item ID', '\n\n**Current snapshot:**\n\n| Item ID'), 1, 'open'),
    false,
    'metadata and item tables cannot be composed across a new snapshot section',
  );
});

test('provider evidence composes a strict Revision label with a Status table', () => {
  const answer = [
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | done |',
    '',
    `- **Source marker:** \`${SOURCE_MARKER}\``,
    '- **Revision:** 2',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(answer, 1, 'done'), false);
});

test('provider evidence accepts a known-item bullet with terminal status', () => {
  const answer = [
    `Source marker: \`${SOURCE_MARKER}\``,
    'Revision: 1',
    '',
    '- **proof-release-1** — "Review the Clementine 4 release proof" — status: **open**',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 1, 'done'), false);
  assert.equal(hasProviderEvidence(answer.replace('proof-release-1', 'unrelated-item'), 1, 'open'), false);
});

test('provider evidence accepts a known-item dash-delimited terminal status without a colon', () => {
  const answer = [
    `Source marker: **${SOURCE_MARKER}**`,
    'Revision: **1**',
    'Item: id proof-release-1 — "Review the Clementine 4 release proof" — status **open**.',
  ].join('\n');
  const enDashAnswer = answer.replaceAll('—', '–');

  assert.equal(hasProviderEvidence(answer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(enDashAnswer, 1, 'open'), true);
  assert.equal(hasProviderEvidence(answer, 2, 'open'), false);
  assert.equal(hasProviderEvidence(answer, 1, 'done'), false);
});

test('colonless known-item status remains terminal, current, and bound to the exact item', () => {
  const prefix = [`Source marker: **${SOURCE_MARKER}**`, 'Revision: **1**'].join('\n');
  const answer = (itemLine: string): string => [prefix, itemLine].join('\n');

  assert.equal(hasProviderEvidence(answer(
    'Item: id unrelated-item — "Review the Clementine 4 release proof" — status **open**.',
  ), 1, 'open'), false, 'an unrelated item cannot supply status');
  assert.equal(hasProviderEvidence(answer(
    'Item: id proof-release-1 — "Review the Clementine 4 release proof" — prior status **open**.',
  ), 1, 'open'), false, 'historical status prose is not a current field');
  assert.equal(hasProviderEvidence(answer(
    'Item: id proof-release-1 — "Review the Clementine 4 release proof" — status **unknown** (was open).',
  ), 1, 'open'), false, 'a historical annotation cannot replace the current scalar');
  assert.equal(hasProviderEvidence(answer(
    'Item: id proof-release-1 — "Review the Clementine 4 release proof" — status **open**, current status unknown.',
  ), 1, 'open'), false, 'incidental non-terminal status cannot satisfy evidence');
  assert.equal(hasProviderEvidence(answer(
    'Item: id proof-release-1 with status **open**.',
  ), 1, 'open'), false, 'status still requires a dash-delimited terminal field');
});

test('provider evidence reads the current scalar before an explicit historical annotation', () => {
  const answer = [
    `- **Source marker:** ${SOURCE_MARKER}`,
    '- **Revision:** 2 (was 1)',
    '| Item ID | Title | Status |',
    '|---|---|---|',
    '| proof-release-1 | Review the Clementine 4 release proof | done (was open) |',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(answer, 1, 'open'), false, 'historical values cannot satisfy current evidence');
  assert.equal(hasProviderEvidence(answer.replace('done (was open)', 'done (but current is unknown)'), 2, 'done'), false);
});

test('provider evidence accepts an exact up-from comparison without treating history as current', () => {
  const answer = [
    `- **Source marker:** ${SOURCE_MARKER}`,
    '- **Revision:** 2 (up from 1)',
    '- **Item:** proof-release-1 — "Review the Clementine 4 release proof" — status: **done** (was open)',
  ].join('\n');

  assert.equal(hasProviderEvidence(answer, 2, 'done', 'correction'), true);
  assert.equal(hasProviderEvidence(answer, 1, 'done'), false, 'the comparison scalar cannot satisfy current evidence');
});

test('provider evidence rejects non-scalar or non-terminal up-from annotations', () => {
  const answer = [
    `- **Source marker:** ${SOURCE_MARKER}`,
    '- **Revision:** 2 (up from 1)',
    '- **Status:** done',
  ].join('\n');

  assert.equal(
    hasProviderEvidence(answer.replace('(up from 1)', '(up from revision 1)'), 2, 'done'),
    false,
  );
  assert.equal(
    hasProviderEvidence(answer.replace('(up from 1)', '(up from 1, current unverified)'), 2, 'done'),
    false,
  );
  assert.equal(
    hasProviderEvidence(answer.replace('2 (up from 1)', '2 (previously 1, current 9)'), 2, 'done'),
    false,
    'a scalar annotation cannot carry a second current claim',
  );
  assert.equal(
    hasProviderEvidence(answer.replace('2 (up from 1)', '1 (up from 2)'), 2, 'done'),
    false,
    'the historical comparison cannot replace the leading current scalar',
  );
  assert.equal(
    hasProviderEvidence([
      `- **Source marker:** ${SOURCE_MARKER}`,
      '- **Revision:** 1',
      '- **Item:** proof-release-1 — "Review the Clementine 4 release proof" — status: **open** (previously closed, current done)',
    ].join('\n'), 1, 'open'),
    false,
    'a strict Item scalar cannot hide a second current status in its annotation',
  );
});
