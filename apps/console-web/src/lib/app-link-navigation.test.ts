import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopAppLinkNavigation, guidanceOriginPath } from './app-link-navigation';

test('guides stay in the app and return to the exact main or agent conversation', () => {
  for (const pathname of ['/chat/harness%3Aopaque-session', '/agents/researcher/t/harness%3Aagent-thread']) {
    const navigation = desktopAppLinkNavigation({ item: 'guide', href: '/projects?guide=projects' }, { button: 0 }, pathname)!;
    assert.equal(navigation.href, '/projects?guide=projects');
    assert.equal(guidanceOriginPath(navigation.state), pathname);
    assert.deepEqual(Object.keys(navigation.state!), ['clemGuidanceOrigin'], 'no instructions, automatic send or draft content crosses into guide history');
  }
  assert.equal(desktopAppLinkNavigation({ item: 'space', href: '/workspaces/sample' }, { button: 0 }, '/chat/harness%3Aone')?.state, undefined);
});

test('native link gestures, downloads and external links retain their ordinary behavior', () => {
  const link = { item: 'guide', href: '/agents?guide=agents' };
  for (const click of [{ button: 1 }, { button: 0, metaKey: true }, { button: 0, ctrlKey: true },
    { button: 0, shiftKey: true }, { button: 0, altKey: true }, { button: 0, defaultPrevented: true }]) {
    assert.equal(desktopAppLinkNavigation(link, click, '/chat/harness%3Aone'), null);
  }
  assert.equal(desktopAppLinkNavigation({ ...link, target: '_blank' }, { button: 0 }, '/chat/harness%3Aone'), null);
  assert.equal(desktopAppLinkNavigation({ ...link, download: true }, { button: 0 }, '/chat/harness%3Aone'), null);
  assert.equal(desktopAppLinkNavigation({ ...link, href: 'https://example.test/' }, { button: 0 }, '/chat/harness%3Aone'), null);
});

test('a guide cannot turn arbitrary history state into a return destination', () => {
  assert.equal(guidanceOriginPath({ clemGuidanceOrigin: '/help' }), '/help', 'a guide replayed from Help can return there');
  for (const state of [null, {}, { clemGuidanceOrigin: 'https://example.test' }, { clemGuidanceOrigin: '//example.test' },
    { clemGuidanceOrigin: '/settings' }, { clemGuidanceOrigin: '/chat/one?autoSend=1' }, { clemGuidanceOrigin: '/chat/one\n' }]) {
    assert.equal(guidanceOriginPath(state), null);
  }
});
