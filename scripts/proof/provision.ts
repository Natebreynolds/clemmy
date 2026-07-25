/**
 * Proof-harness provisioning: boot one real daemon per brain against an
 * ISOLATED CLEMENTINE_HOME.
 *
 * Isolation contract (BINDING): the spawned daemon's BASE_DIR and HOME are the
 * same mkdtemp — memory.db / harness.db / state and every CLI config lookup live
 * there. Clementine's own model grants are copied into its isolated state
 * vault; no real-home CLI config (Railway, Composio, etc.) is visible.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import type { BrainKind, BrainPlan, DaemonHandle, TurnResult } from './types.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const DAEMON_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const REAL_HOME = os.homedir();
const REAL_CLEM_HOME = process.env.CLEMENTINE_HOME || path.join(REAL_HOME, '.clementine-next');

/** Parse a dotenv-ish file without importing any src/ module (BASE_DIR pinning). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function realEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  return readEnvFile(path.join(REAL_CLEM_HOME, '.env'))[key];
}

function byoProviderKeyEnvKey(providerId: string): string {
  const slug = providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `BYO_PROVIDER_${slug}_API_KEY`;
}

function byoProviderIdsFromRegistry(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(id) && id !== 'default');
  } catch {
    return [];
  }
}

/**
 * Build the per-brain env. Missing auth material ⇒ skipReason (the matrix
 * reports SKIP, never FAIL — absence of a subscription isn't a regression).
 */
export function planBrain(kind: BrainKind): BrainPlan {
  if (kind === 'claude') {
    const hasClaude = existsSync(path.join(REAL_HOME, '.claude'));
    return {
      kind,
      env: {
        AUTH_MODE: 'claude_oauth',
        CLAUDE_MODEL: realEnvValue('CLAUDE_MODEL') ?? '',
        // Fan-out requires the full agentic profile (run_worker is full-mode-only).
        CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'full',
      },
      skipReason: hasClaude ? undefined : 'no ~/.claude (Claude Code OAuth) on this machine',
    };
  }
  if (kind === 'codex') {
    const hasCodex = existsSync(path.join(REAL_HOME, '.codex'));
    const apiKey = realEnvValue('OPENAI_API_KEY');
    if (hasCodex) return { kind, env: { AUTH_MODE: 'codex_oauth' } };
    if (apiKey) return { kind, env: { AUTH_MODE: 'api_key', OPENAI_API_KEY: apiKey } };
    return { kind, env: {}, skipReason: 'no ~/.codex and no OPENAI_API_KEY' };
  }
  // glm — BYO all-in brain. Copy only the BYO/GLM material the real install
  // uses. The canonical single-BYO config keys are BYO_MODEL_ID /
  // BYO_MODEL_API_KEY / BYO_MODEL_BASE_URL (what a real install writes);
  // BYO_BRAIN_MODEL_ID is accepted as a legacy alias.
  const byoModel = realEnvValue('BYO_MODEL_ID') ?? realEnvValue('BYO_BRAIN_MODEL_ID');
  if (!byoModel) return { kind, env: {}, skipReason: 'no BYO_MODEL_ID (or BYO_BRAIN_MODEL_ID) configured in the real home' };
  const env: Record<string, string> = { MODEL_ROUTING_MODE: 'all_in', BYO_MODEL_ID: byoModel };
  for (const key of [
    'BYO_MODEL_API_KEY', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_JUDGE_ID', 'BYO_MODEL_PROVIDER',
    'ZHIPU_API_KEY', 'GLM_API_KEY', 'OPENROUTER_API_KEY',
  ]) {
    const v = realEnvValue(key);
    if (v) env[key] = v;
  }
  const registry = realEnvValue('BYO_PROVIDERS') ?? realEnvValue('BYO_PROVIDERS_JSON');
  if (registry) {
    env.BYO_PROVIDERS = registry;
    for (const id of byoProviderIdsFromRegistry(registry)) {
      const key = byoProviderKeyEnvKey(id);
      const v = realEnvValue(key);
      if (v) env[key] = v;
    }
  }
  return { kind, env };
}

