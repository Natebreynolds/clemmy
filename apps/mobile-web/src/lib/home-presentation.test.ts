import assert from 'node:assert/strict';
import test from 'node:test';
import { homeCanSayAllClear, homeStatusLine } from './home-presentation';

test('a zero Inbox summary cannot hide blocked, stale, awaiting, or paused current work', () => {
  for (const lifecycle of ['blocked', 'stale', 'awaiting_input', 'awaiting_approval', 'paused_budget']) {
    const status = homeStatusLine({
      decisionCount: 0,
      decisionCountKnown: true,
      currentTaskCountKnown: true,
      running: 0,
      currentNeedsAttention: 1,
      loading: false,
    });
    assert.equal(status, '1 current task needs attention', lifecycle);
    assert.equal(homeCanSayAllClear({
      loading: false,
      needsYouCount: 0,
      needsYouCountKnown: true,
      currentTaskCount: 1,
      currentTaskCountKnown: true,
      reminderCount: 0,
      recentChatCount: 0,
    }), false, lifecycle);
  }
});

test('all clear requires every visible home source to be authoritatively empty', () => {
  assert.equal(homeCanSayAllClear({
    loading: false,
    needsYouCount: 0,
    needsYouCountKnown: true,
    currentTaskCount: 0,
    currentTaskCountKnown: true,
    reminderCount: 0,
    recentChatCount: 0,
  }), true);
  assert.equal(homeCanSayAllClear({
    loading: true,
    needsYouCount: 0,
    needsYouCountKnown: true,
    currentTaskCount: 0,
    currentTaskCountKnown: true,
    reminderCount: 0,
    recentChatCount: 0,
  }), false);
});

test('status combines projected attention with genuinely running work', () => {
  assert.equal(homeStatusLine({
    decisionCount: 0,
    decisionCountKnown: true,
    currentTaskCountKnown: true,
    running: 2,
    currentNeedsAttention: 1,
    loading: false,
  }), '1 current task needs attention · 2 running');
});

test('Home cannot claim quiet or all-clear before the first authoritative Inbox count', () => {
  assert.equal(homeStatusLine({
    decisionCount: 0,
    decisionCountKnown: false,
    currentTaskCountKnown: false,
    running: 0,
    currentNeedsAttention: 0,
    loading: false,
  }), 'Checking what needs you…');
  assert.equal(homeCanSayAllClear({
    loading: false,
    needsYouCount: 0,
    needsYouCountKnown: false,
    currentTaskCount: 0,
    currentTaskCountKnown: false,
    reminderCount: 0,
    recentChatCount: 0,
  }), false);
});

test('Home cannot claim quiet when the Working Now source has never succeeded', () => {
  assert.equal(homeStatusLine({
    decisionCount: 0,
    decisionCountKnown: true,
    currentTaskCountKnown: false,
    running: 0,
    currentNeedsAttention: 0,
    loading: false,
  }), 'Checking current work…');
  assert.equal(homeCanSayAllClear({
    loading: false,
    needsYouCount: 0,
    needsYouCountKnown: true,
    currentTaskCount: 0,
    currentTaskCountKnown: false,
    reminderCount: 0,
    recentChatCount: 0,
  }), false);
});
