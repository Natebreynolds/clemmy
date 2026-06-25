import { rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const dist = resolve('dist');
if (dist === resolve('/') || basename(dist) !== 'dist') {
  throw new Error(`refusing to clean unexpected dist path: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
