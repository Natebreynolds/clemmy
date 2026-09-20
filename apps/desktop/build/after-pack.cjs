const path = require('node:path');
const { readFileSync } = require('node:fs');
const { Arch } = require('builder-util');

module.exports = async function afterPack(context) {
  const packagedResources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  // Setup reads these beside the daemon package. Hotpatches already carry them;
  // normal installers must carry the same instruction bytes on every platform.
  for (const name of ['technical-content-marketing', 'workspace-builder']) {
    const relative = path.join('builtin-skills', name, 'SKILL.md');
    const source = path.resolve(context.packager.projectDir, '..', '..', relative);
    const packaged = path.join(packagedResources, 'daemon', relative);
    if (!readFileSync(source).equals(readFileSync(packaged))) {
      throw new Error(`Packaged built-in skill differs from source: ${name}`);
    }
  }
  if (context.electronPlatformName !== 'darwin') return;
  const arch = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : null;
  if (!arch) throw new Error(`unsupported Clementine macOS package architecture: ${context.arch}`);

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Resources');
  const { assertMachOArchitecture, preparePackagedMacDaemon } = await import('../scripts/mac-native-deps.mjs');
  preparePackagedMacDaemon({
    daemonDir: path.join(resources, 'daemon'),
    arch,
    stageDir: process.env.CLEMENTINE_MAC_NATIVE_STAGE,
  });

  // electron-builder owns this native desktop dependency. Keep it in the same
  // fail-closed architecture gate as the daemon's native modules.
  const keytar = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'keytar',
    'build',
    'Release',
    'keytar.node',
  );
  assertMachOArchitecture(keytar, arch === 'arm64' ? 'arm64' : 'x86_64');
};
