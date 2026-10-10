import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectOverview, ProjectSummary } from '@clem/chat-engine';
import type { Session } from '../features/conversations/types';
import type { SpaceRecord } from './spaces';
import { projectWorkItems, searchWorkItems, workItems, workKindForPath, workPath, type WorkItem } from './work-navigation';

test('work opens its exact route, including names with separators and unified conversation ids', () => {
  assert.equal(workPath('workflow', 'Weekly / briefing?'), '/automate/Weekly%20%2F%20briefing%3F');
  assert.equal(workPath('project', 'same'), '/projects/same');
  assert.equal(workPath('space', 'same'), '/workspaces/same');
  assert.equal(workPath('agent', 'same'), '/agents/same');
  assert.equal(workPath('chat', 'sess-42'), '/chat/harness%3Asess-42');
  assert.equal(workPath('chat', 'harness:sess-42'), '/chat/harness%3Asess-42');
  assert.equal(workPath('chat', 'desktop:42'), '/chat/desktop%3A42');
  assert.equal(workKindForPath('/projects'), 'project');
  assert.equal(workKindForPath('/connect'), null);
  assert.equal(workKindForPath('/projects/a'), null, 'only collection destinations receive expand controls');
});

test('same-named work retains its distinct identity; archived and empty desktop shells are omitted', () => {
  const project = { id: 'same', name: 'Sample', purpose: 'A fixture', updatedAt: '2026-10-10', status: 'active' } as ProjectSummary;
  const space = { id: 'same', title: 'Sample', status: 'active', updatedAt: '2026-10-09' } as SpaceRecord;
  const chat = { id: 'desktop:1', title: 'Sample', store: 'desktop', turnCount: 1, archived: false, updatedAt: '2026-10-08' } as Session;
  const result = workItems({ projects: [project, { ...project, id: 'archived', status: 'archived' }], spaces: [space, { ...space, id: 'archived', status: 'archived' }], chats: [chat, { ...chat, id: 'desktop:empty', turnCount: 0 }, { ...chat, id: 'desktop:old', archived: true }] });
  assert.deepEqual(result.map(item => item.key), ['project:same', 'space:same', 'chat:desktop:1']);
  assert.equal(new Set(result.map(item => item.path)).size, 3);
});

test('search ranks the actual name before descriptive mentions and matches every word', () => {
  const items: WorkItem[] = [
    { key: 'space:2', kind: 'space', title: 'Overview', detail: 'Quarterly plan', path: '/workspaces/2', updatedAt: '2026-10-09' },
    { key: 'project:1', kind: 'project', title: 'Quarterly plan', path: '/projects/1', updatedAt: '2026-09-01' },
    { key: 'workflow:3', kind: 'workflow', title: 'Quarterly report', path: '/automate/report' },
  ];
  const before = structuredClone(items);
  assert.deepEqual(searchWorkItems(items, 'quarterly plan').map(item => item.key), ['project:1', 'space:2']);
  assert.deepEqual(searchWorkItems(items, 'quarterly workflow').map(item => item.key), ['workflow:3']);
  assert.equal(searchWorkItems(items, 'unknown').length, 0);
  assert.deepEqual(items, before, 'ranking never reorders the cached source records');
});

test('recent work keeps pinned chats first, then actual timestamps, with bounded and unique results', () => {
  const items: WorkItem[] = [
    { key: 'chat:new', kind: 'chat', title: 'Newest', path: '/chat/new', updatedAt: '2026-10-09' },
    { key: 'chat:pin', kind: 'chat', title: 'Pinned', path: '/chat/pin', pinned: true, updatedAt: '2026-01-01' },
    { key: 'chat:unknown', kind: 'chat', title: 'Unknown date', path: '/chat/unknown', updatedAt: 'unavailable' },
  ];
  assert.deepEqual(searchWorkItems([...items, items[0]], '', 2).map(item => item.key), ['chat:pin', 'chat:new']);
  assert.deepEqual(searchWorkItems(items, '', 0), []);
});

test('a project exposes only its current conversations, linked work and available assigned agents', () => {
  const overview = {
    conversations: [
      { sessionId: 'sess-current', title: 'Current', current: true, updatedAt: '2026-10-09', agentName: 'Helper' },
      { sessionId: 'sess-moved', title: 'Moved elsewhere', current: false, updatedAt: '2026-10-09' },
    ],
    resources: [
      { kind: 'space', ref: 'space-id', label: 'Saved Space', updatedAt: '2026-10-08' },
      { kind: 'space', ref: 'space-id', label: 'Duplicate reference' },
      { kind: 'workflow', ref: 'routine/name', label: 'A routine' },
      { kind: 'workflow', ref: null, label: 'Missing reference' },
      { kind: 'account', ref: 'account-id', label: 'Private account' },
    ],
    agents: [
      { agentId: 'helper', agentName: 'Helper', available: true, responsibility: 'Research' },
      { agentId: 'deleted', agentName: 'Deleted', available: false },
    ],
  } as ProjectOverview;
  const before = structuredClone(overview);
  const items = projectWorkItems(overview);
  assert.deepEqual(new Set(items.map(item => item.key)), new Set(['chat:sess-current', 'space:space-id', 'workflow:routine/name', 'agent:helper']));
  assert.equal(items.find(item => item.kind === 'workflow')?.path, '/automate/routine%2Fname');
  assert.equal(items.find(item => item.kind === 'chat')?.path, '/chat/harness%3Asess-current');
  assert.deepEqual(overview, before, 'opening project work cannot mutate its membership or context');
});
