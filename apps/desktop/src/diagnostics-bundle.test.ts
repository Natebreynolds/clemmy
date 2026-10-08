import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildDiagnosticsText, redactDiagnostics, saveDiagnosticsFile } from './diagnostics-bundle.js';

function fixture(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-diagnostics-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const WHO = { userHome: 'C:\\Users\\kenvi', hostname: 'Kevin-PC' };
const SOURCE = { appVersion: '3.18.34-windows.9', platform: 'win32' as const, arch: 'x64', osRelease: '10.0.26100',
  versions: { electron: '43.0.0', node: '24.17.0' }, ...WHO, now: new Date('2026-10-08T17:20:44.000Z') };

test('the support file carries the crash the tester could only paste by hand, with the build identity', () => fixture((logDir) => {
  writeFileSync(path.join(logDir, 'supervisor.log'), [
    '=== Daemon started 2026-10-08T17:20:44.310Z on port 8520 ===',
    '{"level":30,"hostname":"Kevin-PC","msg":"Clementine daemon build: v3.18.34-windows.5"}',
    'Unhandled rejection Error: spawn C:\\Users\\kenvi\\AppData\\Roaming\\npm\\claude ENOENT',
    '[daemon] FATAL unhandledRejection — exiting',
  ].join('\n'));
  writeFileSync(path.join(logDir, 'daemon-stalls.jsonl'), '{"event":"end","durationMs":17226,"phase":{"name":"daemon.http"}}\n');
  const text = buildDiagnosticsText({ ...SOURCE, logDir });
  assert.match(text, /App: 3\.18\.34-windows\.9 on win32 x64/);
  assert.match(text, /=== supervisor\.log \(\d+ KB\) ===/);
  assert.match(text, /FATAL unhandledRejection/);
  assert.match(text, /spawn ~\\AppData\\Roaming\\npm\\claude ENOENT/, 'the path stays readable with the user folder replaced');
  assert.match(text, /=== daemon-stalls\.jsonl/);
  assert.match(text, /=== supervisor-hang-snapshots\.jsonl: not present ===/);
  assert.equal(text.includes('kenvi'), false);
  assert.equal(text.includes('Kevin-PC'), false);
}));

test('secrets, tokens, emails, the user folder in every form and the computer name never leave', () => {
  const raw = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwx',
    'WEBHOOK_SECRET=0123456789abcdef0123456789abcdef',
    '{"accessToken":"sk-ant-oat01-ABCDEFGHIJKLMNOP","refresh_token":"xyz\\"quoted","user":"nate@example.com"}',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '"entry":"C:\\\\Users\\\\kenvi\\\\AppData\\\\Local\\\\Programs\\\\@clemmydesktop" file:///C:/Users/kenvi/x.js host Kevin-PC',
  ].join('\n');
  const out = redactDiagnostics(raw, WHO);
  for (const secret of ['abcdefghijklmnopqrstuvwx', '0123456789abcdef0123456789abcdef', 'sk-ant-oat01-ABCDEFGHIJKLMNOP', 'xyz', 'nate@example.com',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'kenvi', 'Kevin-PC']) {
    assert.equal(out.includes(secret), false, `${secret} is replaced`);
  }
  assert.match(out, /"entry":"~\\\\AppData/);
  assert.match(out, /file:\/\/\/~\/x\.js/);
});

test('a large log keeps its newest part from a whole line, and the file lands where asked', () => fixture((dir) => {
  const logDir = path.join(dir, 'logs');
  const old = 'old line that should be cut\n'.repeat(80_000);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, 'supervisor.log'), `${old}NEWEST LINE\n`);
  const file = saveDiagnosticsFile({ ...SOURCE, logDir }, path.join(dir, 'Downloads'));
  assert.equal(path.basename(file), 'clementine-diagnostics-20261008-172044.txt');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /=== supervisor\.log \(last 1465 KB of 2188 KB\) ===\nold line that should be cut\n/);
  assert.match(text, /NEWEST LINE/);
}));
