import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Inbox never publishes an unknown zero or claims caught-up from a partial snapshot', () => {
  const source = read('../screens/Inbox.tsx');
  assert.match(source, /if \(data\?\.needsCountKnown\) onCount\(confirmedNeedsCount\)/);
  assert.doesNotMatch(source, /onCount\(0\)/);
  assert.match(source, /data\?\.needsCountKnown && needsCount === 0/);
  assert.match(source, /mergeInboxLastGood/);
});

test('the shell badge is published from daemon-confirmed rows, the tab count from the screen', () => {
  const source = read('../screens/Inbox.tsx');
  // The shell keeps this as its last authoritative summary and paints it on
  // the app icon. An optimistic dismissal is a local, unconfirmed fact, so it
  // reaches the ROWS (which the user can see change, and which come back if
  // the daemon refuses) but never the icon.
  assert.match(source, /confirmedNotificationNeeds = useMemo\(/);
  assert.match(source, /\(data\?\.notifications \?\? \[\]\)\.filter\(stillNeedsUser\)/);
  assert.match(source, /onCount\(confirmedNeedsCount\)/);
  // The on-screen tab count still counts the on-screen rows, so a badge can
  // never exceed the rows its own screen is showing.
  assert.match(source, /notifications\.filter\(stillNeedsUser\)/);
  assert.match(source, /Needs you \{needsCount > 0/);
});

test('"End this run" is offered only for a run the daemon says is still going', () => {
  const source = read('../screens/Inbox.tsx');
  const runs = read('./running-tasks.ts');
  // No status crosses the mobile notification boundary, so the row's runId is
  // a fact from the day the notification was written. Measured on the owner's
  // store: 54 unread rows carry one, and 48 name runs the cancel route already
  // calls terminal — 48 offers whose only answer was 409 ALREADY_FINISHED.
  assert.match(source, /row\.context\.runId && row\.context\.workflow && stoppableRunIds\?\.has\(row\.context\.runId\)/);
  // Liveness comes from the daemon's own Working Now projection, narrowed by
  // the same run-control decision every other surface on the phone uses.
  assert.match(source, /loadInboxPart\(listWorkingNow\(\)\)/);
  assert.match(source, /stoppableWorkflowRunIds\(workingNow\.value\.entries\)/);
  assert.match(runs, /export function stoppableWorkflowRunIds/);
  assert.match(runs, /mobileRunControl\(entry\)/);
  // Never known yet = no button. An unknown liveness must not be rendered as
  // a live one; hiding the control asserts nothing.
  assert.match(source, /stoppableRunIds: string\[\] \| null/);
  assert.match(source, /data\?\.stoppableRunIds \? new Set\(data\.stoppableRunIds\) : null/);
});

test('question decisions are one-shot, answerability-gated, and receipt the exact answer', () => {
  const source = read('../screens/Inbox.tsx');
  assert.match(source, /if \(!question\.answerable \|\| !text \|\| actionLock\.current\) return/);
  assert.match(source, /actionLock\.current = true/);
  assert.match(source, /disabled=\{busy \|\| !question\.answerable\}/);
  assert.match(source, /title: 'Answer sent', text: `“\$\{text\}”`/);
  assert.match(source, /title: 'Already handled'/);
  assert.match(source, /Your answer was not sent again/);
});

test('plan clarification opens only its exact serialized conversation', () => {
  const cards = read('../components/Approvals.tsx');
  const api = read('./api.ts');
  assert.match(api, /sessionId: string \| null/);
  assert.match(cards, /needsInput && onReply && row\.sessionId/);
  assert.match(cards, /onReply\(row\.sessionId!?, `About the plan/);
  assert.doesNotMatch(cards, /onReply\('', `About the plan/);
  assert.match(cards, /This plan has no safe linked conversation on the phone yet/);
});

test('approve, reject, and conflict receipts stay action-specific without overclaiming', () => {
  const cards = read('../components/Approvals.tsx');
  assert.match(cards, /Plan approved and queued\. Clem will continue it in the original conversation\./);
  assert.match(cards, /Plan rejected\. Clem will not start it\./);
  assert.match(cards, /Rejected\. Clem will not perform that action\./);
  assert.match(cards, /The approval could not be applied from this card\. I refreshed its current status\./);
  assert.match(cards, /The rejection could not be applied from this card\. I refreshed its current status\./);
  assert.match(cards, /if \(actionLock\.current\) return/);
});

test('workflow capability cards expose exact choices and truthful recovery actions', () => {
  const source = read('../screens/Inbox.tsx');
  const api = read('./api.ts');
  assert.match(source, /WorkflowCapabilityCard/);
  assert.match(source, /account \{candidate\.accountId\}/);
  assert.match(source, /capability \{candidate\.capabilityId\}/);
  assert.match(source, /if \(actionLock\.current \|\| gate\.resolution\.kind === 'review_run'\) return/);
  assert.match(source, /I connected it on my Mac — resume/);
  assert.match(source, /Retry exact metadata now/);
  assert.match(source, /Review preserved run/);
  assert.match(api, /choiceSetDigest: gate\.resolution\.choiceSetDigest/);
});
