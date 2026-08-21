import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.CLEMENTINE_HOME || !process.env.CLEMENTINE_HOME.includes(os.tmpdir())) {
  process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-typed-source-home-'));
}
