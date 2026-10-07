import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/** Launch a host-discovered executable with literal argv. Windows npm batch
 * shims need cross-spawn's command/argument escaping; never add shell:true to
 * a provider-supplied command to compensate for Node's .cmd limitation. */
export const spawnCliProcess: typeof spawn = process.platform === 'win32'
  ? createRequire(import.meta.url)('cross-spawn') as typeof spawn : spawn;
