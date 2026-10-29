import assert from 'node:assert/strict';
import test from 'node:test';
import { appGuidanceHref, renderMarkdown } from '@clem/chat-engine';
import { appLinkClickIsPlain, guidanceOrigin, guidanceReturnFromHistory, guidanceReturnSearch, mobileAppLinkDestination } from './app-link-navigation';
import { MobileChatLocationStore } from './chat-location';
import { MobileDraftStore } from './file-context';

const current = 'https://clem.example/m/?tab=chats&session=chat%3Aorigin';
test('modified, external-target and download links retain the browser’s own behavior', () => {
  const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(appLinkClickIsPlain(click, null, false), true);
  assert.equal(appLinkClickIsPlain(click, '_self', false), true);
  for (const key of ['defaultPrevented', 'metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) assert.equal(appLinkClickIsPlain({ ...click, [key]: true }, null, false), false);
  assert.equal(appLinkClickIsPlain({ ...click, button: 1 }, null, false), false);
  assert.equal(appLinkClickIsPlain(click, '_blank', false), false);
  assert.equal(appLinkClickIsPlain(click, null, true), false);
});
test('renderer-produced guide and item links keep internal navigation without accepting a different target', () => {
  const href = appGuidanceHref('inbox', 'phone')!;
  assert.match(renderMarkdown('[Show Inbox](app:guide:inbox)', { appPlaceLinks: 'phone' }), /data-app-item="guide"/);
  assert.equal(mobileAppLinkDestination(href, { item: 'guide' }, current)?.href, new URL(href, current).href);
  assert.equal(mobileAppLinkDestination('/m/?tab=spaces&workspace=sample-space', { item: 'space' }, current)?.searchParams.get('workspace'), 'sample-space');
  assert.equal(mobileAppLinkDestination('/m/?tab=workflows&workflow=sample-flow', { item: 'workflow' }, current)?.searchParams.get('workflow'), 'sample-flow');
  assert.equal(mobileAppLinkDestination('/m/?tab=agents', { place: 'agents' }, current)?.searchParams.get('tab'), 'agents');
  for (const href of ['https://other.example/m/?tab=inbox&guide=inbox', '/m/?tab=agents&guide=inbox', '/m/?tab=inbox&guide=inbox&send=true', '/m/?tab=inbox&guide=unknown', '/m/?tab=inbox&guide=inbox#other']) {
    assert.equal(mobileAppLinkDestination(href, { item: 'guide' }, current), null);
  }
  assert.equal(mobileAppLinkDestination('/m/?tab=inbox', { item: 'unknown' }, current), null);
  assert.equal(mobileAppLinkDestination('/m/?tab=inbox', { place: 'agents' }, current), null);
});

test('guidance returns to the captured conversation rather than whichever chat was opened later', () => {
  const chats = new MobileChatLocationStore();
  chats.save({ kind: 'chat', sessionId: 'chat:origin', title: 'Original conversation' });
  const origin = guidanceOrigin('?tab=chats&session=chat%3Aorigin', chats.resume(), null);
  chats.save({ kind: 'chat', sessionId: 'chat:later', title: 'Later conversation' });
  const saved = guidanceReturnFromHistory({ clemGuidanceReturn: origin });
  chats.save(saved); chats.showConversation();
  assert.equal(chats.resume()?.kind, 'chat');
  assert.deepEqual(chats.resume(), { kind: 'chat', sessionId: 'chat:origin', title: 'Original conversation' });
  assert.equal(guidanceReturnSearch(saved), '?tab=chats&session=chat%3Aorigin');
  assert.deepEqual(guidanceOrigin('?tab=inbox&guide=inbox', chats.resume(), saved), saved, 'nested guidance keeps its original source');
  assert.equal(guidanceOrigin('?tab=home', chats.resume(), null), null, 'a guide outside a conversation does not claim one');
});

test('unsent text and attachments remain in their original draft scope without replayable handoff instructions', () => {
  const chats = new MobileChatLocationStore();
  const drafts = new MobileDraftStore(() => {});
  chats.save({ kind: 'new', scope: 'new:origin', agentId: 'agent-one', projectId: 'project-one' });
  drafts.patch('new:origin', { text: 'Still working on this', stagedAttachments: [{ id: 'attachment-one', name: 'Notes.txt', kind: 'file' }] });
  const origin = guidanceOrigin('?tab=chats', chats.resume(), null);
  const saved = guidanceReturnFromHistory({ clemGuidanceReturn: { ...origin, autoSend: true, draft: 'Do not replay', attachments: [{ id: 'old-file' }] } });
  assert.deepEqual(saved, { kind: 'new', scope: 'new:origin', agentId: 'agent-one', agentName: undefined, projectId: 'project-one', projectName: undefined });
  assert.equal(guidanceReturnSearch(saved), '?tab=chats');
  assert.equal(drafts.read('new:origin').text, 'Still working on this');
  assert.equal(drafts.read('new:origin').stagedAttachments?.[0].id, 'attachment-one');
  assert.ok(saved && !('autoSend' in saved) && !('draft' in saved) && !('attachments' in saved));
  assert.equal(guidanceReturnFromHistory({ clemGuidanceReturn: { kind: 'new', scope: 'chat:wrong' } }), null);
});
