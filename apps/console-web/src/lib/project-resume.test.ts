import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectOverview } from '@clem/chat-engine';
import type { DeliveredArtifact, DeliveredGroup } from './delivered';
import { projectConversationIds, projectResumeConversation, projectResumeResults, projectResumeSpaces } from './project-resume';

const conversations = [
  { sessionId: 'chat-current', title: 'Current', current: true, updatedAt: '2026-10-09' },
  { sessionId: 'chat-moved', title: 'Moved elsewhere', current: false, updatedAt: '2026-10-10' },
  { sessionId: 'chat-older', title: 'Older', current: true, updatedAt: '2026-10-08' },
] as ProjectOverview['conversations'];
const overview = { conversations, pages: [] } as Pick<ProjectOverview, 'conversations' | 'pages'>;
const artifact = (overrides: Partial<DeliveredArtifact> = {}): DeliveredArtifact => ({
  kind: 'file', title: 'Summary.pdf', target: '/private/Summary.pdf', createdAt: '2026-10-09', openable: true,
  fileRef: { sessionId: 'worker-1', fileId: 'sf_same', name: 'Summary.pdf', folder: 'Saved files' }, ...overrides,
});
const group = (overrides: Partial<DeliveredGroup> = {}): DeliveredGroup => ({
  id: 1, createdAt: '2026-10-09', title: 'Summary', why: '', lane: null, sessionId: 'worker-1',
  artifactCount: 1, rerunnable: false, artifacts: [artifact()], ...overrides,
});

test('resume uses current membership while result queries retain explicit historical associations', () => {
  const before = structuredClone(conversations);
  assert.equal(projectResumeConversation(overview)?.sessionId, 'chat-current');
  assert.equal(projectResumeConversation({ conversations: conversations.filter(row => !row.current) }), null);
  assert.deepEqual(projectConversationIds({ conversations: [...conversations, conversations[0]] }), ['chat-current', 'chat-moved', 'chat-older']);
  assert.deepEqual(conversations, before);
});

test('Spaces require an explicit relationship and duplicate references collapse', () => {
  const resources = [
    { kind: 'space', ref: 'space-a', label: 'Linked Space' },
    { kind: 'space', ref: 'space-a', label: 'Duplicate' },
    { kind: 'folder', ref: 'space-b', label: 'Not a Space relationship' },
    { kind: 'space', ref: null, label: 'No identity' },
  ] as ProjectOverview['resources'];
  assert.deepEqual(projectResumeSpaces({ resources }), [{ id: 'space-a', title: 'Linked Space' }]);
});

test('worker results preserve their authenticated producer while source links use proven conversation ancestry', () => {
  const [row] = projectResumeResults(overview, [group({ conversationSessionId: 'chat-current' })]);
  assert.equal(row.kind, 'file');
  if (row.kind !== 'file') throw new Error('Expected file');
  assert.equal(row.fileRef.sessionId, 'worker-1');
  assert.equal(row.conversationSessionId, 'chat-current');
  assert.equal(projectResumeResults(overview, [group({ conversationSessionId: 'chat-current', artifacts: [artifact({ conversationSessionId: null })] })])[0].conversationSessionId, undefined);
});

test('unknown origins never become invented chat links; old records only fall back to actual membership', () => {
  assert.equal(projectResumeResults(overview, [group()])[0].conversationSessionId, undefined);
  assert.equal(projectResumeResults(overview, [group({ sessionId: 'chat-current' })])[0].conversationSessionId, 'chat-current');
  assert.equal(projectResumeResults(overview, [group({ sessionId: 'chat-current', conversationSessionId: null })])[0].conversationSessionId, undefined);
});

test('a path alone cannot open locally and duplicate current files are not presented as versions', () => {
  const results = projectResumeResults(overview, [
    group({ id: 1, artifacts: [artifact({ fileRef: undefined })] }),
    group({ id: 2, createdAt: '2026-10-08', artifacts: [artifact({ fileRef: { sessionId: 'other-worker', fileId: 'sf_same', name: 'Summary.pdf', folder: 'Saved files' } })] }),
    group({ id: 3, createdAt: '2026-10-10', artifacts: [artifact({ title: 'Latest summary', createdAt: '2026-10-10' })] }),
  ]);
  assert.equal(results.filter(row => row.kind === 'file').length, 1);
  assert.equal(results[0].title, 'Latest summary');
  assert.equal(results.find(row => row.key === 'group:1')?.kind, 'group');
});
