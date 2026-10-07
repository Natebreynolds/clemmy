import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodingAgentEnv } from './coding-run-env.js';

test('Windows coding children retain OS paths without borrowing provider credentials', () => {
  const env = buildCodingAgentEnv({
    Path: 'C:\\Tools;C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows', comspec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\Fixture',
    APPDATA: 'C:\\Users\\Fixture\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local',
    TEMP: 'C:\\Users\\Fixture\\AppData\\Local\\Temp', TMP: 'C:\\Temp',
    Claude_Config_Dir: 'C:\\Users\\Fixture\\.claude',
    codex_home: 'C:\\Users\\Fixture\\.codex',
    anthropic_api_key: 'fixture-not-forwarded', OpenAI_API_Key: 'fixture-not-forwarded',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-not-forwarded', CLEMENTINE_HOME: 'fixture-not-forwarded',
    ELECTRON_RUN_AS_NODE: 'fixture-not-forwarded', NODE_OPTIONS: 'fixture-not-forwarded',
  }, 'win32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(env.USERPROFILE, 'C:\\Users\\Fixture');
  assert.equal(env.APPDATA, 'C:\\Users\\Fixture\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\Fixture\\AppData\\Local');
  assert.equal(env.TEMP, 'C:\\Users\\Fixture\\AppData\\Local\\Temp');
  assert.equal(env.TMP, 'C:\\Temp');
  assert.ok(env.PATH!.includes('C:\\Tools;C:\\Windows\\System32'));
  assert.equal(env.Path, undefined);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLEMENTINE_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\Users\\Fixture\\.claude');
  assert.equal(env.CODEX_HOME, 'C:\\Users\\Fixture\\.codex');
});

test('POSIX coding children preserve the existing allowlist and credential boundary', () => {
  const env = buildCodingAgentEnv({ HOME: '/fixture', PATH: '/fixture/bin', LANG: 'en_US.UTF-8',
    SystemRoot: 'windows-only', ComSpec: 'windows-only', USERPROFILE: 'windows-only',
    ANTHROPIC_API_KEY: 'fixture-not-forwarded', OPENAI_API_KEY: 'fixture-not-forwarded',
  }, 'darwin');
  assert.equal(env.HOME, '/fixture');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.ok(env.PATH!.includes('/fixture/bin'));
  for (const name of ['SystemRoot', 'ComSpec', 'USERPROFILE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) assert.equal(env[name], undefined);
});
