import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySelfServeBounce,
  clearSelfServeBouncesForTest,
  maybeSelfServeBounce,
} from './self-serve-gate.js';

beforeEach(() => clearSelfServeBouncesForTest());

const LIVE_QUESTION = 'The saved Salesforce report is no longer available in your org. Can you send the current report link or ID so I can pull the 30 accounts and build the drafts?';

test('the live incident shape bounces: pointer ask + connected toolkit that can derive it', () => {
  const d = classifySelfServeBounce(LIVE_QUESTION, ['salesforce', 'slack']);
  assert.equal(d.bounce, true);
  assert.equal(d.toolkit, 'salesforce');
  assert.match(d.steer ?? '', /SELF-SERVE|direct query/i);
  assert.match(d.steer ?? '', /ask the user again.*WILL go through/i);
});

test('non-pointer questions never bounce — judgment/preference asks reach the user', () => {
  assert.equal(classifySelfServeBounce('Should I prioritize the Chicago accounts or the Dallas ones first?', ['salesforce']).bounce, false);
  assert.equal(classifySelfServeBounce('The draft mentions pricing — is $4,500/mo still the right number to quote?', ['salesforce', 'outlook']).bounce, false);
  assert.equal(classifySelfServeBounce('Two contacts share the CEO title on this account — which one should receive the email?', ['salesforce']).bounce, false);
});

test('pointer asks with NO covering toolkit reach the user — nothing to self-serve with', () => {
  assert.equal(classifySelfServeBounce(LIVE_QUESTION, ['slack']).bounce, false, 'slack cannot derive a salesforce report');
  assert.equal(classifySelfServeBounce('Can you send the link to the design mockup?', ['salesforce']).bounce, false);
  assert.equal(classifySelfServeBounce(LIVE_QUESTION, []).bounce, false, 'no toolkits at all');
});

test('one bounce per session, then the ask always goes through', () => {
  const first = maybeSelfServeBounce({ sessionId: 's1', question: LIVE_QUESTION, connectedToolkitSlugs: ['salesforce'] });
  assert.equal(first.bounce, true);
  const second = maybeSelfServeBounce({ sessionId: 's1', question: LIVE_QUESTION, connectedToolkitSlugs: ['salesforce'] });
  assert.equal(second.bounce, false, 'the re-ask reaches the user even if unchanged');
  const otherSession = maybeSelfServeBounce({ sessionId: 's2', question: LIVE_QUESTION, connectedToolkitSlugs: ['salesforce'] });
  assert.equal(otherSession.bounce, true, 'one-shot is per session, not global');
});

test('kill-switch and missing session fail open', () => {
  process.env.CLEMMY_SELF_SERVE_BOUNCE = 'off';
  try {
    assert.equal(maybeSelfServeBounce({ sessionId: 's3', question: LIVE_QUESTION, connectedToolkitSlugs: ['salesforce'] }).bounce, false);
  } finally {
    delete process.env.CLEMMY_SELF_SERVE_BOUNCE;
  }
  assert.equal(maybeSelfServeBounce({ sessionId: undefined, question: LIVE_QUESTION, connectedToolkitSlugs: ['salesforce'] }).bounce, false, 'no session key = no one-shot guarantee = never bounce');
});

test('domain aliases widen matching for connected toolkits only', () => {
  assert.equal(classifySelfServeBounce('Can you share the spreadsheet with the Q3 pipeline rows?', ['googlesheets']).bounce, true);
  assert.equal(classifySelfServeBounce('Please send the export of open deals from the CRM', ['hubspot']).bounce, true);
  assert.equal(classifySelfServeBounce('Can you give me the id of the Airtable base for invoices?', ['airtable']).bounce, true);
});

test('the SECOND live shape bounces: identify-the-schema-pointer ("which field or report view…")', () => {
  const d = classifySelfServeBounce('Which Salesforce field or report view marks an account as a Market Leader?', ['salesforce']);
  assert.equal(d.bounce, true);
  assert.equal(d.toolkit, 'salesforce');
  // Judgment "which" questions still reach the user — no schema-pointer noun.
  assert.equal(classifySelfServeBounce('Which of the two drafts reads better for a first touch?', ['salesforce']).bounce, false);
  assert.equal(classifySelfServeBounce('Which contact should I address the email to, the CEO or the founder?', ['salesforce']).bounce, false);
});

test('the mailbox-guess shape bounces: "which mailbox should I check" is self-servable', () => {
  const d = classifySelfServeBounce('Which mailbox should I check for the 30 drafts: Scorpion or Breakthrough Coaching?', ['outlook']);
  assert.equal(d.bounce, true);
  assert.equal(d.toolkit, 'outlook');
});
