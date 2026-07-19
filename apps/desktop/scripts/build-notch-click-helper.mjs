import { chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperDir = path.join(desktopDir, 'native', 'notch-click-helper');
const source = path.join(helperDir, 'main.swift');
const buildDir = path.join(helperDir, '.build');
const arm64Binary = path.join(buildDir, 'ClementineNotchHelper-arm64');
const x64Binary = path.join(buildDir, 'ClementineNotchHelper-x64');
const universalBinary = path.join(buildDir, 'ClementineNotchHelper');

if (process.platform !== 'darwin') {
  process.stdout.write('[notch-helper] skipped (macOS only)\n');
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopDir,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})${detail}`);
  }
  return result.stdout ?? '';
}

mkdirSync(buildDir, { recursive: true });

for (const [target, output] of [
  ['arm64-apple-macosx12.0', arm64Binary],
  ['x86_64-apple-macosx12.0', x64Binary],
]) {
  run('/usr/bin/xcrun', [
    'swiftc',
    '-target', target,
    '-framework', 'AppKit',
    '-O',
    source,
    '-o', output,
  ]);
}

run('/usr/bin/xcrun', ['lipo', '-create', arm64Binary, x64Binary, '-output', universalBinary]);
run('/usr/bin/xcrun', ['lipo', universalBinary, '-verify_arch', 'arm64', 'x86_64']);
chmodSync(universalBinary, 0o755);

for (const arch of ['arm64', 'x86_64']) {
  const buildInfo = run('/usr/bin/xcrun', ['vtool', '-show-build', '-arch', arch, universalBinary], { capture: true });
  if (!/minos\s+12\.0(?:\.0)?\b/.test(buildInfo)) {
    throw new Error(`Notch helper ${arch} slice does not target macOS 12.0: ${buildInfo.slice(0, 500)}`);
  }
}

const probe = run(universalBinary, ['--probe'], { capture: true }).trim();
const parsed = JSON.parse(probe);
if (parsed?.type !== 'probe' || parsed?.protocol !== 1) {
  throw new Error(`Unexpected notch helper probe: ${probe.slice(0, 200)}`);
}

process.stdout.write(`[notch-helper] built ${universalBinary}\n`);
