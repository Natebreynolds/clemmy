const path = require('node:path');
const { Arch } = require('builder-util');

module.exports = async function afterPack(context) {
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
