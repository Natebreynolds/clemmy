import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asciiJson, runWindowsPowerShell, windowsPowerShellInvocation } from './windows-powershell.js';

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
  assert.equal(await runWindowsPowerShell('[void][System.Diagnostics.Process]::Start($payload.target)',payload,
    {spawnProcess:f.spawnProcess,env:{SystemRoot:'C:\\Windows',OPENAI_API_KEY:'synthetic-secret'}}),'42');
  assert.deepEqual(JSON.parse(f.input()),payload);
  assert.match(f.input(),/^[\x20-\x7e]+$/,'the payload bytes over stdin are printable ASCII, whatever code page the host reads');
  assert.equal(f.calls[0][0],'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const argv=f.calls[0][1] as string[];
  assert.deepEqual(argv.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);
  const program=Buffer.from(argv[3],'base64').toString('utf16le');
  assert.match(program,/JavaScriptSerializer/); assert.doesNotMatch(program,/example\.invalid|片段|ExecutionPolicy|RunAs/);
  // No Verb-Noun cmdlet: one would make 5.1 analyze every module on the
  // module path first, which never finished under the reduced environment.
  assert.doesNotMatch(program,/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
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
  const program='[IO.File]::WriteAllText($payload.file, $payload.value, ([System.Text.UTF8Encoding]::new($false))); [Console]::Out.Write($payload.value)';
  try {
    const output = await runWindowsPowerShell(program, {file,value}).catch(error => {
      // The launch failed on the real OS. Run 37660389975 showed every
      // variant of the invocation (synchronous, minimal environment, no
      // encoding lines, interactive) waiting with empty output while the
      // ACL fixtures' plain-ASCII stdin reads completed; the host now sends
      // ASCII-only JSON and a system-variable environment. Should it still
      // fail, bisect what remains: the environment, then the payload bytes.
      // The payload here is synthetic, so stderr may show.
      const { executable, args, env } = windowsPowerShellInvocation(program);
      const echo = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference=\'Stop\'; $p=[Console]::In.ReadToEnd(); [Console]::Out.Write($p)', 'utf16le').toString('base64')];
      const variants: Array<[string, string[], NodeJS.ProcessEnv, string]> = [
        ['same invocation, synchronous', args, env, asciiJson({file,value})],
        ['same invocation, the whole process environment', args, process.env, asciiJson({file,value})],
        ['plain echo program, host environment, ASCII stdin', echo, env, 'ping'],
        ['plain echo program, whole environment, ASCII stdin', echo, process.env, 'ping'],
        ['plain echo program, host environment, raw UTF-8 stdin', echo, env, JSON.stringify({file,value})],
      ];
      const report = variants.map(([label, argv, environment, input]) => {
        const started = Date.now();
        const probe = spawnSync(executable, argv, { input, env: environment, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 65_536 });
        return `${label}: status=${probe.status} signal=${probe.signal} ${Date.now() - started} ms error=${probe.error?.message ?? ''}\n  stdout=${JSON.stringify(String(probe.stdout ?? '').slice(0, 300))}\n  stderr=${JSON.stringify(String(probe.stderr ?? '').slice(0, 1_500))}`;
      }).join('\n');
      throw new Error(`${String(error)}\n${report}`);
    });
    assert.equal(readFileSync(file,'utf8'),value);
    assert.equal(output,value);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