async function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const settle = (ok: boolean) => { try { sock.destroy(); } catch { /* closed */ } resolve(ok); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

export interface ProvisionOptions {
  /** Keep the temp home on stop (forensics). Failed scenarios set this. */
  keepHome?: boolean;
  bootTimeoutMs?: number;
}

/** Runtime policy pins that make every live proof leg comparable. Exported so
 * the self-test can catch an accidental re-enable before any model quota is
 * spent. */
export function proofRuntimeOverrides(): Record<string, string> {
  return {
    // A provider proof must fail on its selected brain, never look green
    // because a recovery lane silently served the turn.
    CLEMMY_BRAIN_FALLOVER: 'off',
    CLEMMY_AUTH_FALLOVER: 'off',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_LEGACY_RESPOND_FALLBACK: 'off',
    CLEMMY_ROUTE_POLICY: 'off',
    // Freeze every model-judge/fusion branch. Deterministic safety gates remain.
    CLEMMY_DEBATE_MODE: 'off',
    CLEMMY_FUSION_STRATEGY: 'verify',
    CLEMMY_JUDGE_CROSS_FAMILY: 'off',
    // Proof scenarios need the durable task to start on the explicit
    // `/background` request. The optional conversational approach beat is a
    // product UX choice, not part of background execution correctness.
    CLEMMY_LONGTASK_APPROACH_BEAT: 'off',
  };
}

/** Process-level isolation shared by the daemon and every shell it spawns.
 * ZDOTDIR prevents a login shell from sourcing the real user's dotfiles and
 * replacing the proof PATH or re-exposing authenticated CLI configuration. */
export function proofProcessIsolationEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    ZDOTDIR: home,
  };
}

function createProofRailwayShim(home: string): string {
  const bin = path.join(home, 'proof-bin');
  mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, process.platform === 'win32' ? 'railway.cmd' : 'railway');
  const body = process.platform === 'win32'
    ? '@echo off\r\necho Unauthorized. Run railway login to authenticate. 1>&2\r\nexit /b 1\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "Unauthorized. Run railway login to authenticate." >&2\nexit 1\n';
  writeFileSync(shim, body, { encoding: 'utf-8', mode: 0o700 });
  try { chmodSync(shim, 0o700); } catch { /* best-effort on Windows */ }
  return bin;
}

/** Keep event/task state for a failed proof without retaining copied model
 * credentials or a generated webhook bearer. */
function sanitizeProofHomeForForensics(home: string): void {
  for (const relative of [
    path.join('state', 'auth.json'),
    path.join('state', 'claude-auth.json'),
    path.join('state', 'secrets-vault.json'),
    '.env',
  ]) {
    try { rmSync(path.join(home, relative), { force: true }); } catch { /* best effort */ }
  }
}

