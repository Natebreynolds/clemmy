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
  isCasualCheckIn,
  memoryBudgetFor,
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

test('action: continuation phrases', () => {
  assert.equal(classifyMessageIntent('keep going').intent, 'action');
  assert.equal(classifyMessageIntent('continue from where we left off').intent, 'action');
  assert.equal(classifyMessageIntent('pick this up').intent, 'action');
});

// ─── default fallback ──────────────────────────────────────────

test('tool_intent: messages with no clear class', () => {
  const result = classifyMessageIntent('hmm interesting');
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

// ─── reasons ───────────────────────────────────────────────────

test('classifier returns human-readable reasons', () => {
  const r = classifyMessageIntent('build and deploy the new dashboard');
  assert.ok(r.reasons.length > 0);
  assert.ok(r.reasons.some((reason) => /action verbs/.test(reason)));
});
