import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWindowsPowerShell, windowsPowerShellInvocation } from './windows-powershell.js';

function fixture(outcome: 'ok' | 'fail' | 'error' | 'hang') {
  const calls: unknown[][] = []; let stdin = ''; let kills = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills += 1; return true; }, unref() {} }) as unknown as ChildProcess;
  child.stdin!.on('data', chunk => { stdin += chunk.toString('utf8'); });
  const spawnProcess = ((...args: unknown[]) => {
    calls.push(args);
    if (outcome !== 'hang') setTimeout(() => {
      if (outcome === 'error') child.emit('error', new Error('fixture error with private URL'));
      else { child.stdout!.emit('data', Buffer.from('42')); child.stderr!.emit('data', Buffer.from('private-url-must-not-escape')); child.emit('close', outcome === 'ok' ? 0 : 1); }
    }, 5);
    return child;
  }) as typeof spawn;
  return {calls,spawnProcess,input:()=>stdin,kills:()=>kills};
}

test('PowerShell receives Unicode URL metacharacters as private stdin data, not command arguments', async () => {
  const f=fixture('ok'); const payload={target:'https://example.invalid/oauth?state=a&scope=b%20c#片段'};
  assert.equal(await runWindowsPowerShell('Start-Process -FilePath $payload.target -ErrorAction Stop',payload,
    {spawnProcess:f.spawnProcess,env:{SystemRoot:'C:\\Windows',OPENAI_API_KEY:'synthetic-secret'}}),'42');
  assert.deepEqual(JSON.parse(f.input()),payload);
  assert.equal(f.calls[0][0],'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const argv=f.calls[0][1] as string[];
  assert.deepEqual(argv.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);
  const program=Buffer.from(argv[3],'base64').toString('utf16le');
  assert.match(program,/ConvertFrom-Json/); assert.doesNotMatch(program,/example\.invalid|片段|ExecutionPolicy|RunAs/);
  assert.deepEqual((f.calls[0][2] as {env:unknown}).env,{SystemRoot:'C:\\Windows'});
});

for (const outcome of ['fail','error','hang'] as const) test(`PowerShell ${outcome} cannot claim application launch or leak stderr`, async () => {
  const f=fixture(outcome);
  await assert.rejects(runWindowsPowerShell('fixed trusted program',{}, {spawnProcess:f.spawnProcess,timeoutMs:20}),
    error => { assert.doesNotMatch(String(error),/private-url|private URL/); return /Windows.*launch/i.test(String(error)); });
  assert.equal(f.kills(),1);
});

test('actual Windows PowerShell preserves literal Unicode paths and URL query bytes', {skip:process.platform!=='win32'}, async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'clem-PS-片段 & literal-'));
  const file=path.join(dir,'result.txt'); const value='https://example.invalid/?state=a&scope=b%20c#片段';
  const program='[IO.File]::WriteAllText($payload.file, $payload.value, (New-Object System.Text.UTF8Encoding($false))); [Console]::Out.Write($payload.value)';
  try {
    const output = await runWindowsPowerShell(program, {file,value}).catch(error => {
      // The launch failed on the real OS (run 37658867292: the 15 s bound with
      // a warm 5.1). Rerun the same invocation synchronously, then variants
      // that each drop one difference from the working ACL probe, so the
      // failure names the cause. The payload here is synthetic, so stderr may show.
      const { executable, args, env } = windowsPowerShellInvocation(program);
      const minimalEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:path|userprofile|appdata|localappdata)$/i.test(key)));
      const withoutEncodingLines = windowsPowerShellInvocation(program).args.map((arg, index, all) => index === all.length - 1
        ? Buffer.from(Buffer.from(arg, 'base64').toString('utf16le').split('\n').filter(line => !/^\[Console\]::(?:Input|Output)Encoding/.test(line)).join('\n'), 'utf16le').toString('base64') : arg);
      const variants: Array<[string, string, string[], NodeJS.ProcessEnv]> = [
        ['same invocation, synchronous', executable, args, env],
        ['minimal env (no PATH/USERPROFILE/APPDATA/LOCALAPPDATA)', executable, args, minimalEnv],
        ['without the console encoding lines', executable, withoutEncodingLines, env],
        ['interactive flag dropped', executable, args.filter(arg => arg !== '-NonInteractive'), env],
      ];
      const report = variants.map(([label, exe, argv, environment]) => {
        const started = Date.now();
        const probe = spawnSync(exe, argv, { input: JSON.stringify({file,value}), env: environment, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 65_536 });
        return `${label}: status=${probe.status} signal=${probe.signal} ${Date.now() - started} ms error=${probe.error?.message ?? ''}\n  stdout=${JSON.stringify(String(probe.stdout ?? '').slice(0, 300))}\n  stderr=${JSON.stringify(String(probe.stderr ?? '').slice(0, 1_500))}`;
      }).join('\n');
      throw new Error(`${String(error)}\n${report}`);
    });
    assert.equal(readFileSync(file,'utf8'),value);
    assert.equal(output,value);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
