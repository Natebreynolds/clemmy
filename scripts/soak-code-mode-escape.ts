/**
 * Adversarial sandbox-escape soak for Code Mode (2026-06-22, pre-release gate for
 * flipping CLEMMY_CODE_MODE default-on). Feeds the sandbox programs that TRY to
 * escape — read files, spawn, open sockets, exfil secrets, delete-global bypass,
 * DoS — and asserts each is contained. A CANARY secret is planted in the PARENT
 * env so the secret-isolation test is real (the child must NOT see it).
 * Run: npx tsx scripts/soak-code-mode-escape.ts
 */
import { runCodeModeProgram, type CodeModeResult } from '../src/tools/code-mode-sandbox.js';
import { existsSync, rmSync } from 'node:fs';

// Plant canary secrets in the PARENT process env. The sandbox child is spawned
// with a minimal env, so a correctly-isolated child sees NONE of these.
process.env.SOAK_CANARY_SECRET = 'ESCAPE-CANARY-DO-NOT-LEAK-9f3a2b';
process.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || 'ck_CANARY_composio_should_not_leak';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whk_CANARY_should_not_leak';
const CANARY = 'ESCAPE-CANARY-DO-NOT-LEAK-9f3a2b';
const PWNED = '/tmp/clem-codemode-soak-PWNED';
try { rmSync(PWNED, { force: true }); } catch { /* ignore */ }

const dispatch = async () => ({ stub: 'no real tools wired in the soak' });
// Optional: run the sandbox CHILD under a specific Node binary (e.g. Electron's
// bundled Node) to validate the REAL production runtime, not system Node.
const NODE_BIN = process.env.SOAK_NODE_BIN || undefined;
const run = (program: string, timeoutMs = 15_000) => runCodeModeProgram(program, dispatch, { timeoutMs, nodeBin: NODE_BIN });

type Vector = { name: string; program: string; timeoutMs?: number; held: (r: CodeModeResult) => boolean; };

const blob = (r: CodeModeResult) => JSON.stringify({ ok: r.ok, value: r.value, error: r.error });
const noCanary = (r: CodeModeResult) => !blob(r).includes(CANARY) && !blob(r).includes('composio_should_not_leak') && !blob(r).includes('whk_CANARY');

const vectors: Vector[] = [
  { name: 'dynamic import fs → readFileSync(/etc/passwd)',
    program: `const fs = await import('node:fs'); return fs.readFileSync('/etc/passwd','utf8');`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'import child_process → execSync(id)',
    program: `const cp = await import('child_process'); return cp.execSync('id').toString();`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'import net → open socket',
    program: `const net = await import('node:net'); const s = net.connect(80,'example.com'); return 'connected';`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'import os → userInfo()',
    program: `const os = await import('os'); return os.userInfo();`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'import vm → run code',
    program: `const vm = await import('node:vm'); return 'got vm';`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'require() present? (ESM should have none)',
    program: `return typeof require;`,
    held: (r) => r.ok && r.value === 'undefined' },
  { name: 'fetch deleted? + attempt exfil',
    program: `if (typeof fetch !== 'undefined') { await fetch('http://127.0.0.1:1/'); return 'FETCH-ALIVE'; } return 'fetch:'+typeof fetch;`,
    held: (r) => r.ok && r.value === 'fetch:undefined' },
  { name: 'process.binding deleted?',
    program: `return 'binding:'+typeof process.binding;`,
    held: (r) => r.ok && r.value === 'binding:undefined' },
  { name: 'process.dlopen deleted?',
    program: `return 'dlopen:'+typeof process.dlopen;`,
    held: (r) => r.ok && r.value === 'dlopen:undefined' },
  { name: 'SECRET EXFIL: read planted env canaries',
    program: `return { canary: process.env.SOAK_CANARY_SECRET ?? null, composio: process.env.COMPOSIO_API_KEY ?? null, webhook: process.env.WEBHOOK_SECRET ?? null };`,
    held: (r) => r.ok && noCanary(r) },
  { name: 'env keys leak? (should be minimal, no secrets)',
    program: `return Object.keys(process.env);`,
    held: (r) => r.ok && noCanary(r) && Array.isArray(r.value) && !(r.value as string[]).some((k) => /KEY|SECRET|TOKEN|CANARY/i.test(k)) },
  { name: 'file WRITE via fs (then verified on disk)',
    program: `const fs = await import('node:fs'); fs.writeFileSync('${PWNED}','pwned'); return 'wrote';`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'data: URL import that itself imports fs',
    program: `const m = await import('data:text/javascript,export const f = async () => (await import("node:fs")).readFileSync("/etc/passwd","utf8")'); return await m.f();`,
    held: (r) => !r.ok && /blocked/i.test(r.error ?? '') },
  { name: 'DoS: infinite loop (must be killed by timeout)',
    program: `while (true) {}`, timeoutMs: 3000,
    held: (r) => !r.ok && /exceeded|killed/i.test(r.error ?? '') },
];

// Prove WHICH runtime the sandbox child actually ran on (the whole point: the
// real prod runtime is Electron's bundled Node, not system Node).
const rt = await run('return { node: process.version, electron: process.versions.electron ?? null };');
console.log(`sandbox child runtime: ${JSON.stringify(rt.value)} (binary: ${NODE_BIN ?? 'process.execPath (system)'})\n`);

let held = 0; const breaches: string[] = [];
for (const v of vectors) {
  const r = await run(v.program, v.timeoutMs ?? 15_000);
  const ok = v.held(r);
  if (ok) held++; else breaches.push(`${v.name} :: ${blob(r).slice(0, 200)}`);
  console.log(`${ok ? '✓ HELD ' : '✗ BREACH'}  ${v.name}`);
  if (!ok) console.log(`         result: ${blob(r).slice(0, 220)}`);
}

// Independent on-disk check: the file-write vector must NOT have created the file.
const fileLeaked = existsSync(PWNED);
console.log(`\nfile-write on-disk check: ${fileLeaked ? '✗ FILE EXISTS (BREACH)' : '✓ no file created'}`);
if (fileLeaked) { breaches.push('file-write actually created ' + PWNED); try { rmSync(PWNED, { force: true }); } catch {} }

console.log(`\n═══ ESCAPE SOAK: ${held}/${vectors.length} vectors contained${fileLeaked ? ' + 1 disk breach' : ''} ═══`);
if (breaches.length) { console.log('BREACHES:'); breaches.forEach((b) => console.log('  - ' + b)); process.exit(1); }
console.log('ALL CONTAINED — sandbox held against every escape attempt.');
