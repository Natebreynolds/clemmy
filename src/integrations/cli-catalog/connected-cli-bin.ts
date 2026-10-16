import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { connectedCliBinDir } from '../../runtime/spawn-env.js';
import type { CliHealth } from './auth-health.js';
import { readConnectedClis } from './catalog.js';

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function executable(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Keep one link per connected CLI command, pointing at the executable its
 * health check last verified. The link directory leads every child's PATH
 * (spawn-env), so Clem's shell runs the same binary the Connections check
 * signed in with, even when another package installs a command of the same
 * name earlier on PATH. A command with no verified executable has no link.
 */
export function syncConnectedCliBin(entries: Record<string, CliHealth>): void {
  if (process.platform === 'win32') return;
  const dir = connectedCliBinDir();
  if (!dir) return;
  const connected = readConnectedClis();
  const wanted = new Map<string, string>();
  for (const health of Object.values(entries)) {
    const binary = health.binaryPath;
    if (!connected[health.id] || !health.installed || health.authStatus === 'signed_out') continue;
    // A transient on an unverified/different executable is inventory, not a
    // healthy binding. Same-executable stale ok retains its existing link.
    if (health.lastProbeError && health.authStatus !== 'ok') continue;
    if (!binary || !path.isAbsolute(binary) || binary.startsWith(dir + path.sep)) continue;
    if (!COMMAND_NAME.test(health.command) || !executable(binary)) continue;
    wanted.set(health.command, binary);
  }
  let present: string[] = [];
  try {
    present = readdirSync(dir);
  } catch {
    if (wanted.size === 0) return;
    mkdirSync(dir, { recursive: true });
  }
  for (const name of present) {
    const link = path.join(dir, name);
    let current: string | null = null;
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
    } catch {
      continue;
    }
    if (current !== null && wanted.get(name) === current) {
      wanted.delete(name);
      continue;
    }
    rmSync(link, { force: true });
  }
  for (const [name, binary] of wanted) symlinkSync(binary, path.join(dir, name));
}
