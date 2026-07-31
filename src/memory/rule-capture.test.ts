/**
 * Run: npx tsx --test src/memory/rule-capture.test.ts
 *
 * Pins the standing-rule capture steer (live 2026-07-31: "we ONLY access
 * Salesforce via the CLI" never became a constraint while its opposite got
 * remembered from an episode). Conservative by design: rule-shaped statements
 * fire; questions, conditionals, and counting prose never do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standingRuleCaptureDirective } from './rule-capture.js';

test('rule-shaped statements fire — including the owner\'s exact live sentence, typos and all', () => {
  const fires = [
    // The live sentence that should have become a constraint months ago.
    'i just told you that i dont use composio for salesforce i have always use the salesfroce CLI',
    'we ONLY access Salesforce via the sf CLI, never through Composio',
    'never post to the prod channel',
    'always send outreach from billing@example.com',
    'from now on, route every deploy through staging first',
    'as a rule, use the gh CLI for anything GitHub',
  ];
  for (const text of fires) {
    const d = standingRuleCaptureDirective(text);
    assert.ok(d, `must fire: ${text.slice(0, 60)}`);
    assert.match(d!, /remember\(kind='constraint'/, 'the steer teaches the exact vehicle');
    assert.match(d!, /CONTRADICTS this rule, forget or supersede/i, 'contradiction cleanup rides the same beat');
    assert.match(d!, /ignore this signal/i, 'model-owned decision — never a hard rule');
  }
});

test('ordinary prose with rule words never fires — questions, conditionals, counts, casual talk', () => {
  const silent = [
    'how do I always keep the sidebar open?',
    'should we only use the CLI for salesforce?',
    'only 3 of the accounts have emails',
    'send it only if the draft is approved',
    'never mind, use whatever works',
    'can you post the update to slack',
    'ok',
    'that report was great, always love the detail',  // "always" + no operational rule verb pairing…
  ];
  for (const text of silent) {
    const d = standingRuleCaptureDirective(text);
    if (text.includes('always love')) {
      // "love" is not an operational verb — must stay silent.
      assert.equal(d, null, `must stay silent: ${text}`);
    } else {
      assert.equal(d, null, `must stay silent: ${text}`);
    }
  }
});
