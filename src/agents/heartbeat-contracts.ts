/**
 * What the owner has told each heartbeat, in their own words.
 *
 * A heartbeat reads on a cadence and raises items. The code decides what it
 * CAN notice; the owner decides what is worth their attention, and says so in
 * plain language: "skip anything from test or fixture workflows", "only tell
 * me about failures during work hours", "drafts can wait until the evening".
 * Those rules are stored here, per heartbeat, and applied by Jev on every
 * candidate item before it surfaces. Nothing here is a regex over a title; the
 * rules are read by a model, next to the item, and the answer is surface or
 * skip.
 *
 * The same store holds how a heartbeat's items reach the owner: quiet (in the
 * app's Needs you and Home, never pushed) or push (delivered like anything
 * else that needs an answer). Quiet is the default, so a new heartbeat can
 * never buzz a phone before the owner has seen what it produces.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export type HeartbeatNotifyMode = 'quiet' | 'push';

export interface HeartbeatRule {
  id: string;
  text: string;
  /** Who wrote it: the owner directly, or Clementine after the owner asked in chat. */
  by: 'owner' | 'clementine';
  createdAt: string;
}

export interface HeartbeatContract {
  id: string;
  notify: HeartbeatNotifyMode;
  rules: HeartbeatRule[];
  updatedAt: string;
}

interface ContractsFile {
  version: 1;
  contracts: Record<string, HeartbeatContract>;
}

const CONTRACTS_FILE = path.join(BASE_DIR, 'state', 'heartbeats.json');
const MAX_RULES = 24;
const MAX_RULE_CHARS = 400;

function emptyContract(id: string): HeartbeatContract {
  return { id, notify: 'quiet', rules: [], updatedAt: new Date(0).toISOString() };
}

function loadFile(): ContractsFile {
  if (!existsSync(CONTRACTS_FILE)) return { version: 1, contracts: {} };
  try {
    const raw = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf-8')) as Partial<ContractsFile>;
    const contracts: Record<string, HeartbeatContract> = {};
    for (const [id, value] of Object.entries(raw.contracts ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Partial<HeartbeatContract>;
      contracts[id] = {
        id,
        notify: v.notify === 'push' ? 'push' : 'quiet',
        rules: Array.isArray(v.rules)
          ? v.rules.filter((r): r is HeartbeatRule => !!r && typeof r === 'object' && typeof (r as HeartbeatRule).text === 'string' && typeof (r as HeartbeatRule).id === 'string')
          : [],
        updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date(0).toISOString(),
      };
    }
    return { version: 1, contracts };
  } catch {
    return { version: 1, contracts: {} };
  }
}

function saveFile(file: ContractsFile): void {
  const dir = path.dirname(CONTRACTS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${CONTRACTS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, CONTRACTS_FILE);
}

export function loadHeartbeatContract(id: string): HeartbeatContract {
  return loadFile().contracts[id] ?? emptyContract(id);
}

export function setHeartbeatNotify(id: string, notify: HeartbeatNotifyMode, now = new Date()): HeartbeatContract {
  const file = loadFile();
  const current = file.contracts[id] ?? emptyContract(id);
  file.contracts[id] = { ...current, notify, updatedAt: now.toISOString() };
  saveFile(file);
  return file.contracts[id];
}

export type AddHeartbeatRuleResult =
  | { ok: true; contract: HeartbeatContract; rule: HeartbeatRule }
  | { ok: false; reason: 'empty' | 'too_long' | 'too_many' | 'duplicate' };

/** Add one rule in the owner's words. The same sentence twice is one rule. */
export function addHeartbeatRule(id: string, text: string, by: HeartbeatRule['by'], now = new Date()): AddHeartbeatRuleResult {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'empty' };
  if (clean.length > MAX_RULE_CHARS) return { ok: false, reason: 'too_long' };
  const file = loadFile();
  const current = file.contracts[id] ?? emptyContract(id);
  if (current.rules.length >= MAX_RULES) return { ok: false, reason: 'too_many' };
  if (current.rules.some((r) => r.text.toLowerCase() === clean.toLowerCase())) return { ok: false, reason: 'duplicate' };
  const rule: HeartbeatRule = {
    id: `rule-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    text: clean,
    by,
    createdAt: now.toISOString(),
  };
  file.contracts[id] = { ...current, rules: [...current.rules, rule], updatedAt: now.toISOString() };
  saveFile(file);
  return { ok: true, contract: file.contracts[id], rule };
}

export function removeHeartbeatRule(id: string, ruleId: string, now = new Date()): HeartbeatContract | null {
  const file = loadFile();
  const current = file.contracts[id];
  if (!current || !current.rules.some((r) => r.id === ruleId)) return null;
  file.contracts[id] = { ...current, rules: current.rules.filter((r) => r.id !== ruleId), updatedAt: now.toISOString() };
  saveFile(file);
  return file.contracts[id];
}

/** The rules as a model reads them: numbered, in the owner's words. */
export function renderHeartbeatRules(contract: Pick<HeartbeatContract, 'rules'>): string[] {
  return contract.rules.map((r, i) => `${i + 1}. ${r.text}`);
}
