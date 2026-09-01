import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChatMessage } from '@clem/chat-engine';
import {
  delegatedRunControlForExpandedWork,
  delegatedRunControlForMessage,
} from './RunControl.js';

test('delegated chat Stop targets only the exact durable workflow run ids', () => {
  const message: ChatMessage = {
    id: 'a-delegated-41-44',
    role: 'assistant',
    text: 'The workflows are running.',
    status: 'thinking',
    delegatedWork: {
      sourceUserSeq: 41,
      runIds: ['run-exact-a', 'run-exact-a', 'run-exact-b'],
      state: 'running',
    },
  };

  assert.deepEqual(delegatedRunControlForMessage(message), {
    sourceUserSeq: 41,
    state: 'running',
    target: { kind: 'workflow-runs', runIds: ['run-exact-a', 'run-exact-b'] },
  });
});

test('ordinary thinking and terminal assistant messages never receive workflow Stop', () => {
  assert.equal(delegatedRunControlForMessage({
    id: 'ordinary-thinking',
    role: 'assistant',
    text: '',
    status: 'thinking',
  }), null);

  assert.equal(delegatedRunControlForMessage({
    id: 'stale-terminal',
    role: 'assistant',
    text: 'Done.',
    status: 'complete',
    delegatedWork: {
      sourceUserSeq: 41,
      runIds: ['run-exact-a'],
      state: 'running',
    },
  }), null, 'even stale metadata cannot put Stop on a terminal card');
});

test('a durably accepted stop becomes status-only, never a second Stop action', () => {
  assert.deepEqual(delegatedRunControlForMessage({
    id: 'a-delegated-41-44',
    role: 'assistant',
    text: 'The workflow is running.',
    status: 'stopped',
    delegatedWork: {
      sourceUserSeq: 41,
      runIds: ['run-exact-a'],
      state: 'stopped',
    },
  }), {
    sourceUserSeq: 41,
    state: 'stopped',
    target: null,
  });
});

test('delegated Stop is unavailable while work detail is collapsed and exact when expanded', () => {
  const message: ChatMessage = {
    id: 'a-delegated-expanded-only',
    role: 'assistant',
    text: 'The workflows are running.',
    status: 'thinking',
    delegatedWork: {
      sourceUserSeq: 73,
      runIds: ['run-exact-expanded-a', 'run-exact-expanded-b'],
      state: 'running',
    },
  };

  assert.equal(delegatedRunControlForExpandedWork(message, false), null);
  assert.deepEqual(delegatedRunControlForExpandedWork(message, true), {
    sourceUserSeq: 73,
    state: 'running',
    target: {
      kind: 'workflow-runs',
      runIds: ['run-exact-expanded-a', 'run-exact-expanded-b'],
    },
  });
});

test('expanded work preserves cancelling and stopped status without exposing another action', () => {
  const cancelling: ChatMessage = {
    id: 'a-delegated-cancelling',
    role: 'assistant',
    text: 'The workflow is stopping.',
    status: 'thinking',
    delegatedWork: {
      sourceUserSeq: 74,
      runIds: ['run-exact-cancelling'],
      state: 'cancelling',
    },
  };
  const stopped: ChatMessage = {
    ...cancelling,
    status: 'stopped',
    delegatedWork: { ...cancelling.delegatedWork!, state: 'stopped' },
  };

  assert.equal(delegatedRunControlForExpandedWork(cancelling, false), null);
  assert.equal(delegatedRunControlForExpandedWork(stopped, false), null);
  assert.deepEqual(delegatedRunControlForExpandedWork(cancelling, true), {
    sourceUserSeq: 74,
    state: 'cancelling',
    target: { kind: 'workflow-runs', runIds: ['run-exact-cancelling'] },
  });
  assert.deepEqual(delegatedRunControlForExpandedWork(stopped, true), {
    sourceUserSeq: 74,
    state: 'stopped',
    target: null,
  });
});

test('expanded work uses one accessible compact circular Stop trigger', () => {
  const chatSource = readFileSync(new URL('../screens/Chat.tsx', import.meta.url), 'utf8');
  const controlSource = readFileSync(new URL('./RunControl.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(chatSource, /delegatedRunControlForExpandedWork\(message, open\)/);
  assert.doesNotMatch(chatSource, /class="delegated-work-control"/);
  assert.match(controlSource, /class="run-stop-trigger"/);
  assert.match(controlSource, /aria-label=\{stopping \? 'Stopping delegated work' : 'Stop delegated work'\}/);
  assert.match(css, /\.run-stop-trigger\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*border-radius:\s*50%;/s);
});
