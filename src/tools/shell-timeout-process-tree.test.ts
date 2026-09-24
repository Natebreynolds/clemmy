import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-tree-'));
process.env.CLEMENTINE_HOME = home;
const { getComputerTools } = await import('./computer-tools.js');
after(() => rmSync(home, { recursive: true, force: true }));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
}

test('a shell timeout stops its owned POSIX descendants, including children that ignore TERM', {
  skip: process.platform === 'win32' ? 'Windows uses the existing taskkill /T path' : false,
}, async () => {
  const script = path.join(home, 'tree.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
fs.writeFileSync(path.join(__dirname, process.argv[2] === 'child' ? 'child.pid' : 'parent.pid'), String(process.pid));
if (process.argv[2] !== 'child') spawn(process.execPath, [__filename, 'child'], { stdio: 'inherit' });
process.on('SIGTERM', () => {});
setInterval(() => {}, 100);
`);
  const shell = getComputerTools().find(tool => tool.name === 'run_shell_command') as unknown as {
    invoke: (context: unknown, input: string, details: unknown) => Promise<string>;
  };
  const pids: number[] = [];
  try {
    const result = await shell.invoke({ context: { sessionId: 'shell-tree-fixture' } },
      JSON.stringify({ command: `${quote(process.execPath)} ${quote(script)}`, cwd: null, timeout_ms: 1000 }),
      { toolCall: { callId: 'owned-tree' } });
    assert.match(String(result), /timed out/i);
    for (const kind of ['parent', 'child']) pids.push(Number(readFileSync(path.join(home, `${kind}.pid`), 'utf8')));
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 1));
    for (let wait = 0; wait < 20 && pids.some(running); wait++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(running), [], 'a timed-out tool must not leave its command tree consuming CPU');
  } finally {
    for (const kind of ['parent', 'child']) {
      try { const pid = Number(readFileSync(path.join(home, `${kind}.pid`), 'utf8')); if (pid > 1 && running(pid)) process.kill(pid, 'SIGKILL'); } catch { /* fixture already stopped */ }
    }
  }
});
