/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-preview-labels.test.ts
 *
 * Live 2026-09-25: an approval read "users UC0806VCJ"; the record Clem had
 * looked up named the person. Candidates come from the records that carry the
 * exact value; Jev picks (see host-turn-runner.test.ts for the wired pin).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { labelCandidatesFor } from './approval-preview-labels.js';

test('candidates are the strings of the records that carry the exact id, most repeated first, without URLs', () => {
  const directory = { data: { members: [{
    id: 'U0FIXTURE1', name: 'sam', real_name: 'Sam Rivera', tz: 'America/Los_Angeles',
    profile: { title: 'Recruiter', image: 'https://example.test/sam.png' },
  }, { id: 'U0OTHER', real_name: 'Someone Else' }] } };
  const messages = { messages: { matches: [
    { user: 'U0FIXTURE1', username: 'sam', text: 'see you at 4:15', permalink: 'https://example.test/p/1' },
    { user: 'U0FIXTURE1', username: 'sam', text: 'running late' },
  ] } };
  const candidates = labelCandidatesFor([directory, messages], 'U0FIXTURE1');
  assert.equal(candidates[0], 'sam', 'the name every record agrees on comes first');
  for (const expected of ['Sam Rivera', 'Recruiter', 'see you at 4:15']) assert.ok(candidates.includes(expected), expected);
  assert.ok(!candidates.includes('U0FIXTURE1'), 'the id is not its own name');
  assert.ok(!candidates.includes('Someone Else'), 'another record is not a candidate');
  assert.ok(!candidates.some((text) => text.includes('://')), 'a URL is never a name');
  assert.deepEqual(labelCandidatesFor([directory], 'U0NOWHERE'), []);
});
