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

import type {
  BrainKind,
  BrainPlan,
  DaemonHandle,
  FusionProofMode,
  ProofModelExpectation,
  ProofModelProvider,
  TurnResult,
} from './types.js';
import { seedIsolatedClaudeAccess } from '../lib/isolated-claude-auth.js';

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

/** Copy only non-secret model selection. Provider credentials keep using the
 * existing per-brain paths below and are never printed or reported. */
function configuredModelEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'CLAUDE_MODEL', 'OPENAI_MODEL_FAST', 'OPENAI_MODEL_PRIMARY', 'OPENAI_MODEL_DEEP',
    'OPENAI_MODEL_WORKER', 'BYO_MODEL_ID', 'BYO_BRAIN_MODEL_ID', 'BYO_MODEL_JUDGE_ID',
    'BYO_MODEL_BASE_URL', 'BYO_MODEL_PROVIDER', 'BYO_PROVIDERS', 'BYO_PROVIDERS_JSON',
    'CLEMMY_MODEL_ROLES_REGISTRY', 'CLEMMY_MODEL_ROLES', 'CLEMMY_DEBATE_JUDGE',
    'CLEMMY_DEBATE_CHECKER_MODEL', 'CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL',
  ]) {
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  if (!env.BYO_PROVIDERS && env.BYO_PROVIDERS_JSON) env.BYO_PROVIDERS = env.BYO_PROVIDERS_JSON;
  return env;
}

function roleModel(env: Record<string, string>, role: 'worker' | 'judge'): string | undefined {
  if ((env.CLEMMY_MODEL_ROLES_REGISTRY ?? 'on').toLowerCase() === 'off') return undefined;
  try {
    const rows = JSON.parse(env.CLEMMY_MODEL_ROLES ?? '') as Array<{ role?: string; modelId?: string; whenIntent?: string }>;
    return rows.find((row) => row.role === role && row.modelId?.trim() && !row.whenIntent?.trim())?.modelId?.trim();
  } catch { return undefined; }
}

function withoutBrainRoleBindings(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const rows = JSON.parse(raw) as Array<{ role?: string }>;
    return JSON.stringify(rows.filter((row) => row?.role !== 'brain'));
  } catch { return raw; }
}

function providerFor(modelId: string, env: Record<string, string>): ProofModelProvider {
  const byoIds = [env.BYO_MODEL_ID, env.BYO_BRAIN_MODEL_ID, env.BYO_MODEL_JUDGE_ID];
  try {
    const rows = JSON.parse(env.BYO_PROVIDERS ?? '[]') as Array<{ modelIds?: string[] }>;
    byoIds.push(...rows.flatMap((row) => row.modelIds ?? []));
  } catch { /* bad registry is missing ownership evidence */ }
  if (byoIds.includes(modelId)) return 'byo'; // declared ownership beats gpt-shaped ids
  if (/claude|opus|sonnet|haiku/i.test(modelId)) return 'claude';
  return /^(?:gpt|o\d)|codex/i.test(modelId) ? 'codex' : 'byo';
}

function expectation(
  env: Record<string, string>,
  modelId: string,
  source: ProofModelExpectation['source'],
): ProofModelExpectation {
  return { modelId, provider: providerFor(modelId, env), source };
}

function roleExpectations(kind: BrainKind, env: Record<string, string>): {
  brain: ProofModelExpectation;
  worker: ProofModelExpectation;
  judge: ProofModelExpectation;
} {
  const brainSlot = kind === 'claude'
    ? env.CLAUDE_MODEL || ''
    : kind === 'glm'
      ? env.BYO_BRAIN_MODEL_ID || env.BYO_MODEL_ID || ''
      : providerFor(env.OPENAI_MODEL_PRIMARY || '', env) === 'codex'
        ? env.OPENAI_MODEL_PRIMARY || ''
        : '';
  const brain = expectation(env, brainSlot, 'provider-slot');
  const workerBinding = roleModel(env, 'worker');
  const worker = expectation(env, workerBinding || brainSlot, workerBinding ? 'role-binding' : 'provider-slot');
  const judgeBinding = roleModel(env, 'judge');
  const judgeSlot = kind === 'glm'
    ? env.BYO_MODEL_JUDGE_ID || env.BYO_MODEL_ID || ''
    : (env.CLEMMY_DEBATE_JUDGE ?? 'claude').toLowerCase() === 'codex'
      ? (env.OPENAI_MODEL_PRIMARY || '')
      : (env.CLEMMY_DEBATE_CHECKER_MODEL || '');
  let judge = expectation(env, judgeBinding || judgeSlot, judgeBinding ? 'role-binding' : 'provider-slot');
  if (judge.provider === brain.provider && judge.modelId === brain.modelId) {
    const choice = (env.CLEMMY_DEBATE_JUDGE ?? 'claude').toLowerCase();
    if (choice === 'codex' && brain.provider !== 'codex') {
      judge = expectation(env, env.CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL || '', 'fusion-fallback');
    } else if (choice !== 'codex' && brain.provider !== 'claude') {
      judge = expectation(env, env.CLEMMY_DEBATE_CHECKER_MODEL || '', 'fusion-fallback');
    }
  }
  return { brain, worker, judge };
}

