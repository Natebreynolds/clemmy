import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-conversion-process-café-'));
process.env.CLEMENTINE_HOME = home;
process.env.MARKITDOWN_WARM = 'off';
test.after(() => rmSync(home, { recursive: true, force: true }));

let moduleIndex = 0;
async function freshRunner(): Promise<typeof import('./markitdown.js')> {
  // Each fixture has its own process-local safety latch. None resolves uv or
  // downloads Python: the same executor runs harmless local Node programs.
  return import(`./markitdown.js?process-fixture=${++moduleIndex}`);
}
const command = (program: string, timeoutMs = 5_000, env = process.env) => ({
  command: process.execPath, args: ['-e', program], cwd: home, env, label: 'synthetic document', timeoutMs,
});
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(file), true, 'controlled process started');
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('conversion executor retains actual successful output and honest failed execution', async () => {
  const { runMarkitdownProcess } = await freshRunner();
  assert.deepEqual(await runMarkitdownProcess(command('process.stdout.write("# café 日本語")')),
    { ok: true, markdown: '# café 日本語' });
  const failed = await runMarkitdownProcess(command('process.stderr.write("unsupported format"); process.exitCode=2'));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /exit 2.*unsupported format/);
});

test('a queued conversion waits for cleanup, then refuses after unconfirmed cleanup instead of starting again', async () => {
  const { runMarkitdownProcess } = await freshRunner();
  const started = [path.join(home, 'first'), path.join(home, 'second'), path.join(home, 'queued')];
  let releaseCleanup!: () => void;
  const cleanupReceipt = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let enteredCleanup!: () => void;
  const cleanupEntered = new Promise<void>(resolve => { enteredCleanup = resolve; });
  let cleanupCalls = 0;
  const dependencies = {
    platform: 'win32' as const,
    stopProcessTree: async (child: { kill: (signal?: NodeJS.Signals | number) => boolean }) => {
      cleanupCalls += 1; enteredCleanup();
      await cleanupReceipt;
      child.kill('SIGKILL');
      return 'incomplete' as const;
    },
  };
  const runs = started.map(file => runMarkitdownProcess(command(
    `require('fs').writeFileSync(${JSON.stringify(file)}, 'started'); setInterval(()=>{},1000)`, 1_000), dependencies));
  await Promise.all(started.slice(0, 2).map(waitForFile));
  await cleanupEntered;
  assert.equal(existsSync(started[2]), false, 'slot remains occupied until cleanup receipt settles');
  releaseCleanup();
  const results = await Promise.all(runs);
  assert.equal(cleanupCalls, 2, 'only the two owned processes requested cleanup');
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /could not confirm.*restart Clementine/);
  }
  assert.equal(existsSync(started[2]), false, 'queued conversion cannot fork another process');
  const again = await runMarkitdownProcess(command(`require('fs').writeFileSync(${JSON.stringify(started[2])}, 'repeated')`));
  assert.equal(again.ok, false);
  assert.equal(existsSync(started[2]), false, 'later conversions retain the stop until a new process starts');
});

test('actual Windows converter timeout stops its descendant before returning and permits later healthy work', { skip: process.platform !== 'win32' }, async () => {
  const { runMarkitdownProcess } = await freshRunner();
  const marker = path.join(home, 'windows-descendant.json');
  const running = runMarkitdownProcess(command(`
    const p=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:p.pid}));
    setInterval(()=>{},1000);
  `, 1_500));
  await waitForFile(marker);
  const pids = JSON.parse(readFileSync(marker, 'utf8'));
  try {
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.cleanupIncomplete, undefined);
    assert.equal(processExists(pids.parent), false, 'parent gone before timeout result');
    assert.equal(processExists(pids.child), false, 'managed child gone before timeout result');
    assert.deepEqual(await runMarkitdownProcess(command('process.stdout.write("recovered")')), { ok: true, markdown: 'recovered' });
  } finally {
    for (const pid of [pids.parent, pids.child]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

test('actual Windows missing OS cleanup utility returns bounded failure and blocks a fresh conversion', { skip: process.platform !== 'win32' }, async () => {
  const { runMarkitdownProcess } = await freshRunner();
  const start = performance.now();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'systemroot'));
  env.SystemRoot = path.join(home, 'missing-system-root');
  const result = await runMarkitdownProcess(command('setInterval(()=>{},1000)', 300, env));
  assert.equal(result.ok, false);
  assert.equal(result.cleanupIncomplete, true);
  if (!result.ok) assert.match(result.error, /restart Clementine before retrying/);
  assert.ok(performance.now() - start < 10_000, 'utility failure cannot hold the conversion queue indefinitely');
  assert.equal((await runMarkitdownProcess(command('process.stdout.write("must not execute")'))).ok, false);
});
