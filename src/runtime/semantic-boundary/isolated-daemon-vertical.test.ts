/** Run: npx tsx --test src/runtime/semantic-boundary/isolated-daemon-vertical.test.ts */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  ISOLATED_SESSION_ID,
  ISOLATED_UNSEEN_REQUEST,
  loadIsolatedProviderStore,
} from './isolated-vertical.js';

const CHILD = new URL('./isolated-daemon-child.mts', import.meta.url).pathname;

const CREDENTIAL_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COMPOSIO|OPENAI|ANTHROPIC|XAI|SLACK|DISCORD|WEBHOOK|API_KEY)/i;

function scrubbedEnv(home: string, port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_KEY.test(key)) continue;
    if (key.startsWith('CLEMENTINE_') || key.startsWith('CLEM_') || key.startsWith('CLEMMY_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: os.tmpdir(),
    CLEMENTINE_HOME: home,
    CLEMENTINE_ISOLATED_VERTICAL: '1',
    CLEMENTINE_ISOLATED_PORT: String(port),
    WEBHOOK_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    WEBHOOK_ALLOW_LAN: 'false',
    CLEMENTINE_MOBILE_APP_LISTENER: 'off',
    CLEMMY_HARNESS_CRON: 'off',
    CLEMMY_WORKFLOW_RUN_LANE: 'off',
    CLEMMY_MCP_PREWARM: 'off',
    CLEMMY_BOOT_WARMUP: 'off',
    CLEMMY_CLI_DISCOVERY_WARMUP: 'off',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    CLEMENTINE_GRAPH_LEASE_TTL_MS: '200',
    ...extra,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function killHard(child: ChildProcess): void {
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
}

function spawnDaemon(home: string, port: number, extra: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CHILD], {
    env: scrubbedEnv(home, port, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(path.dirname(CHILD), '../../..'),
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('wait timed out');
}

async function waitHealthy(port: number, child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`daemon exited before ready: ${child.exitCode} ${child.signalCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, timeoutMs);
}

async function postChat(port: number, input: string): Promise<{ status?: string; terminals?: number; error?: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return await response.json() as { status?: string; terminals?: number; error?: string };
}

function openDb(home: string): Database.Database {
  return new Database(path.join(home, 'state', 'harness.db'));
}

function terminalCount(home: string): number {
  try {
    return (openDb(home).prepare(
      `SELECT COUNT(*) AS n FROM events WHERE type = 'conversation_completed'`,
    ).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

// RETIRED (THE CLEAN LOOP, 2026-08-19): the ceremony-admitted typed vertical
// is not reachable from a live turn; crash-recovery of typed writes stays
// pinned at the executor level (typed-source-process-recovery kept pin,
// physical-authority restart pins). Original recoverable via git history for
// the workflow-replay seam.