/**
 * Build the per-brain env. Missing auth material ⇒ skipReason (the matrix
 * reports SKIP, never FAIL — absence of a subscription isn't a regression).
 */
export function planBrain(kind: BrainKind): BrainPlan {
  const configured = configuredModelEnv();
  // Each matrix leg pins its requested provider lane while preserving the real
  // install's exact model slots and durable worker/judge role bindings. A
  // global brain binding is deliberately removed: it would make every matrix
  // label exercise the same provider instead of the requested brain.
  const proofRoles = withoutBrainRoleBindings(configured.CLEMMY_MODEL_ROLES);
  const selectionEnv = {
    ...configured,
    ...(proofRoles ? { CLEMMY_MODEL_ROLES: proofRoles } : {}),
    MODEL_ROUTING_MODE: kind === 'glm' ? 'all_in' : 'off',
  };
  const expected = roleExpectations(kind, selectionEnv);
  if (kind === 'claude') {
    const hasClaude = existsSync(path.join(REAL_HOME, '.claude'));
    return {
      kind,
      env: {
        ...selectionEnv,
        AUTH_MODE: 'claude_oauth',
        // Fan-out requires the full agentic profile (run_worker is full-mode-only).
        CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'full',
      },
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: hasClaude ? undefined : 'no ~/.claude (Claude Code OAuth) on this machine',
    };
  }
  if (kind === 'codex') {
    const hasCodex = existsSync(path.join(REAL_HOME, '.codex'));
    const apiKey = realEnvValue('OPENAI_API_KEY');
    if (hasCodex) {
      return {
        kind,
        env: { ...selectionEnv, AUTH_MODE: 'codex_oauth' },
        expectedBrain: expected.brain,
        expectedWorker: expected.worker,
        expectedFusionChecker: expected.judge,
      };
    }
    if (apiKey) {
      return {
        kind,
        env: { ...selectionEnv, AUTH_MODE: 'api_key', OPENAI_API_KEY: apiKey },
        expectedBrain: expected.brain,
        expectedWorker: expected.worker,
        expectedFusionChecker: expected.judge,
      };
    }
    return {
      kind,
      env: selectionEnv,
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: 'no ~/.codex and no OPENAI_API_KEY',
    };
  }
  // glm — BYO all-in brain. Copy only the BYO/GLM material the real install
  // uses. The canonical single-BYO config keys are BYO_MODEL_ID /
  // BYO_MODEL_API_KEY / BYO_MODEL_BASE_URL (what a real install writes);
  // BYO_BRAIN_MODEL_ID is accepted as a legacy alias.
  const byoModel = selectionEnv.BYO_MODEL_ID ?? selectionEnv.BYO_BRAIN_MODEL_ID;
  if (!byoModel) {
    return {
      kind,
      env: selectionEnv,
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: 'no BYO_MODEL_ID (or BYO_BRAIN_MODEL_ID) configured in the real home',
    };
  }
  const env = { ...selectionEnv, BYO_MODEL_ID: byoModel };
  for (const key of [
    'BYO_MODEL_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'OPENROUTER_API_KEY',
  ]) {
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  for (const id of byoProviderIdsFromRegistry(env.BYO_PROVIDERS)) {
    const key = byoProviderKeyEnvKey(id);
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  return {
    kind,
    env,
    expectedBrain: expected.brain,
    expectedWorker: expected.worker,
    expectedFusionChecker: expected.judge,
  };
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
  /** Default off. Dedicated live Fusion canaries opt into the mode under test. */
  fusionMode?: FusionProofMode;
}

/** Runtime policy pins that make every live proof leg comparable. Exported so
 * the self-test can catch an accidental re-enable before any model quota is
 * spent. */
export function proofRuntimeOverrides(fusionMode: FusionProofMode = 'off'): Record<string, string> {
  return {
    // A provider proof must fail on its selected brain, never look green
    // because a recovery lane silently served the turn.
    CLEMMY_BRAIN_FALLOVER: 'off',
    CLEMMY_AUTH_FALLOVER: 'off',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_LEGACY_RESPOND_FALLBACK: 'off',
    CLEMMY_ROUTE_POLICY: 'off',
    // The release matrix defaults Fusion off. A dedicated cross-model canary
    // may opt in explicitly while unrelated judge/fallover seams stay frozen.
    CLEMMY_DEBATE_MODE: fusionMode,
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
export function proofProcessIsolationEnv(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const base = {
    HOME: home,
    ZDOTDIR: home,
  };
  if (platform !== 'win32') return base;
  const parsed = path.win32.parse(home);
  return {
    ...base,
    USERPROFILE: home,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(Math.max(0, parsed.root.length - 1)),
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

/** Toolkits whose proof-only CLI defaults are explicitly operator-authorized
 * inside the disposable home. This is deliberately the same durable store
 * production Connect writes — never an environment-variable bypass. */
export const PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS = [
  'proof',
  'proofapp',
  'gmail',
  'instagram',
  'googlesheets',
] as const;

export function seedProofComposioDefaultAccountAuthorities(home: string): string {
  const stateDir = path.join(home, 'state');
  const file = path.join(stateDir, 'composio-cli-default-accounts.json');
  const grantedAt = new Date().toISOString();
  const grants = Object.fromEntries(
    PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS.map((toolkit) => [
      toolkit,
      {
        kind: 'composio_cli_default_account',
        toolkit,
        label: `isolated-proof ${toolkit} default`,
        grantId: `proof-cli-default-${toolkit}`,
        grantedAt,
        grantedBy: 'proof-harness',
      },
    ]),
  );
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try { chmodSync(file, 0o600); } catch { /* best-effort on Windows */ }
  return file;
}

/** A local-only Composio lane for capability recovery proofs. It begins
 * unauthenticated. Creating $HOME/proof-composio-connected makes `whoami` and
 * `execute` succeed. Every execute keeps the legacy slug-only log and also
 * appends `{slug,payload}` JSONL to a proof-local payload log. The
 * latter is deliberately written by the provider shim, not inferred from
 * harness telemetry, so an exact-once proof can compare the bytes that actually
 * crossed the last local dispatch boundary without reaching a real account. */
export function createProofComposioShim(home: string): string {
  const bin = path.join(home, 'proof-bin');
  mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'composio-proof.cjs');
  const body = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const home = process.env.HOME || process.env.USERPROFILE;",
    "if (!home) { console.error('proof home missing'); process.exit(1); }",
    "const [command, slug, flag, payload = ''] = process.argv.slice(2);",
    "const state = path.join(home, 'proof-composio-connected');",
    "const sheetsStatePath = path.join(home, 'proof-googlesheets-state.json');",
    "const sheetsReceiptLog = path.join(home, 'proof-googlesheets-receipts.log');",
    "const sheetsOperationLog = path.join(home, 'proof-googlesheets-operations.log');",
    "const sheetHeaders = ['fingerprint','source_receipt_id','purchased_on','merchant','amount','currency','tax','category','category_scope','source_uri','captured_at','evidence_note'];",
    "const appendKeys = ['includeValuesInResponse','insertDataOption','majorDimension','range','spreadsheetId','valueInputOption','values'];",
    "const readKeys = ['range','spreadsheet_id'];",
    "const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));",
    "const exactKeys = (value, expected) => plainObject(value) && Object.keys(value).sort().join('\\n') === [...expected].sort().join('\\n');",
    "const readJson = (file, fallback) => { try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); return plainObject(parsed) ? parsed : fallback; } catch { return fallback; } };",
    "const writeJsonAtomic = (file, value) => { const temp = file + '.tmp-' + process.pid; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\\n', 'utf8'); fs.renameSync(temp, file); };",
    "const parsePayload = () => { try { const parsed = JSON.parse(payload); if (!plainObject(parsed)) throw new Error('payload must be an object'); return parsed; } catch (error) { console.error('invalid JSON payload: ' + (error && error.message ? error.message : String(error))); process.exit(2); } };",
    "const sheetKey = (spreadsheetId, range) => spreadsheetId + '\\n' + range;",
    "const appendSheetOperation = (record) => fs.appendFileSync(sheetsOperationLog, JSON.stringify(record) + '\\n', 'utf8');",
    "if (command === '--version') { console.log('composio-proof 1.0'); process.exit(0); }",
    "if (command === 'whoami') {",
    "  if (fs.existsSync(state)) { console.log('proof-user'); process.exit(0); }",
    "  console.error('Not authenticated.'); process.exit(1);",
    "}",
    "if (command === 'execute') {",
    "  if (!fs.existsSync(state)) { console.error('401 Unauthorized.'); process.exit(1); }",
    "  if (!slug || flag !== '-d') { console.error('invalid proof execute arguments'); process.exit(1); }",
    "  fs.appendFileSync(path.join(home, 'proof-composio-dispatches.log'), slug + '\\n', 'utf8');",
    "  fs.appendFileSync(path.join(home, 'proof-composio-payloads.log'), JSON.stringify({ slug, payload }) + '\\n', 'utf8');",
    "  if (slug === 'PROOF_TASKS_LIST') {",
    "    const args = parsePayload();",
    "    if (!exactKeys(args, ['scope']) || args.scope !== 'isolated-proof') {",
    "      console.error('invalid proof task-list payload: use exactly {\"scope\":\"isolated-proof\"}');",
    "      process.exit(2);",
    "    }",
    "    console.log(JSON.stringify({ successful: true, data: { tasks: [{ id: 'proof-task-1', title: 'Review the Clementine release proof', status: 'open' }], count: 1, generated_at: '2026-07-29T00:00:00.000Z' } }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'PROOF_SOCIAL_GET_CONTENT_PLAN') {",
    "    console.log(JSON.stringify({ successful: true, data: [{ sourceMarker: 'SOCIAL_SOURCE:PROOF_ONLY', brand: 'Juniper Vale Coffee', handle: '@junipervale', campaign: 'Rainy Day Roast', offer: 'Complimentary oat-milk upgrade on August 14', hashtag: '#RainyDayRoast' }] }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND') {",
    "    const args = parsePayload();",
    "    const validRows = Array.isArray(args.values) && args.values.length === 1 && Array.isArray(args.values[0]) && args.values[0].length === sheetHeaders.length;",
    "    if (!exactKeys(args, appendKeys) || typeof args.spreadsheetId !== 'string' || !args.spreadsheetId || typeof args.range !== 'string' || !args.range || args.valueInputOption !== 'RAW' || args.majorDimension !== 'ROWS' || args.insertDataOption !== 'INSERT_ROWS' || args.includeValuesInResponse !== true || !validRows) {",
    "      console.error('invalid Sheets append payload: use the exact camelCase keys spreadsheetId, range, valueInputOption, majorDimension, insertDataOption, includeValuesInResponse, values; values must contain exactly one 12-cell row');",
    "      process.exit(2);",
    "    }",
    "    const sheetsState = readJson(sheetsStatePath, { version: 1, sheets: {} });",
    "    if (!plainObject(sheetsState.sheets)) sheetsState.sheets = {};",
    "    const key = sheetKey(args.spreadsheetId, args.range);",
    "    const prior = plainObject(sheetsState.sheets[key]) && Array.isArray(sheetsState.sheets[key].rows) ? sheetsState.sheets[key] : { spreadsheetId: args.spreadsheetId, range: args.range, rows: [sheetHeaders] };",
    "    const row = args.values[0].map((cell) => cell == null ? '' : String(cell));",
    "    prior.rows.push(row);",
    "    sheetsState.sheets[key] = prior;",
    "    writeJsonAtomic(sheetsStatePath, sheetsState);",
    "    const ordinal = prior.rows.length - 1;",
    "    const receiptId = 'proof-sheets-' + crypto.createHash('sha256').update(JSON.stringify({ spreadsheetId: args.spreadsheetId, range: args.range, row, ordinal })).digest('hex').slice(0, 20);",
    "    const receipt = { id: receiptId, slug, spreadsheetId: args.spreadsheetId, range: args.range, rowCount: 1, fingerprint: row[0] || null, ordinal };",
    "    fs.appendFileSync(sheetsReceiptLog, JSON.stringify(receipt) + '\\n', 'utf8');",
    "    appendSheetOperation({ operation: 'append', ...receipt });",
    "    console.log(JSON.stringify({ successful: true, data: { spreadsheetId: args.spreadsheetId, tableRange: args.range, proofReceipt: receipt, updates: { spreadsheetId: args.spreadsheetId, updatedRange: args.range, updatedRows: 1, updatedColumns: row.length, updatedCells: row.length, updatedData: { range: args.range, majorDimension: 'ROWS', values: [row] } } } }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'GOOGLESHEETS_VALUES_GET') {",
    "    const args = parsePayload();",
    "    if (!exactKeys(args, readKeys) || typeof args.spreadsheet_id !== 'string' || !args.spreadsheet_id || typeof args.range !== 'string' || !args.range) {",
    "      console.error('invalid Sheets read payload: use exactly spreadsheet_id and range');",
    "      process.exit(2);",
    "    }",
    "    const sheetsState = readJson(sheetsStatePath, { version: 1, sheets: {} });",
    "    const key = sheetKey(args.spreadsheet_id, args.range);",
    "    const stored = plainObject(sheetsState.sheets) && plainObject(sheetsState.sheets[key]) && Array.isArray(sheetsState.sheets[key].rows) ? sheetsState.sheets[key].rows : [sheetHeaders];",
    "    const rows = stored.map((row) => Array.isArray(row) ? row.map((cell) => cell == null ? '' : String(cell)) : []);",
    "    appendSheetOperation({ operation: 'read', slug, spreadsheetId: args.spreadsheet_id, range: args.range, rowCount: rows.length });",
    "    console.log(JSON.stringify({ successful: true, data: { spreadsheetId: args.spreadsheet_id, range: args.range, majorDimension: 'ROWS', values: rows } }));",
    "    process.exit(0);",
    "  }",
    "  console.log(JSON.stringify({ successful: true, data: { proof: true, receipt: 'proof-cli-1' } }));",
    "  process.exit(0);",
    "}",
    "console.error('unsupported proof composio command');",
    'process.exit(1);',
    '',
  ].join('\n');
  writeFileSync(shim, body, { encoding: 'utf-8', mode: 0o700 });
  try { chmodSync(shim, 0o700); } catch { /* best-effort on Windows */ }
  return shim;
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
  seedProofComposioDefaultAccountAuthorities(home);
  const codexAuth = path.join(REAL_CLEM_HOME, 'state', 'auth.json');
  if (existsSync(codexAuth)) copyFileSync(codexAuth, path.join(home, 'state', 'auth.json'));
  // Never copy a rotating Claude refresh token into a disposable home. A
  // refresh there would invalidate the real grant and strand the replacement
  // token in a directory we delete. Seed a currently-valid access token only.
  const claudeSeed = seedIsolatedClaudeAccess({
    targetHome: home,
    sourceClementineHome: REAL_CLEM_HOME,
    userHome: REAL_HOME,
  });
  if ((plan.kind === 'claude' || opts.fusionMode !== undefined && opts.fusionMode !== 'off') && !claudeSeed) {
    sanitizeProofHomeForForensics(home);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error('no currently-valid Claude subscription access token is available for the isolated proof');
  }
  const proofBin = createProofRailwayShim(home);
  const proofComposioShim = createProofComposioShim(home);

  const logChunks: string[] = [];
  const daemonEnv: NodeJS.ProcessEnv = {
    PATH: `${proofBin}${path.delimiter}${process.env.PATH ?? ''}`,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    ...proofProcessIsolationEnv(home),
    COMPOSIO_CLI_PATH: proofComposioShim,
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
    ...proofRuntimeOverrides(opts.fusionMode),
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
