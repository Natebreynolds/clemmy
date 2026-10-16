import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { childEnvValue, mergeChildEnvLayers } from './child-env-layers.js';

test('Windows later layers replace all earlier aliases without changing inputs', () => {
  const inherited = Object.freeze({ PATH: 'inherited-path', CLI_PROFILE: 'inherited-profile', TOKEN: 'inherited-token' });
  const declared = Object.freeze({ Path: 'declared-path', cli_profile: 'declared-profile', token: 'declared-token' });
  const extra = Object.freeze({ pAtH: '', Cli_Profile: ' call-profile ' });
  const env = mergeChildEnvLayers([inherited, declared, extra], 'win32');
  assert.deepEqual(env, { PATH: '', Cli_Profile: ' call-profile ', token: 'declared-token' });
  assert.equal(new Set(Object.keys(env).map(key => key.toUpperCase())).size, Object.keys(env).length);
  assert.equal(childEnvValue(env, 'CLI_PROFILE', 'win32'), ' call-profile ');
  assert.equal(inherited.PATH, 'inherited-path');
  assert.equal(declared.Path, 'declared-path');
  assert.equal(extra.pAtH, '');
});

test('within one Windows layer uppercase wins, otherwise the last own alias wins', () => {
  for (const [layer, expected] of [
    [{ Path: 'first', pAtH: 'last' }, 'last'],
    [{ PATH: 'uppercase', Path: 'later-alias' }, 'uppercase'],
    [{ Path: 'first', PATH: 'uppercase', pAtH: 'last' }, 'uppercase'],
  ] as const) {
    assert.deepEqual(mergeChildEnvLayers([layer], 'win32'), { PATH: expected });
    assert.equal(childEnvValue(layer, 'Path', 'win32'), expected);
  }
  assert.deepEqual(mergeChildEnvLayers([{ TOKEN: 'uppercase', token: 'alias' }, { token: 'later-layer' }], 'win32'),
    { token: 'later-layer' });
});

test('empty values override, undefined and prototype values cannot become child values', () => {
  const layer = Object.assign(Object.create({ INHERITED_SECRET: 'unrelated' }), { TOKEN: '', Path: undefined });
  assert.deepEqual(mergeChildEnvLayers([{ TOKEN: 'old', PATH: 'kept' }, layer], 'win32'), { TOKEN: '', PATH: 'kept' });
  assert.equal(childEnvValue(layer, 'INHERITED_SECRET', 'win32'), undefined);
  assert.equal(childEnvValue(layer, 'INHERITED_SECRET', 'linux'), undefined);
});

test('POSIX retains distinct names, exact precedence and explicit blanks', () => {
  const env = mergeChildEnvLayers([{ PATH: 'upper', Path: 'mixed', TOKEN: 'upper-token' },
    { PATH: '', token: 'lower-token' }], 'linux');
  assert.deepEqual(env, { PATH: '', Path: 'mixed', TOKEN: 'upper-token', token: 'lower-token' });
  assert.equal(childEnvValue(env, 'Token', 'linux'), undefined);
  assert.equal(childEnvValue(env, 'token', 'linux'), 'lower-token');
});

test('prototype-looking own names stay literal data on either platform', () => {
  const layer = JSON.parse('{"__proto__":"literal-value","constructor":"literal-constructor"}') as Record<string, string>;
  for (const platform of ['linux', 'win32'] as const) {
    const env = mergeChildEnvLayers([layer], platform);
    assert.equal(Object.getPrototypeOf(env), Object.prototype);
    assert.equal(Object.hasOwn(env, '__proto__'), true);
    assert.equal(env.__proto__, 'literal-value');
    assert.equal(env.constructor, 'literal-constructor');
  }
});

test('native Windows child receives the selected layer values and one PATH key', { skip: process.platform !== 'win32' }, () => {
  const env = mergeChildEnvLayers([
    { SystemRoot: process.env.SystemRoot, CLI_PROFILE: 'inherited', PATH: 'inherited-path' },
    { cli_profile: 'declared', Path: 'declared-path' }, { Cli_Profile: 'call', pAtH: '' },
  ], 'win32');
  const output = execFileSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify({profile:process.env.CLI_PROFILE,path:process.env.PATH,pathKeys:Object.keys(process.env).filter(k=>k.toUpperCase()==="PATH")}))'],
  { env, encoding: 'utf8', timeout: 5_000 });
  assert.deepEqual(JSON.parse(output), { profile: 'call', path: '', pathKeys: ['PATH'] });
});
