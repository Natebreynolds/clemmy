import assert from 'node:assert/strict';
import test from 'node:test';
import { appGuidanceHref, appItemHref, resolveAppLink } from './app-places.js';

test('renderer-marked places, guides and exact created items stay inside their owning surface', () => {
  for (const surface of ['desktop', 'phone'] as const) {
    assert.deepEqual(resolveAppLink({ place: 'agents', href: surface === 'desktop' ? '/agents' : '/m/?tab=agents' }, surface)?.kind, 'place');
    const guide = appGuidanceHref('projects', surface)!;
    assert.deepEqual(resolveAppLink({ item: 'guide', href: guide }, surface), { kind: 'guide', href: guide });
    for (const item of ['space', 'workflow'] as const) {
      const href = appItemHref(item, 'review-week', surface)!;
      assert.deepEqual(resolveAppLink({ item, href }, surface), { kind: item, href });
    }
  }
});

test('markers cannot widen navigation to an external, modified or invented destination', () => {
  for (const link of [
    { item: 'guide', href: '//example.test/m/?tab=projects&guide=projects' },
    { item: 'guide', href: '/m/?tab=projects&guide=projects&autoSend=1' },
    { item: 'guide', href: '/m/?tab=settings&guide=projects' },
    { item: 'workflow', href: '/m/?tab=workflows&workflow=review-week&run=1' },
    { item: 'space', href: '/m/?tab=spaces&workspace=../settings' },
    { item: 'unknown', href: '/m/?tab=projects' },
    { place: 'agents', href: '/m/?tab=projects' },
    { place: 'agents', item: 'guide', href: '/m/?tab=agents' },
    { href: '/m/?tab=projects' },
  ]) assert.equal(resolveAppLink(link, 'phone'), null);
  assert.equal(resolveAppLink({ item: 'guide', href: '/m/?tab=agents&guide=agents' }, 'desktop'), null);
});
