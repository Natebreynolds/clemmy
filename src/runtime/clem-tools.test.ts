/** Run: node scripts/run-tests-isolated.mjs src/runtime/clem-tools.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installToolDownload, linkTool, npmInstallPlan, parseChecksums, resolveToolDownload, toolPlatformKey } from './clem-tools.js';

const gh = { githubRepo: 'cli/cli', assets: { 'darwin-arm64': 'gh_{version}_macOS_arm64.zip', 'linux-x64': 'gh_{version}_linux_amd64.tar.gz' }, checksums: 'gh_{version}_checksums.txt', bin: 'bin/gh' } as const;

test('a recipe resolves to the one download for this machine, from the release tag', () => {
  assert.equal(toolPlatformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(toolPlatformKey('win32', 'x64'), null);
  const mac = resolveToolDownload(gh, { platform: 'darwin', arch: 'arm64', tag: 'v2.80.0' });
  assert.deepEqual(mac, { url: 'https://github.com/cli/cli/releases/download/v2.80.0/gh_2.80.0_macOS_arm64.zip', assetName: 'gh_2.80.0_macOS_arm64.zip', checksumsUrl: 'https://github.com/cli/cli/releases/download/v2.80.0/gh_2.80.0_checksums.txt', version: '2.80.0', archive: 'zip' });
  assert.equal(resolveToolDownload(gh, { platform: 'darwin', arch: 'x64', tag: 'v2.80.0' }), null, 'no asset for this platform means no download, never a guess');
  const fixed = resolveToolDownload({ assets: { 'darwin-arm64': 'https://example.test/tool-darwin-arm64.tar.xz' }, bin: 'tool/bin/tool' }, { platform: 'darwin', arch: 'arm64' });
  assert.equal(fixed?.archive, 'tar');
  assert.equal(fixed?.version, 'latest');
  const sums = parseChecksums('abc\n' + 'a'.repeat(64) + '  gh_2.80.0_macOS_arm64.zip\n' + 'b'.repeat(64) + ' *./dist/other.tar.gz\n');
  assert.equal(sums.get('gh_2.80.0_macOS_arm64.zip'), 'a'.repeat(64));
  assert.equal(sums.get('other.tar.gz'), 'b'.repeat(64));
});

test('an npm package installs into Clem\'s folder on Clem\'s own runtime, with npm on PATH only as the fallback', () => {
  const own = npmInstallPlan({ spec: '@railway/cli', npmCli: '/app/node_modules/npm/bin/npm-cli.js', toolsDir: '/h/tools', cacheDir: '/h/cache/npm', node: { command: '/app/Clementine', env: { ELECTRON_RUN_AS_NODE: '1' } } });
  assert.equal(own.command, '/app/Clementine');
  assert.deepEqual(own.args.slice(0, 5), ['/app/node_modules/npm/bin/npm-cli.js', 'install', '-g', '--prefix', '/h/tools']);
  assert.equal(own.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(own.env.npm_config_prefix, '/h/tools');
  const fallback = npmInstallPlan({ spec: 'vercel', npmCli: null, toolsDir: '/h/tools', cacheDir: '/h/cache/npm' });
  assert.match(fallback.command, /^npm/);
  assert.equal(fallback.args.at(-1), 'vercel');
});

test('a download is verified, unpacked, and linked into Clem\'s bin', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-tools-'));
  const src = path.join(root, 'src', 'tool_1.0.0', 'bin'); mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'tool'), '#!/bin/sh\necho hi\n');
  const archive = path.join(root, 'tool_1.0.0_darwin_arm64.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'tool_1.0.0']);
  const bytes = new Uint8Array(await import('node:fs').then((fs) => fs.readFileSync(archive)));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 });
    if (u.endsWith('checksums.txt')) return new Response(`${digest}  tool_1.0.0_darwin_arm64.tar.gz\n`, { status: 200 });
    if (u.endsWith('.tar.gz')) return new Response(bytes, { status: 200 });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const log: string[] = [];
  const toolsDir = path.join(root, 'tools');
  const result = await installToolDownload({
    id: 'tool', toolsDir, platform: 'darwin', arch: 'arm64', fetchImpl, log: (l) => log.push(l),
    recipe: { githubRepo: 'acme/tool', assets: { 'darwin-arm64': 'tool_{version}_darwin_arm64.tar.gz' }, checksums: 'checksums.txt', bin: 'bin/tool', links: ['tool', 'tl'] },
  });
  assert.equal(result.version, '1.0.0');
  assert.equal(readlinkSync(path.join(toolsDir, 'bin', 'tool')), result.executable);
  assert.equal(readlinkSync(path.join(toolsDir, 'bin', 'tl')), result.executable);
  assert.equal(execFileSync(path.join(toolsDir, 'bin', 'tl')).toString().trim(), 'hi');
  assert.ok(log.some((l) => /Verified/.test(l)));
  const tampered = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 });
    if (u.endsWith('checksums.txt')) return new Response(`${'0'.repeat(64)}  tool_1.0.0_darwin_arm64.tar.gz\n`, { status: 200 });
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(installToolDownload({ id: 'tool', toolsDir, platform: 'darwin', arch: 'arm64', fetchImpl: tampered, log: () => undefined, recipe: { githubRepo: 'acme/tool', assets: { 'darwin-arm64': 'tool_{version}_darwin_arm64.tar.gz' }, checksums: 'checksums.txt', bin: 'bin/tool' } }), /did not match/);
  assert.equal(path.basename(linkTool(path.join(toolsDir, 'bin'), 'again', result.executable)), 'again');
});
