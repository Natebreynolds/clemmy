#!/usr/bin/env node
import { buildSync } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function buildCredentialPolicy(rootDir = defaultRootDir) {
  rootDir = realpathSync(rootDir);
  const source = path.join(rootDir, 'src/runtime/credential-private-filesystem.ts');
  const outfile = path.join(rootDir, 'apps/desktop/dist/credential-private-filesystem.cjs');
  try {
    readFileSync(source);
  } catch {
    throw new Error('Canonical credential filesystem policy source is missing; desktop credentials cannot build.');
  }

  const result = buildSync({ entryPoints: [source], outfile, bundle: true, format: 'cjs', platform: 'node',
    target: 'node22', logLevel: 'error', metafile: true, sourcemap: false, write: false,
    define: { 'import.meta.url': '__clemCredentialPolicyModuleUrl' },
    banner: { js: "const __clemCredentialPolicyModuleUrl = require('node:url').pathToFileURL(__filename).href;" },
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = realpathSync(path.resolve(input));
    if (![source, path.join(rootDir, 'src/runtime/windows-private-filesystem.ts'), path.join(rootDir, 'src/runtime/sync-directory.ts'), path.join(rootDir, 'src/runtime/ascii-json.ts')].includes(absolute)) {
      throw new Error(`Credential policy bundle unexpectedly imports ${input}; it must remain config independent.`);
    }
  }
  const bundle = result.outputFiles.find(output => output.path === outfile);
  if (!bundle) throw new Error('Canonical credential policy bundle bytes are missing.');
  mkdirSync(path.dirname(outfile), { recursive: true });
  const temporary = `${outfile}.new-${randomUUID()}`;
  try {
    writeFileSync(temporary, bundle.contents, { flag: 'wx' }); renameSync(temporary, outfile);
  } finally { rmSync(temporary, { force: true }); }
  return { outfile, sha256: createHash('sha256').update(bundle.contents).digest('hex') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCredentialPolicy();
  process.stdout.write('Canonical credential filesystem policy bundled for desktop.\n');
}
