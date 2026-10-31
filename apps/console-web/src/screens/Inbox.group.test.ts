/**
 * A review group in the Inbox reads as the prepared actions it covers, and
 * its one approve button says how many: never the group's own envelope
 * fields (version, member ids) as the details.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./Inbox.tsx', import.meta.url), 'utf8');

test('a review group shows its prepared actions and approves them together', () => {
  assert.match(SOURCE, /import \{ ApprovalReview \} from '@\/components\/chat\/ApprovalReview';/);
  assert.match(SOURCE, /const grouped = row\.preview\?\.items && row\.preview\.items\.length > 1 \? row\.preview : null;/);
  assert.match(SOURCE, /const details = grouped \? \[\] : row\.presentation\?\.details \?\? \[\];/, 'no envelope fields for a group');
  assert.match(SOURCE, /\{grouped \? <ApprovalReview preview=\{grouped\} \/> :/);
  assert.match(SOURCE, /grouped \? `Approve all \$\{grouped\.items!\.length\}`/);
});
