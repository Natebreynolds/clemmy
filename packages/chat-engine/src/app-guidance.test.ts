import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appGuidanceHref, appItemHref } from './app-places.js';
import { getAppGuidance } from './app-guidance.js';
import { renderMarkdown } from './markdown.js';

test('guidance preserves exact settings anchor and phone destination without authorizing an action', () => {
  assert.equal(appGuidanceHref('models', 'desktop'), '/settings?guide=models#who-does-what');
  assert.equal(appGuidanceHref('model-accounts', 'phone'), '/m/?tab=settings&section=accounts&guide=model-accounts');
  assert.equal(appGuidanceHref('phone', 'desktop'), '/connect?guide=phone#phone');
  const desktop = getAppGuidance('models', 'desktop');
  assert.equal(desktop?.target, '#who-does-what');
  assert.equal(desktop?.placeHref, '/settings#who-does-what');
  assert.match(desktop?.instruction ?? '', /has not changed/);
});

test('unknown, malformed, and unsupported guidance cannot become navigation', () => {
  for (const id of ['vault', '../settings', 'https://example.com', '__proto__', '', 'heartbeats']) {
    assert.equal(getAppGuidance(id, 'desktop'), null, id);
    assert.equal(appItemHref('guide', id, 'phone'), undefined, id);
  }
  assert.equal(getAppGuidance(null, 'phone'), null);
});

test('one guidance link is surface-specific, escaped, and inert without app navigation enabled', () => {
  const markdown = '[Show me](app:guide:model-accounts)';
  assert.match(renderMarkdown(markdown, { appPlaceLinks: 'desktop' }), /href="\/settings\?guide=model-accounts#accounts"/);
  assert.match(renderMarkdown(markdown, { appPlaceLinks: 'phone' }), /href="\/m\/\?tab=settings&amp;section=accounts&amp;guide=model-accounts"/);
  assert.doesNotMatch(renderMarkdown(markdown), /<a /);
  assert.doesNotMatch(renderMarkdown('[<img src=x>](app:guide:spaces)', { appPlaceLinks: 'desktop' }), /<img/);
});

test('the exact saved workflow opens on the phone without running it', () => {
  assert.equal(appItemHref('workflow', 'weekly-review', 'phone'), '/m/?tab=workflows&workflow=weekly-review');
  assert.equal(appItemHref('workflow', '../delete', 'phone'), undefined);
  assert.doesNotMatch(appItemHref('workflow', 'weekly-review', 'phone') ?? '', /run|execute|enable/);
});

test('the old needs-you place keeps a supported guidance definition', () => {
  assert.equal(getAppGuidance('needs-you', 'phone')?.target, getAppGuidance('inbox', 'phone')?.target);
});

test('Projects and Agents have direct guides to their real creation controls on both surfaces', () => {
  for (const [id, route, tab, label] of [['projects', '/projects', 'projects', 'New project'], ['agents', '/agents', 'agents', 'New agent']] as const) {
    assert.equal(appGuidanceHref(id, 'desktop'), `${route}?guide=${id}`);
    assert.equal(appGuidanceHref(id, 'phone'), `/m/?tab=${tab}&guide=${id}`);
    assert.match(getAppGuidance(id, 'desktop')!.instruction, new RegExp(label));
    assert.match(getAppGuidance(id, 'phone')!.instruction, /Tap the plus button at the top/);
    assert.match(renderMarkdown(`[Show me](app:guide:${id})`, { appPlaceLinks: 'phone' }), new RegExp(`tab=${tab}&amp;guide=${id}`));
  }
  assert.equal(getAppGuidance('projects', 'desktop')!.target, '[data-clem-guide="create-project"]');
  assert.equal(getAppGuidance('agents', 'phone')!.target, '[data-clem-guide="create-agent"]');
});

test('guidance names the available creation control and keeps computer-only setup on the computer', () => {
  const automation = getAppGuidance('automate', 'desktop')!;
  assert.match(automation.instruction, /Choose New automation/);
  assert.doesNotMatch(automation.instruction, /Choose Create with Clementine/);
  const phoneConnections = getAppGuidance('connect', 'phone')!;
  assert.match(phoneConnections.instruction, /Review your connected apps and their status/);
  assert.match(phoneConnections.instruction, /app setup.*Apps & devices on the computer/);
  assert.doesNotMatch(phoneConnections.instruction, /Open the connection|continue setup/);
  const phoneAccounts = getAppGuidance('model-accounts', 'phone')!;
  assert.match(phoneAccounts.instruction, /billing link.*provider’s page/);
  assert.match(phoneAccounts.instruction, /Sign-in and account setup are in Settings on your computer/);
  assert.doesNotMatch(phoneAccounts.instruction, /Choose the account you want to manage/);
});
