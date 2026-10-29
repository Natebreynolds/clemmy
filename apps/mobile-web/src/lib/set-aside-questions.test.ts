import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuestionPresentationItem } from './api';
import { inboxNotificationIsCurrent, inboxViewFromSearch, matchesSetAsideQuestion, navigateInboxView, setAsideReturnLabel, setAsideViewFromSearch } from './set-aside-questions';

const row = { id: 'q', action: 'defer', question: 'Which quarter?', context: 'Annual forecast', agentLabel: 'Analyst', projectName: 'Planning', until: '2026-10-30T18:00:00Z' } as QuestionPresentationItem;
test('recovery views preserve Inbox ownership and an exact review outranks a stale filter', () => {
  assert.equal(inboxViewFromSearch('?tab=inbox&inbox=set-aside&view=later'), 'set-aside');
  assert.equal(setAsideViewFromSearch('?tab=inbox&inbox=set-aside&view=later'), 'later');
  assert.equal(inboxViewFromSearch('?tab=projects&inbox=set-aside'), 'needs');
  assert.equal(inboxViewFromSearch('?tab=inbox&inbox=set-aside&item=plan:exact'), 'needs');
  assert.equal(setAsideViewFromSearch('?tab=inbox&inbox=updates&view=dismissed'), 'all');
  assert.equal(setAsideViewFromSearch('?tab=inbox&inbox=set-aside&view=unknown'), 'all');
});
test('Later and Dismissed use typed receipts, with search across the actual question and its context', () => {
  assert.equal(matchesSetAsideQuestion(row, 'later', 'Analyst forecast'), true);
  assert.equal(matchesSetAsideQuestion(row, 'dismissed', ''), false);
  assert.equal(matchesSetAsideQuestion({ ...row, action: 'dismiss' }, 'dismissed', 'Planning'), true);
  assert.equal(matchesSetAsideQuestion(row, 'all', 'missing'), false);
  assert.equal(setAsideReturnLabel({ action: 'dismiss', until: row.until }), 'Dismissed');
  assert.equal(setAsideReturnLabel({ action: 'defer', until: 'invalid' }), 'Set aside for later');
  assert.match(setAsideReturnLabel(row), /^Returns /);
});

test('a quick local Inbox view change clears the shell notification, while Back readdresses the exact notification', () => {
  const events = new EventTarget();
  let current = new URL('http://framework.invalid/m/?tab=inbox&notification=notification-exact');
  const stack = [current.href];
  const host = {
    get location() { return current; },
    history: { state: null, pushState(_state: unknown, _title: string, path?: string | URL | null) { current = new URL(String(path), current); stack.push(current.href); } },
    dispatchEvent(event: Event) { return events.dispatchEvent(event); },
  };
  let parentNotification: string | null = 'notification-exact';
  let selectedView = inboxViewFromSearch(current.search);
  let synchronized = 0;
  events.addEventListener('popstate', () => {
    synchronized++;
    parentNotification = current.searchParams.get('notification');
    selectedView = inboxViewFromSearch(current.search);
  });
  navigateInboxView('set-aside', host);
  assert.equal(parentNotification, null, 'the parent no longer fetches or presents the old notification');
  assert.equal(selectedView, 'set-aside');
  assert.equal(inboxNotificationIsCurrent(current.search, 'notification-exact'), false, 'a pending old presentation cannot steal the new view');
  assert.equal(synchronized, 1);

  current = new URL(stack[stack.length - 2]!);
  events.dispatchEvent(new Event('popstate'));
  assert.equal(parentNotification, 'notification-exact');
  assert.equal(inboxNotificationIsCurrent(current.search, 'notification-exact'), true);
  assert.equal(selectedView, 'needs', 'the exact notification can now select its typed review or update from the restored URL');
  assert.equal(synchronized, 2);
});

test('switching Inbox views drops exact review and recovery filter selections', () => {
  const events = new EventTarget();
  let current = new URL('http://framework.invalid/m/?tab=inbox&item=plan:exact&view=later&inbox=set-aside');
  const state = { clemBackId: 42 };
  let notifiedState: unknown;
  events.addEventListener('popstate', event => { notifiedState = (event as PopStateEvent).state; });
  const host = { get location() { return current; }, history: { state, pushState(_state: unknown, _title: string, path?: string | URL | null) { current = new URL(String(path), current); } }, dispatchEvent: (event: Event) => events.dispatchEvent(event) };
  navigateInboxView('needs', host);
  assert.equal(current.search, '?tab=inbox');
  assert.equal(notifiedState, state, 'synthetic synchronization preserves the current native Back owner');
});
