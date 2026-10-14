import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpConnectionHelp, mcpConnectionPresentation, mcpServerNameConflict } from './mcp-setup-view';

test('saved or enabled configuration does not imply a successful MCP connection', () => {
  assert.equal(mcpConnectionPresentation({ enabled: true }).label, 'Not checked');
  assert.equal(mcpConnectionPresentation({ enabled: true, state: 'connected', unsetEnvKeys: ['TEST_KEY'] }).label, 'Needs setup');
  assert.equal(mcpConnectionPresentation({ enabled: false, state: 'connected' }).label, 'Off');
  assert.equal(mcpConnectionPresentation({ enabled: true, state: 'connected' }).label, 'Connected');
});

test('connection recovery never renders server stderr, credentials or capability URLs', () => {
  for (const raw of [
    'spawn /private/test ENOENT secret=PRIVATE_VALUE',
    '401 unauthorized Authorization: Bearer PRIVATE_VALUE',
    'timeout https://example.test/?token=PRIVATE_VALUE',
    'arbitrary server output PRIVATE_VALUE',
  ]) {
    const help = mcpConnectionHelp(raw);
    assert.ok(!help.includes('PRIVATE_VALUE'));
    assert.ok(!help.includes('https://'));
    assert.match(help, /(?:setup|credentials|runtime|available)/i);
  }
});

test('import preview detects existing names and namespace aliases before Add', () => {
  const servers = [{ name: 'My.Tools' }, { name: 'clementine-local' }];
  assert.equal(mcpServerNameConflict('my.tools', servers), true);
  assert.equal(mcpServerNameConflict('Clementine-Local', servers), true);
  assert.equal(mcpServerNameConflict('my-tools', servers), false);
  assert.equal(mcpServerNameConflict('new-tools', servers), false);
});
