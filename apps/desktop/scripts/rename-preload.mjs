#!/usr/bin/env node
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['preload', 'live-preload']) {
  const from = path.join(desktopDir, 'dist', `${name}.js`);
  const to = path.join(desktopDir, 'dist', `${name}.cjs`);

  if (!existsSync(from)) {
    throw new Error(`Expected compiled preload at ${from}`);
  }

  rmSync(to, { force: true });
  renameSync(from, to);
}
