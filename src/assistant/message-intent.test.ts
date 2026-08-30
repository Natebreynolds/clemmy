/**
 * Run: npx tsx --test src/assistant/message-intent.test.ts
 *
 * The classifier has no I/O — pure function. Tests assert the
 * heuristics route real-world messages to the right class so the
 * downstream context budget shrinks/grows appropriately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMessageIntent,
  hasDiscourseReferent,
  isCasualCheckIn,
  memoryBudgetFor,
  refersToUserOrHostedWorld,
} from './message-intent.js';

// ─── casual ────────────────────────────────────────────────────

test('casual: short greetings', () => {
  for (const msg of ['hi', 'hello', 'hey', 'yo', 'good morning', 'sup', 'howdy']) {
    assert.equal(classifyMessageIntent(msg).intent, 'casual', `"${msg}" should be casual`);
  }
});

test('casual: short acknowledgements', () => {
  for (const msg of ['thanks', 'thanks!', 'ok', 'cool', 'got it', 'sounds good', 'sweet', 'perfect']) {
    assert.equal(classifyMessageIntent(msg).intent, 'casual', `"${msg}" should be casual`);
  }
});

test('conversation: closed-world questions do not become lookups', () => {
  for (const msg of [
    "what's 2x2",
    'What’s 2x3',
    'what is 2+2',
    'What is 12 * 11?',
    'what is 5 times 7',
    'what is 15% of 80',
    'what is 2^8',
    'what is sqrt(144)',
    "what's 12 divided by 4 then times 3",
    'what is the capital of France',
  ]) {
    assert.equal(
      classifyMessageIntent(msg).intent,
      'conversation',
      `"${msg}" should stay closed-world`,
    );
  }
});

test('a hosted-world follow-up via they/those continues retrieve; 2x3 does not', () => {
  for (const msg of ['what are they slack IDs', 'what are their slack IDs', 'what are those']) {
    assert.equal(
      classifyMessageIntent(msg).intent,
      'conversation',
      `"${msg}" alone is still closed-world`,
    );
    assert.equal(hasDiscourseReferent(msg), true, `"${msg}" points at prior discourse`);
    assert.equal(
      classifyMessageIntent(msg, { continueHostedWorld: true }).intent,
      'lookup',
      `"${msg}" continues a hosted turn`,
    );
  }
  assert.equal(
    classifyMessageIntent("what's 2x3", { continueHostedWorld: true }).intent,
    'conversation',
    'a self-contained closed-world question stays a reply even after a retrieve',
  );
  assert.equal(classifyMessageIntent('thanks', { continueHostedWorld: true }).intent, 'casual');
});

test('lookup: a user or hosted-world referent still retrieves', () => {
  for (const msg of [
    "what's 2x2 for the team",
    'what is 2+2 in salesforce',
    'what is the weather in Seattle',
    'what is the net MRR we sold as a team this week',
    "who's on my sales team",
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'lookup', `"${msg}" should stay a lookup`);
    assert.equal(refersToUserOrHostedWorld(msg), true, `"${msg}" refers to user/hosted world`);
  }
});

test('lookup: current clock questions retrieve instead of becoming closed-world replies', () => {
  for (const msg of [
    'what time is it?',
    "what's the local time?",
    "what's today's date?",
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'lookup', `"${msg}" should stay a lookup`);
    assert.equal(
      refersToUserOrHostedWorld(msg),
      true,
      `"${msg}" points at the current runtime environment`,
    );
  }
});

test('action: acknowledgement plus an action is not swallowed as casual', () => {
  for (const msg of [
    'Okay, send it now.',
    'Sounds good, deploy it.',
    'Thanks, publish it now.',
    'Cool, update Airtable.',
    'Perfect, go ahead and send.',
    'Got it, delete those rows.',
    'Okay. Send it now.',
    'Thanks! Publish it now.',
    'Cool: update Airtable.',
    'Perfect — go ahead and send.',
    'Got it\nDelete those rows.',
    'ok send it',
    'okay deploy it',
    'sounds good publish it',
    'thanks delete those rows',
    'cool update Airtable',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'action', `"${msg}" should be action`);
  }
});

test('casual: backward-compatible isCasualCheckIn', () => {
  assert.equal(isCasualCheckIn('hi'), true);
  assert.equal(isCasualCheckIn('hey, how are you'), true);
  assert.equal(isCasualCheckIn('build me a workflow'), false);
});

test('casual: greeting-shaped but very long is NOT casual', () => {
  // "thanks for considering... [long]" is not just a thanks.
  const long = 'thanks for putting that together — I want to go deeper on the migration plan and tear apart the staging side';
  assert.notEqual(classifyMessageIntent(long).intent, 'casual');
});

test('casual: a greeting prefix does not hide a hosted-world calendar/email ask', () => {
  // Live 2026-08-28: "Hey what's on my calendar today" is 30 chars, matches
  // /^(hey)\b/, compiled casual, tools stripped, published as done with zero
  // crossings. A social opener is not a closed social turn.
  for (const msg of [
    "Hey what's on my calendar today",
    'Hey what’s on my calendar today',
    'Hi, what is on my calendar?',
    'Hello can you check my email',
    "hey show my calendar",
  ]) {
    const result = classifyMessageIntent(msg);
    assert.notEqual(result.intent, 'casual', `"${msg}" must not compile as a greeting`);
    assert.notEqual(result.intent, 'conversation', `"${msg}" names the user's world`);
  }
  for (const msg of ['hey', 'hi', 'hey!', "hey how's it going", 'hey, how are you']) {
    assert.equal(classifyMessageIntent(msg).intent, 'casual', `"${msg}" stays a greeting`);
  }
});

// ─── meta_clarify ──────────────────────────────────────────────

test('meta_clarify: questions about the agent itself', () => {
  for (const msg of [
    'what can you do',
    'what are your capabilities',
    'how do you work',
    'who are you',
    'help',
    'how does this work',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'meta_clarify', `"${msg}" should be meta_clarify`);
  }
});

// ─── lookup ────────────────────────────────────────────────────

test('lookup: question-shaped read-only requests', () => {
  for (const msg of [
    'what is the status of the deploy',
    'show me my open tasks',
    'list my goals',
    'find the note about Q3 planning',
    'when did we ship the auth refactor',
    'remind me what I said about Discord',
    'recall the spec for the new dashboard',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'lookup', `"${msg}" should be lookup`);
  }
});

test('lookup: advice, explanation, and reads do not arm the action harness', () => {
  for (const msg of [
    'Should I publish this?',
    'Can I publish this post?',
    'Tell me whether to publish.',
    'Explain how to deploy to Netlify.',
    'What happens if I deploy to Netlify?',
    'Help me decide whether to send the email.',
    'Read the email and summarize it.',
    'Search Gmail for the email from Alice.',
    'Review the draft.',
    'Summarize the post.',
    'Do you think I should publish?',
    'Is it safe to deploy?',
    'What do you recommend I send?',
    'Give me advice on whether to send.',
    'Walk me through how to deploy.',
    'Would you recommend publishing?',
    'What did we deploy yesterday?',
    'Could you tell me whether I should send this?',
    'Can you walk me through how to deploy?',
    'Would you help me decide whether to publish?',
    'Could you show me how to deploy?',
    'Please explain how to deploy.',
    'Please tell me whether to send it.',
    'Please give me advice on whether to publish.',
    'Can you help me decide if I should send this?',
    'Could you assess whether it is safe to publish?',
    'Could you tell me how to label Gmail messages?',
    'Should I book the Zoom meeting?',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'lookup', `"${msg}" should be lookup`);
  }
});

// ─── action ────────────────────────────────────────────────────

test('action: explicit build/deploy/ship verbs', () => {
  for (const msg of [
    'build me a dashboard for proposals',
    'deploy the staging branch',
    'set up the webhook',
    'wire up Discord OAuth',
    'finish the workflow refactor',
    "let's ship the proposal feature",
    'fix the cron parser',
    'push the branch to GitHub',
    'merge the pull request on GitHub',
    'log this in Airtable',
    'put this in Notion',
    'record the lead in Salesforce',
    'book a Zoom meeting',
    'label the Gmail message important',
    'tag the HubSpot contact as qualified',
    'mute the Slack channel',
    'unmute the Slack channel',
    'follow Alice on LinkedIn',
    'unfollow Alice on LinkedIn',
    'block this sender in Gmail',
    'bookmark this Slack message',
    'link the Jira issue',
    'unlink the Jira issue',
    'unsubscribe me from this mailing list',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'action', `"${msg}" should be action`);
  }
});

test('action: multi-part cues boost confidence', () => {
  const single = classifyMessageIntent('build the dashboard');
  const multi = classifyMessageIntent('build the dashboard and then deploy it to staging');
  assert.equal(single.intent, 'action');
  assert.equal(multi.intent, 'action');
  assert.ok(multi.confidence > single.confidence, 'multi-part message should be more confidently action');
});

test('action: a read or question can hand off to an explicit action clause', () => {
  for (const msg of [
    'Show me the contacts, then add Alice.',
    'Tell me the current status, then deploy it.',
    'How does this work, then deploy it.',
    'Inspect the report, then upload it.',
    'Read the sheet and append the approved row.',
    'Tell me whether I should publish. Publish it now.',
    'Do not send the email. Deploy the site now.',
    'Review the draft. Send it now.',
    'Could you tell me whether I should send this? Then send it now.',
    'Please explain how to deploy. Then deploy it.',
  ]) {
    assert.equal(classifyMessageIntent(msg).intent, 'action', `"${msg}" should be action`);
  }
});

test('action: continuation phrases', () => {
  assert.equal(classifyMessageIntent('keep going').intent, 'action');
  assert.equal(classifyMessageIntent('continue from where we left off').intent, 'action');
  assert.equal(classifyMessageIntent('pick this up').intent, 'action');
  assert.equal(
    classifyMessageIntent('hey can we get back to those 60 emails we were working on yesterday').intent,
    'action',
  );
});

test('action: research followed by a requested artifact is work-bearing', () => {
  assert.equal(
    classifyMessageIntent('Research the launch and produce a complete brief with risks and recommendations.').intent,
    'action',
  );
  assert.equal(classifyMessageIntent('Research whether this launch is viable.').intent, 'lookup');
});

// ─── default fallback ──────────────────────────────────────────

test('conversation: comments and prohibitions request no tool work', () => {
  assert.equal(classifyMessageIntent('hmm interesting').intent, 'conversation');
  assert.equal(classifyMessageIntent('ping').intent, 'conversation');
  assert.equal(classifyMessageIntent('No, do not send it.').intent, 'conversation');
  assert.equal(classifyMessageIntent('The plan is to deploy this later.').intent, 'conversation');
});

test('tool_intent: unclassified data-shaped asks keep the conservative fallback', () => {
  const result = classifyMessageIntent('Weather in Seattle');
  assert.equal(result.intent, 'tool_intent');
  assert.ok(result.confidence < 0.6, 'fallback should be low-confidence');
});

// ─── empty ─────────────────────────────────────────────────────

test('empty message returns casual', () => {
  assert.equal(classifyMessageIntent('').intent, 'casual');
  assert.equal(classifyMessageIntent('   ').intent, 'casual');
});

// ─── memory budget mapping ─────────────────────────────────────

test('memoryBudgetFor: casual suppresses everything', () => {
  const b = memoryBudgetFor('casual');
  assert.equal(b.loadWorkingMemory, false);
  assert.equal(b.loadSessionBrief, false);
  assert.equal(b.vaultSearchTopK, 0);
});

test('memoryBudgetFor: meta_clarify keeps session brief, drops vault', () => {
  const b = memoryBudgetFor('meta_clarify');
  assert.equal(b.loadSessionBrief, true);
  assert.equal(b.vaultSearchTopK, 0);
});

test('memoryBudgetFor: action loads full context', () => {
  const b = memoryBudgetFor('action');
  assert.equal(b.loadWorkingMemory, true);
  assert.equal(b.loadSessionBrief, true);
  assert.ok(b.vaultSearchTopK >= 4);
});

test('memoryBudgetFor: tool_intent loads moderate context', () => {
  const b = memoryBudgetFor('tool_intent');
  assert.equal(b.loadWorkingMemory, true);
  assert.ok(b.vaultSearchTopK > 0);
  assert.ok(b.vaultSearchTopK < memoryBudgetFor('action').vaultSearchTopK + 1);
});

test('memoryBudgetFor: conversation keeps continuity without a fresh vault search', () => {
  const b = memoryBudgetFor('conversation');
  assert.equal(b.loadWorkingMemory, true);
  assert.equal(b.loadSessionBrief, true);
  assert.equal(b.vaultSearchTopK, 0);
});

// ─── reasons ───────────────────────────────────────────────────

test('classifier returns human-readable reasons', () => {
  // A plain action states the verbs it saw.
  const plain = classifyMessageIntent('build the new dashboard');
  assert.ok(plain.reasons.length > 0);
  assert.ok(plain.reasons.some((reason) => /action verbs/.test(reason)));

  // The same request that also asks to DEPLOY reports the stronger, more
  // specific ground: deploying is an external effect, not merely an action
  // verb. Both remain human-readable; the effect reason simply outranks it.
  const deployed = classifyMessageIntent('build the new dashboard, then deploy it');
  assert.equal(deployed.intent, 'action');
  assert.ok(deployed.reasons.length > 0);
  assert.ok(deployed.reasons.some((reason) => /external effect: publication/.test(reason)));
  assert.ok(deployed.confidence >= plain.confidence);
});