export async function provisionDaemon(plan: BrainPlan, opts: ProvisionOptions = {}): Promise<DaemonHandle> {
  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`dist/index.js missing — run \`npm run build\` first (${DAEMON_ENTRY})`);
  }
  const home = mkdtempSync(path.join(os.tmpdir(), `clemmy-proof-${plan.kind}-`));
  const port = 9600 + Math.floor(Math.random() * 300);
  const secret = randomBytes(16).toString('hex');

  // Isolation assertion: the temp home starts with NO state.
  if (existsSync(path.join(home, 'state'))) throw new Error('temp home unexpectedly pre-populated');

  // Seed ONLY Clementine's own model sign-in files (the runtime factory refuses
  // to boot without one — "Run clementine auth login-device"). Deliberately NOT
  // the secrets vault: it carries Composio/API keys, and the sandbox must stay
  // physically unable to reach external services. Databases, memory and every
  // other state file start EMPTY: that's the isolation contract.
  mkdirSync(path.join(home, 'state'), { recursive: true });
  for (const authFile of ['auth.json', 'claude-auth.json']) {
    const src = path.join(REAL_CLEM_HOME, 'state', authFile);
    if (existsSync(src)) copyFileSync(src, path.join(home, 'state', authFile));
  }
  const proofBin = createProofRailwayShim(home);

  const logChunks: string[] = [];
  const daemonEnv: NodeJS.ProcessEnv = {
    PATH: `${proofBin}${path.delimiter}${process.env.PATH ?? ''}`,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    ...proofProcessIsolationEnv(home),
    CLEMENTINE_HOME: home,
    WEBHOOK_PORT: String(port),
    WEBHOOK_SECRET: secret,
    WEBHOOK_ENABLED: 'true',
    // Exercise production runtime branches. Isolation comes from the disposable
    // CLEMENTINE_HOME and missing connected-app secrets, not from test-only
    // behavior that can hide telemetry or swap persistence implementations.
    NODE_ENV: 'production',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    ...plan.env,
    ...proofRuntimeOverrides(),
  };

  let proc: ChildProcess;
  const spawnDaemon = (): ChildProcess => {
    logChunks.push(`\n[proof] spawning daemon at ${new Date().toISOString()}\n`);
    const child = spawn(process.execPath, [DAEMON_ENTRY, 'service'], {
      cwd: home,
      env: daemonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b) => logChunks.push(String(b)));
    child.stderr?.on('data', (b) => logChunks.push(String(b)));
    return child;
  };
  const terminateDaemon = async (): Promise<void> => {
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 750))]);
    }
  };
  const waitForReady = async (): Promise<void> => {
    const deadline = Date.now() + (opts.bootTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`daemon exited during boot (code ${proc.exitCode})\n${logChunks.join('').slice(-2000)}`);
      }
      if (await tcpProbe(port)) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) return;
        } catch { /* still warming */ }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`daemon not ready within boot timeout\n${logChunks.join('').slice(-2000)}`);
  };

  proc = spawnDaemon();
  try {
    await waitForReady();
  } catch (error) {
    await terminateDaemon();
    sanitizeProofHomeForForensics(home);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

  const chat = async (message: string, sessionId: string, timeoutMs = 600_000): Promise<TurnResult> => {
    const started = Date.now();
    // Node fetch (undici) kills any response whose HEADERS take >300s by
    // default — a real workspace-build/long-agent turn legitimately runs past
    // that, and the scenario died with a bare "fetch failed" (workspace-build,
    // 2026-07-03). Disable the per-phase timeouts; our AbortSignal owns the
    // wall clock.
    const { Agent } = await import('undici');
    const res = await fetch(`${baseUrl}/api/console/home/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, sessionId }),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-expect-error dispatcher is a Node-fetch (undici) extension
      dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
    });
    const wallMs = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as { text?: string; sessionId?: string; pendingApprovalId?: string };
    return {
      text: body.text ?? '',
      sessionId: body.sessionId ?? sessionId,
      pendingApprovalId: body.pendingApprovalId,
      wallMs,
      httpStatus: res.status,
    };
  };

  const approve = async (approvalId: string, decision: 'approve' | 'reject'): Promise<number> => {
    const res = await fetch(`${baseUrl}/api/console/harness-approvals/${encodeURIComponent(approvalId)}/${decision}`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
    return res.status;
  };

  const request = async (method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const restart = async (): Promise<void> => {
    await terminateDaemon();
    proc = spawnDaemon();
    await waitForReady();
  };

  const stop = async (stopOpts?: { keepHome?: boolean }): Promise<void> => {
    await terminateDaemon();
    const keepHome = Boolean(opts.keepHome || stopOpts?.keepHome);
    if (keepHome) {
      sanitizeProofHomeForForensics(home);
    } else {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };

  // log() is scoped to the CURRENT scenario: markLog() (called by the runner
  // between scenarios) advances the window so one early provider-back-pressure
  // burst can't fail the storm check of every scenario after it.
  let logMark = 0;
  const log = (): string => logChunks.join('').slice(logMark);
  const markLog = (): void => { logMark = logChunks.join('').length; };
  return { home, port, secret, baseUrl, chat, approve, request, log, markLog, restart, stop };
}
