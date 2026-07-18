/**
 * Capability compounding — the skill distiller (C2).
 *
 * After a session figures something OUT (live tool discovery + a multi-step
 * sequence that succeeded), distill a reusable SKILL.md DRAFT so the capability
 * compounds instead of being re-derived next time. ONE distiller serves both
 * origins (a satisfied chat goal, a successful workflow run) because both are
 * the same substrate: an executed tool sequence read via readSessionTrace.
 *
 * Fire-and-forget: never a loop driver, never blocks the path that triggers it.
 * Gated by the master CLEMMY_GOAL_CONTRACT.
 *
 * Novelty gate (deterministic, BEFORE any LLM call): a routine execution — one
 * that purely ran an existing skill or a fully-specified workflow — distills
 * nothing. Only a session that did real discovery/trial-and-error qualifies.
 */
import pino from 'pino';
import { z } from 'zod';
import { Agent, Runner } from '@openai/agents';
import path from 'node:path';
import { getRuntimeEnv, MODELS } from '../config.js';
import { withFileLock } from '../runtime/atomic-json.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { isPackageRunnerMaterializationFailure } from '../runtime/shell-execution-outcome.js';
import { readSessionTrace, readSessionToolReturns, type TraceToolCall } from '../execution/trace-to-workflow.js';
import {
  SKILLS_DIR, ensureSkillsDir, loadSkill, writeDistilledSkill, isSafeSkillName,
  updateSkillFrontmatter, appendSkillPitfall, findDistilledSkillByCapabilityTask,
  claimSkillCapabilityFingerprint, capabilityTaskFingerprint, recordSkillCapabilityOrigin,
  type SkillOrigin,
} from './skill-store.js';
import { evidenceLooksFailedOrBlocked } from './tool-choice-store.js';
import { isTransientFailure } from './procedural-recall-link.js';
import { addNotification } from '../runtime/notifications.js';
import { consolidateFact } from './reflection.js';
import { recordMemoryEpisode } from './temporal-memory.js';

const logger = pino({ name: 'clementine-next.skill-distiller' });
const CAPABILITY_CLAIM_LOCK_FILE = path.join(SKILLS_DIR, '.capability-claim');

function distillerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Wave 2 Move B: on a quarantine (a proven-repeated failure), persist the lesson
 *  as a durable, recallable fact so it outlives the draft. Kill-switch =off. */
function failureLearningEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_FAILURE_LEARNING', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** PRECISE infra-transient detector for the durable-avoid-fact gate — anchored on
 *  infra-error PHRASINGS (HTTP status, "rate limited", "timed out", econn*), NOT
 *  bare prose tokens. The shared isTransientFailure matches bare "timeout" /
 *  "overloaded", which over-suppresses learning from a real bug whose reason merely
 *  mentions those words (e.g. "the timeout config was set wrong"). Used ONLY to
 *  decide whether to mint a permanent avoid-fact, so a false negative here just
 *  learns a fact (recoverable) rather than wrongly suppressing an approach forever. */
function isInfraTransientFailure(text: string): boolean {
  // 429/502/503/504 are unambiguously transient; 500 is excluded (often a real
  // server-side bug, and a bare "500" over-matches prose quantities).
  return /\b(?:429|502|503|504)\b|\brate[ -]?limit(?:ed|ing)?\b|\b(?:timed[ -]?out|etimedout|econnreset|econnrefused|enotfound)\b|\bconnection (?:reset|refused|timed out)\b|\bsocket hang up\b|\btemporarily unavailable\b|\bservice unavailable\b|\bserver (?:is )?overloaded\b/i.test(text);
}

/** A coarse tool "family" for the novelty gate (≥2 distinct ⇒ multi-system). */
function toolFamily(call: TraceToolCall): string {
  if (call.slug) return call.slug.split('_')[0].toLowerCase(); // composio toolkit
  return call.tool;
}

export interface NoveltyAssessment {
  novel: boolean;
  reason: string;
  substantiveCalls: number;
  families: number;
  hadDiscovery: boolean;
  hadCliRecovery: boolean;
}

interface CausalCliRecovery {
  identity: string;
  failedCall: TraceToolCall;
  successfulCall: TraceToolCall;
  failureEvidence: string;
  discoveryTools: string[];
}

function shellCommandFromArgs(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const command = obj.command ?? obj.cmd;
      if (typeof command === 'string') return command.trim();
    }
  } catch { /* legacy traces sometimes stored the raw command */ }
  return (args ?? '').trim();
}

function shellWords(command: string): string[] {
  return (command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) ?? [])
    .map((word) => word.replace(/^['"]|['"]$/g, '').replace(/[;&|]+$/g, ''))
    .filter(Boolean);
}

function normalizedCliIdentity(value: string): string {
  let token = value.trim().replace(/^['"]|['"]$/g, '');
  if (token.startsWith('@')) {
    const slash = token.lastIndexOf('/');
    const version = token.lastIndexOf('@');
    if (version > slash) token = token.slice(0, version);
  } else {
    token = token.replace(/@(?:latest|next|[~^]?\d[^/]*)$/i, '');
  }
  token = token.split('/').filter(Boolean).pop() ?? token;
  return token
    .toLowerCase()
    .replace(/\.(?:cmd|exe|js|mjs|cjs)$/i, '')
    .replace(/(?:-cli|_cli)$/i, '')
    .replace(/[^a-z0-9_.-]/g, '');
}

/** Resolve the provider CLI identity across package-runner and direct-binary
 * forms: `npx netlify-cli …` and `/resolved/.bin/netlify …` both become
 * `netlify`. This never executes or resolves a path. */
function cliIdentityForShellCall(call: TraceToolCall): string | null {
  if (call.tool !== 'run_shell_command') return null;
  const words = shellWords(shellCommandFromArgs(call.args));
  if (words.length === 0) return null;

  const runnerIndex = words.findIndex((word) => /^(?:npx|bunx)$/i.test(pathBasename(word)));
  if (runnerIndex >= 0) {
    const packageName = words.slice(runnerIndex + 1).find((word) => !word.startsWith('-'));
    return packageName ? normalizedCliIdentity(packageName) || null : null;
  }
  const managerIndex = words.findIndex((word) => /^(?:npm|pnpm|yarn)$/i.test(pathBasename(word)));
  if (managerIndex >= 0 && /^(?:exec|dlx)$/i.test(words[managerIndex + 1] ?? '')) {
    const packageName = words.slice(managerIndex + 2).find((word) => word !== '--' && !word.startsWith('-'));
    return packageName ? normalizedCliIdentity(packageName) || null : null;
  }

  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])
    || /^(?:env|sudo|command)$/i.test(pathBasename(words[index])))) index += 1;
  if (/^(?:node|bash|sh|zsh)$/i.test(pathBasename(words[index] ?? ''))) index += 1;
  const executable = words[index];
  return executable ? normalizedCliIdentity(executable) || null : null;
}

function pathBasename(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() ?? value;
}

function cliEvidenceFailed(text: string): boolean {
  return evidenceLooksFailedOrBlocked(text)
    || /\bexit(?:_| )?code\s*[:=]?\s*[1-9]\d*\b/i.test(text)
    || /\b(?:npm err!|could not determine executable|command not found|enoent|eacces|permission denied)\b/i.test(text)
    || /(?:^|\n)\s*(?:error|failed):/i.test(text);
}

function cliEvidenceSucceeded(text: string): boolean {
  if (!text.trim() || cliEvidenceFailed(text)) return false;
  return /\bexit(?:_| )?code\s*[:=]?\s*0\b/i.test(text)
    || /["']?(?:ok|success)["']?\s*:\s*true\b/i.test(text)
    || /\b(?:command )?(?:completed|succeeded|finished) successfully\b/i.test(text);
}

const PACKAGE_RUNNER_COMMAND_RE = /(?:^|[;&|]\s*)(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:npx(?:\s|$)|npm\s+exec(?:\s|$)|pnpm\s+(?:dlx|exec)(?:\s|$)|yarn\s+dlx(?:\s|$)|bunx(?:\s|$))/i;
const PACKAGE_RUNNER_NOT_FOUND_RE = /(?:^|\n)\s*(?:[^:\n]*\/)?(?:npx|npm|pnpm|yarn|bunx)(?::|\s).*\b(?:command not found|not found|enoent)\b/i;

function packageRunnerFailedBeforeProvider(command: string, evidence: string): boolean {
  return isPackageRunnerMaterializationFailure(command, evidence)
    || (PACKAGE_RUNNER_COMMAND_RE.test(command) && PACKAGE_RUNNER_NOT_FOUND_RE.test(evidence));
}

function shellExecutables(command: string): string[] {
  const executables: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const words = shellWords(segment);
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])
      || /^(?:env|sudo|command)$/i.test(pathBasename(words[index])))) index += 1;
    const executable = words[index];
    if (executable && !/^(?:cd|export)$/i.test(pathBasename(executable))) executables.push(executable);
  }
  return executables;
}

function isResolvedDirectCliCall(call: TraceToolCall, identity: string): boolean {
  if (call.tool !== 'run_shell_command') return false;
  const command = shellCommandFromArgs(call.args);
  if (PACKAGE_RUNNER_COMMAND_RE.test(command)) return false;
  return shellExecutables(command).some((executable) => executable.includes('/')
    && normalizedCliIdentity(executable) === identity);
}

function discoveryResolvedIdentity(
  call: TraceToolCall,
  identity: string,
  returnsByCallId: Map<string, string>,
): boolean {
  if (call.tool !== 'local_cli_list' && call.tool !== 'local_cli_probe') return false;
  const evidence = `${call.args}\n${returnsByCallId.get(call.callId) ?? ''}`.toLowerCase();
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_.-])${escaped}(?:$|[^a-z0-9_.-])`, 'i').test(evidence);
}

/** A CLI retry is reusable discovery only when the trace proves the whole
 * causal chain: non-transient failure, local CLI discovery, changed invocation
 * of the same CLI, and an explicit success result. Mere repeated shell calls do
 * not qualify. */
function findCausalCliRecovery(
  calls: TraceToolCall[],
  returnsByCallId: Map<string, string>,
): CausalCliRecovery | null {
  for (let failedIndex = 0; failedIndex < calls.length; failedIndex += 1) {
    const failedCall = calls[failedIndex];
    const identity = cliIdentityForShellCall(failedCall);
    if (!identity) continue;
    if (!PACKAGE_RUNNER_COMMAND_RE.test(shellCommandFromArgs(failedCall.args))) continue;
    const failureEvidence = returnsByCallId.get(failedCall.callId) ?? '';
    if (!cliEvidenceFailed(failureEvidence)
      || !packageRunnerFailedBeforeProvider(shellCommandFromArgs(failedCall.args), failureEvidence)
      || isTransientFailure(failureEvidence)) continue;

    for (let successIndex = failedIndex + 1; successIndex < calls.length; successIndex += 1) {
      const successfulCall = calls[successIndex];
      if (cliIdentityForShellCall(successfulCall) !== identity) continue;
      if (!isResolvedDirectCliCall(successfulCall, identity)) continue;
      if (shellCommandFromArgs(successfulCall.args) === shellCommandFromArgs(failedCall.args)) continue;
      const successEvidence = returnsByCallId.get(successfulCall.callId) ?? '';
      if (!cliEvidenceSucceeded(successEvidence)) continue;
      const discoveryTools = calls
        .slice(failedIndex + 1, successIndex)
        .filter((call) => discoveryResolvedIdentity(call, identity, returnsByCallId))
        .map((call) => call.tool);
      if (discoveryTools.length === 0) continue;
      return {
        identity,
        failedCall,
        successfulCall,
        failureEvidence,
        discoveryTools: [...new Set(discoveryTools)],
      };
    }
  }
  return null;
}

/**
 * Did this session figure something out worth keeping? Requires real work
 * (≥5 substantive calls), breadth (≥2 tool families), AND evidence of discovery
 * (a composio_search_tools call, the same slug retried with changed args, or a
 * proven CLI failure → local discovery → changed successful retry). A session
 * that just executed a known recipe fails the gate.
 */
export function assessNovelty(
  calls: TraceToolCall[],
  returnsByCallId: Map<string, string> = new Map(),
): NoveltyAssessment {
  const substantive = calls.filter((c) => c.tool && c.tool !== 'memory_think');
  const families = new Set(substantive.map(toolFamily));
  const searched = calls.some((c) => /search_tools|list_tools/.test(c.tool));
  // Trial-and-error: the SAME composio action slug invoked ≥2× with DIFFERENT
  // args — a corrected retry, i.e. something was figured out. Keyed on slug
  // only: reading/writing several different files is routine, not discovery.
  const bySlug = new Map<string, Set<string>>();
  for (const c of substantive) {
    if (!c.slug) continue;
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, new Set());
    bySlug.get(c.slug)!.add(c.args);
  }
  const retriedWithChange = [...bySlug.values()].some((argSet) => argSet.size >= 2);
  const cliRecovery = findCausalCliRecovery(calls, returnsByCallId);
  const hadDiscovery = searched || retriedWithChange || Boolean(cliRecovery);
  // A fully evidenced CLI recovery is already a dense discovery trajectory, so
  // it needs only the three causal calls (failure → discovery → success). The
  // ordinary heuristic retains its broader five-call threshold.
  const novel = cliRecovery
    ? substantive.length >= 3 && families.size >= 2
    : substantive.length >= 5 && families.size >= 2 && hadDiscovery;
  return {
    novel,
    reason: novel
      ? cliRecovery
        ? `session recovered ${cliRecovery.identity} through local CLI discovery`
        : 'session did multi-system discovery worth distilling'
      : `not novel (calls=${substantive.length}/${cliRecovery ? 3 : 5}, families=${families.size}/2, discovery=${hadDiscovery})`,
    substantiveCalls: substantive.length,
    families: families.size,
    hadDiscovery,
    hadCliRecovery: Boolean(cliRecovery),
  };
}

/** Compress a failed result into a one-line error SIGNATURE for a recovery tip:
 *  collapse whitespace, strip volatile ids/quotes, cap length. */
function errorSignature(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/["'`]/g, '').trim().slice(0, 120);
}

/**
 * Recovery procedure from a FAILED-then-CORRECTED trajectory (Lane D Phase 1).
 * Today only successes distill; this closes the asymmetry. When the SAME tool
 * slug was invoked ≥2× with DIFFERENT args (the assessNovelty trial-and-error
 * signal) AND an EARLIER invocation's RESULT looks failed/blocked, the later
 * call IS the figured-out recovery — so mint a tip keyed to the error signature
 * ("hit X → don't repeat; retry with corrected args"), not a flat "FAILED".
 *
 * Also recognizes a provider CLI that failed before/during local resolution,
 * was investigated with local_cli_list/local_cli_probe, and then succeeded via
 * a changed direct invocation. Returns null when there's no proven correction,
 * or when the failure is TRANSIENT (429/timeout/5xx). Pure: caller supplies
 * calls + results.
 */
export function deriveRecoveryTip(
  calls: TraceToolCall[],
  returnsByCallId: Map<string, string>,
): string | null {
  // Group invocations by slug, preserving order, with each call's result text.
  const bySlug = new Map<string, Array<{ args: string; result: string }>>();
  for (const c of calls) {
    if (!c.slug) continue; // composio actions only — the rot-prone, retry-worthy class
    const result = returnsByCallId.get(c.callId) ?? '';
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, []);
    bySlug.get(c.slug)!.push({ args: c.args, result });
  }
  for (const [slug, invocations] of bySlug) {
    if (invocations.length < 2) continue; // no retry → nothing was figured out
    const distinctArgs = new Set(invocations.map((i) => i.args));
    if (distinctArgs.size < 2) continue; // identical re-fire (a loop), not a corrected retry
    // An EARLIER invocation that genuinely failed/blocked (non-transient) and was
    // followed by a later attempt = the recovery we want to remember.
    for (let i = 0; i < invocations.length - 1; i += 1) {
      const failed = invocations[i].result;
      if (!evidenceLooksFailedOrBlocked(failed)) continue;
      if (isTransientFailure(failed)) continue; // a blip, not a lesson
      const sig = errorSignature(failed);
      if (!sig) continue;
      return `${slug}: hit "${sig}" — don't repeat the same call; retry with corrected args.`;
    }
  }
  const cli = findCausalCliRecovery(calls, returnsByCallId);
  if (cli) {
    const sig = errorSignature(cli.failureEvidence);
    return `${cli.identity}: hit "${sig}" — the package-runner invocation failed. Use local_cli_list/local_cli_probe to resolve the installed CLI, then invoke the resolved binary directly.`;
  }
  return null;
}

// Lane D Phase 2: slot-parameterize concrete IDs so a distilled procedure is
// reusable across clients/runs, and derive machine-checkable applicability.
//
// GLOBAL-ONLY by design: we reuse the entity REGEX CLASSES from memory-merge's
// extractAnchors (table/app ids, emails, domains) but DELIBERATELY NOT its
// hardcoded client-name patterns (Revill/Aldous/Scorpion/Market Leader) — those
// are user-specific and must never be baked into the global distiller (binding:
// "global, never user-specific").
const SLOT_RULES: Array<{ re: RegExp; slot: string }> = [
  { re: /tbl[a-zA-Z0-9]{12,}/g, slot: 'table_id' },
  { re: /app[a-zA-Z0-9]{12,}/g, slot: 'app_id' },
  // email BEFORE domain so the domain inside an address isn't separately slotted.
  { re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, slot: 'email' },
  { re: /\b[\w-]+\.(?:com|ai|io|org|net|co\.uk|dev)\b/gi, slot: 'domain' },
];

/** Replace concrete global entity ids with {{slot}} placeholders. Pure,
 *  deterministic, GLOBAL (no user-specific names). Returns the rewritten text +
 *  the distinct slot kinds found. */
export function slotParameterize(text: string): { text: string; slots: string[] } {
  let out = text ?? '';
  const slots = new Set<string>();
  for (const { re, slot } of SLOT_RULES) {
    const next = out.replace(re, `{{${slot}}}`);
    if (next !== out) slots.add(slot);
    out = next;
  }
  return { text: out, slots: [...slots] };
}

/** Coarse family for a proven tool: a composio UPPER_SNAKE slug → its toolkit
 *  prefix (GMAIL_SEND_EMAIL → gmail); any other tool → its lowercased name. */
function familyOfProvenTool(tool: string): string {
  const m = (tool ?? '').match(/^([A-Z][A-Z0-9]+)_/);
  return (m ? m[1] : tool ?? '').toLowerCase();
}

/** Machine-checkable applicability for a distilled procedure: which tool
 *  families it touches + which entity-class slots it is parameterized over. The
 *  retrieval filter (Phase 3) surfaces a procedure only when these match the
 *  live task. Pure. */
export function deriveApplicability(
  provenTools: Array<{ tool: string }>,
  entitySlots: string[],
): { toolFamilies: string[]; entitySlots: string[] } {
  const fams = new Set<string>();
  for (const t of provenTools) {
    const f = familyOfProvenTool(t.tool);
    if (f) fams.add(f);
  }
  return { toolFamilies: [...fams], entitySlots: [...new Set(entitySlots)] };
}

const DistilledSchema = z.object({
  name: z.string().min(3).max(60).describe('kebab-case skill name, e.g. "law-firm-seo-brief". No spaces.'),
  description: z.string().min(8).max(200).describe('One line: what this skill does and when to use it.'),
  requires: z.array(z.string()).max(8).describe('Prerequisites as mcp:<app> / cli:<bin> / secret:<KEY>. Empty if none.'),
  procedureMarkdown: z.string().min(40).describe('The reusable procedure as ordered markdown steps.'),
  provenTools: z.array(z.object({
    tool: z.string().describe('Harness tool or composio slug used.'),
    argsShape: z.string().describe('The argument SHAPE that worked (keys, not secret values).'),
    notes: z.string().nullable().describe('Any gotcha for this call.'),
  })).max(20).describe('The tool calls that were proven to work, in order.'),
  pitfalls: z.array(z.string()).max(8).describe('Mistakes encountered and how they were resolved.'),
});
export type DistilledSkill = z.infer<typeof DistilledSchema>;

function buildDistillerAgent(): Agent<unknown> {
  return new Agent({
    name: 'SkillDistiller',
    model: MODELS.fast,
    modelSettings: { reasoning: { effort: 'low' } },
    instructions: [
      'You distill a REUSABLE skill from a successful run. Output a SKILL.md draft that lets the agent repeat this capability next time without re-discovering it.',
      'Generalize: strip one-off specifics (this client, this date), keep the transferable procedure + the PROVEN tool slugs and argument SHAPES.',
      'Never include secret values (tokens, full emails/PII) — only argument keys/shapes.',
      'requires: list real prerequisites (mcp:/cli:/secret:) the procedure depends on. Empty array if none.',
      'Be concrete and short. This is a procedure to execute, not an essay.',
      'Return ONLY JSON with keys: name, description, requires, procedureMarkdown, provenTools, pitfalls.',
    ].join('\n'),
    tools: [],
  });
}

function parseDistilledSkillJson(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const candidate = extractJsonCandidate(value);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function cleanString(value: unknown, max = 1000): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function stringFromKeys(obj: Record<string, unknown>, keys: string[], max = 1000): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return cleanString(value, max);
    if (Array.isArray(value)) {
      const lines = value.map((v, i) => typeof v === 'string' ? `${i + 1}. ${cleanString(v, max)}` : '').filter(Boolean);
      if (lines.length > 0) return lines.join('\n').slice(0, max);
    }
  }
  return '';
}

function normalizeSkillName(value: unknown): string {
  return cleanString(value, 80)
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function stringArray(value: unknown, max: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\n|,/)
      : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = cleanString(item, 200);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeProvenTools(value: unknown): DistilledSkill['provenTools'] {
  const raw = Array.isArray(value) ? value : [];
  const out: DistilledSkill['provenTools'] = [];
  for (const item of raw) {
    if (out.length >= 20) break;
    if (typeof item === 'string') {
      const tool = cleanString(item, 120);
      if (tool) out.push({ tool, argsShape: '{}', notes: null });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const tool = stringFromKeys(obj, ['tool', 'slug', 'name', 'toolName'], 120);
    if (!tool) continue;
    let argsShape = stringFromKeys(obj, ['argsShape', 'argumentsShape', 'args', 'arguments', 'schema', 'input'], 500);
    if (!argsShape && obj.args && typeof obj.args === 'object') {
      argsShape = JSON.stringify(Object.keys(obj.args as Record<string, unknown>).sort());
    }
    out.push({
      tool,
      argsShape: argsShape || '{}',
      notes: stringFromKeys(obj, ['notes', 'note', 'gotcha', 'tip'], 240) || null,
    });
  }
  return out;
}

function sanitizeDistilledSkillOutput(value: unknown): DistilledSkill | null {
  const parsed = parseDistilledSkillJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const name = normalizeSkillName(obj.name ?? obj.title ?? obj.skillName);
  const description = stringFromKeys(obj, ['description', 'summary', 'whenToUse', 'when_to_use'], 200);
  const procedureMarkdown = stringFromKeys(obj, ['procedureMarkdown', 'procedure', 'steps', 'markdown', 'body'], 8000);
  const candidate: DistilledSkill = {
    name,
    description,
    requires: stringArray(obj.requires ?? obj.prerequisites, 8),
    procedureMarkdown,
    provenTools: sanitizeProvenTools(obj.provenTools ?? obj.tools ?? obj.toolCalls),
    pitfalls: stringArray(obj.pitfalls ?? obj.gotchas ?? obj.warnings, 8),
  };
  const checked = DistilledSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

export function _testOnly_sanitizeDistilledSkillOutput(value: unknown): DistilledSkill | null {
  return sanitizeDistilledSkillOutput(value);
}

function renderDistillerPrompt(input: {
  objective: string;
  evidence: string;
  calls: TraceToolCall[];
}): string {
  const seq = input.calls
    .slice(0, 40)
    .map((c, i) => `${i + 1}. ${c.slug ?? c.tool}  args=${c.args.slice(0, 300)}`)
    .join('\n');
  return [
    `OBJECTIVE that was accomplished:\n${input.objective}`,
    input.evidence ? `\nEVIDENCE / RESULT:\n${input.evidence.slice(0, 1500)}` : '',
    `\nTOOL SEQUENCE that was executed (in order):\n${seq}`,
    '\nDistill the reusable skill.',
  ].filter(Boolean).join('\n');
}

/** Never overwrite an unrelated same-named skill. The fingerprint suffix is
 * stable, so a retry of this exact task chooses the same collision-safe name. */
function availableDistilledSkillName(preferred: string, fingerprint: string): string {
  if (!loadSkill(preferred)) return preferred;
  const suffix = fingerprint.replace(/^cap-v\d+:/, '').slice(0, 8);
  const stem = preferred.slice(0, Math.max(3, 60 - suffix.length - 1)).replace(/-+$/g, '');
  let candidate = `${stem}-${suffix}`;
  let attempt = 2;
  while (loadSkill(candidate)) {
    const tail = `-${suffix}-${attempt}`;
    candidate = `${preferred.slice(0, Math.max(3, 60 - tail.length)).replace(/-+$/g, '')}${tail}`;
    attempt += 1;
  }
  return candidate;
}

export interface DistillResult {
  status: 'written' | 'skipped_not_novel' | 'skipped_duplicate' | 'skipped_disabled' | 'failed';
  name?: string;
  detail?: string;
}

/** Shared front door for manual distillation, satisfied chat goals, and
 * successful workflows. A legacy match is backfilled and the new source is
 * retained as lineage; trust/use counters stay owned by the harness boundary. */
function reuseExistingCapability(
  objective: string,
  origin?: Omit<SkillOrigin, 'distilledAt'>,
): DistillResult | null {
  if (!objective.trim()) return null;
  const match = findDistilledSkillByCapabilityTask(objective);
  if (!match) return null;
  if (match.legacy) claimSkillCapabilityFingerprint(match.skill.name, match.fingerprint);
  // Distillation is downstream of validated-success reinforcement in the chat
  // harness. Counting this lookup too would promote a draft twice for one run.
  // Preserve the new run/session as lineage evidence instead; counters remain
  // owned by reinforceDraftSkills at the validated execution boundary.
  if (origin) recordSkillCapabilityOrigin(match.skill.name, origin);
  return {
    status: 'skipped_duplicate',
    name: match.skill.name,
    detail: `reused existing capability "${match.skill.name}" (${match.fingerprint})`,
  };
}

async function reuseExistingCapabilityLocked(
  objective: string,
  origin?: Omit<SkillOrigin, 'distilledAt'>,
): Promise<DistillResult | null> {
  ensureSkillsDir();
  return withFileLock(CAPABILITY_CLAIM_LOCK_FILE, () => reuseExistingCapability(objective, origin));
}

interface DistilledCapabilityClaim {
  preferredName: string;
  description: string;
  body: string;
  objective: string;
  origin: Omit<SkillOrigin, 'distilledAt'>;
  applicability: { toolFamilies: string[]; entitySlots: string[] };
}

/**
 * Atomically claim one task fingerprint and write its draft. The initial
 * pre-LLM duplicate check is only an efficiency optimization; this locked
 * check is the correctness boundary. It serializes both concurrent turns in
 * one daemon and distillers running in separate Clementine processes.
 */
async function claimDistilledCapability(input: DistilledCapabilityClaim): Promise<DistillResult> {
  ensureSkillsDir();
  return withFileLock(CAPABILITY_CLAIM_LOCK_FILE, () => {
    const duplicate = reuseExistingCapability(input.objective, input.origin);
    if (duplicate) return duplicate;

    const fingerprint = capabilityTaskFingerprint(input.objective);
    const safeName = availableDistilledSkillName(input.preferredName, fingerprint);
    const name = writeDistilledSkill({
      name: safeName,
      description: input.description,
      body: input.body,
      origin: input.origin,
      capabilityTask: input.objective,
      applicability: input.applicability,
    });
    return name
      ? { status: 'written', name }
      : { status: 'failed', detail: 'write failed' };
  });
}

export async function _testOnly_claimDistilledCapability(
  input: DistilledCapabilityClaim,
): Promise<DistillResult> {
  return claimDistilledCapability(input);
}

export async function _testOnly_reuseExistingCapability(
  objective: string,
  origin?: Omit<SkillOrigin, 'distilledAt'>,
): Promise<DistillResult | null> {
  return reuseExistingCapabilityLocked(objective, origin);
}

/**
 * Distill a draft skill from a session's trace. `force` skips the novelty gate
 * (the manual "remember how to do this" front door). Best-effort: returns a
 * status, never throws.
 */
export async function distillSkillFromSession(
  sessionId: string,
  context: { objective: string; evidence?: string; origin: { kind: 'chat' | 'workflow' | 'manual'; sourceId?: string }; force?: boolean },
): Promise<DistillResult> {
  if (!distillerEnabled()) return { status: 'skipped_disabled' };
  try {
    const existing = await reuseExistingCapabilityLocked(context.objective, context.origin);
    if (existing) return existing;
    const calls = readSessionTrace(sessionId);
    const returnsByCallId = readSessionToolReturns(sessionId);
    if (!context.force) {
      const novelty = assessNovelty(calls, returnsByCallId);
      if (!novelty.novel) return { status: 'skipped_not_novel', detail: novelty.reason };
    }
    if (calls.length === 0) return { status: 'skipped_not_novel', detail: 'no tool calls in trace' };
    return distillFromCalls(calls, context, returnsByCallId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, sessionId }, 'skill distillation failed');
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The LLM + dedup + write core, shared by the chat and workflow entry points.
 *  Assumes the caller already passed the novelty gate (or force). */
async function distillFromCalls(
  calls: TraceToolCall[],
  context: { objective: string; evidence?: string; origin: { kind: 'chat' | 'workflow' | 'manual'; sourceId?: string } },
  returnsByCallId: Map<string, string> = new Map(),
): Promise<DistillResult> {
  try {
    if (calls.length === 0) return { status: 'skipped_not_novel', detail: 'no tool calls in trace' };

    const runner = new Runner({ workflowName: 'clementine-skill-distiller' });
    const result = await runner.run(
      buildDistillerAgent(),
      renderDistillerPrompt({ objective: context.objective, evidence: context.evidence ?? '', calls }),
      { maxTurns: 1 },
    );
    const draft = sanitizeDistilledSkillOutput((result as { finalOutput?: unknown }).finalOutput);
    if (!draft) return { status: 'failed', detail: 'distiller output did not parse' };
    if (!isSafeSkillName(draft.name)) return { status: 'failed', detail: `unsafe skill name: ${draft.name}` };

    const recoveryTip = deriveRecoveryTip(calls, returnsByCallId);
    if (recoveryTip && !draft.pitfalls.includes(recoveryTip)) draft.pitfalls.push(recoveryTip);

    // Lane D Phase 2: slot-parameterize concrete ids out of the procedure + each
    // proven call (global slots only), and derive applicability from the result.
    const allSlots = new Set<string>();
    const pm = slotParameterize(draft.procedureMarkdown);
    pm.slots.forEach((s) => allSlots.add(s));
    draft.procedureMarkdown = pm.text;
    draft.provenTools = draft.provenTools.map((t) => {
      const r = slotParameterize(t.argsShape);
      r.slots.forEach((s) => allSlots.add(s));
      return { ...t, argsShape: r.text };
    });
    const applicability = deriveApplicability(draft.provenTools, [...allSlots]);

    const claim = await claimDistilledCapability({
      preferredName: draft.name,
      description: draft.description,
      body: renderSkillBody(draft),
      objective: context.objective,
      origin: context.origin,
      applicability,
    });
    if (claim.status !== 'written' || !claim.name) return claim;
    const name = claim.name;

    try {
      addNotification({
        id: `skill-draft-${name}`,
        kind: 'system',
        title: `New draft skill: ${name}`,
        body: `I distilled a reusable skill from a successful run: ${draft.description}. It's usable now (marked draft); approve or discard from the Skills panel.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { skillName: name, tier: 'draft', origin: context.origin.kind },
      });
    } catch { /* suggestion is best-effort */ }

    logger.info({ name, origin: context.origin.kind }, 'distilled a draft skill');
    return { status: 'written', name };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, origin: context.origin.kind }, 'skill distillation failed');
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Workflow variant (C3): distill from the concatenated traces of a run's step
 * sessions. A wrong/empty session id simply contributes nothing, so the
 * novelty gate naturally skips a routine run. Fire-and-forget.
 */
export async function distillSkillFromSessions(
  sessionIds: string[],
  context: { objective: string; evidence?: string; sourceId?: string },
): Promise<DistillResult> {
  if (!distillerEnabled()) return { status: 'skipped_disabled' };
  try {
    const existing = await reuseExistingCapabilityLocked(context.objective, {
      kind: 'workflow', sourceId: context.sourceId,
    });
    if (existing) return existing;
    const calls = sessionIds.flatMap((id) => {
      try { return readSessionTrace(id); } catch { return []; }
    });
    const returnsByCallId = new Map<string, string>();
    for (const id of sessionIds) {
      try {
        for (const [callId, value] of readSessionToolReturns(id)) returnsByCallId.set(callId, value);
      } catch { /* one missing trace should not poison the combined run */ }
    }
    const novelty = assessNovelty(calls, returnsByCallId);
    if (!novelty.novel) return { status: 'skipped_not_novel', detail: novelty.reason };
    // Reuse the single-session path by faking a combined trace through a tiny
    // shim: write the calls onto a synthetic objective + run the same pipeline.
    return distillFromCalls(calls, {
      objective: context.objective,
      evidence: context.evidence ?? '',
      origin: { kind: 'workflow', sourceId: context.sourceId },
    }, returnsByCallId);
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Self-improvement (C4): reinforce the DRAFT skills that were loaded in a
 * session, based on whether that session ultimately succeeded. A draft only —
 * approved skills are never auto-demoted (the user blessed them).
 *  - success: useCount++, and promote to `approved` at 2 validated successes.
 *  - failure: failureCount++ + a dated pitfall line, and quarantine at 2.
 * Best-effort; only touches drafts, so a session with no loaded drafts is a
 * cheap no-op.
 */
export async function reinforceDraftSkills(
  skillNames: string[],
  outcome: 'success' | 'failure',
  reason?: string,
  sessionId?: string,
): Promise<void> {
  if (!distillerEnabled()) return;
  // On failure, prefer a STRUCTURED recovery tip mined from the session's
  // failed-then-corrected trajectory (error signature → corrective retry) over
  // the flat judge reason. Computed ONCE per call, shared across the drafts.
  let recoveryTip: string | null = null;
  if (outcome === 'failure' && sessionId) {
    try {
      recoveryTip = deriveRecoveryTip(readSessionTrace(sessionId), readSessionToolReturns(sessionId));
    } catch { /* best-effort — fall back to the flat reason */ }
  }
  for (const name of new Set(skillNames)) {
    try {
      const skill = loadSkill(name);
      if (!skill || skill.frontmatter.tier !== 'draft' || skill.frontmatter.quarantined) continue;
      const canonicalName = skill.name;
      if (outcome === 'success') {
        const useCount = (skill.frontmatter.useCount ?? 0) + 1;
        updateSkillFrontmatter(canonicalName, useCount >= 2 ? { useCount, tier: 'approved' } : { useCount });
      } else {
        const failureCount = (skill.frontmatter.failureCount ?? 0) + 1;
        const line = recoveryTip ?? (reason ? `FAILED: ${reason}` : 'FAILED (unspecified)');
        appendSkillPitfall(canonicalName, line.slice(0, 200));
        const quarantined = failureCount >= 2;
        updateSkillFrontmatter(canonicalName, quarantined ? { failureCount, quarantined: true } : { failureCount });
        // Wave 2 Move B: when an approach is QUARANTINED, persist the lesson as a
        // durable, deduped 'feedback' fact so it survives the draft's deletion AND
        // surfaces via unified recall on a future relevant turn. Quarantine itself
        // happens on ANY failure (unchanged baseline); only this PERMANENT,
        // auto-recalled avoid-fact is gated — because it can wrongly suppress a
        // valid approach every future turn (review). Mint ONLY when the failure is:
        //   (a) NOT a genuine infra transient — precise infra-phrasing match, not a
        //       bare 'timeout'/'overloaded' token, so a real bug whose reason merely
        //       mentions those words STILL learns; and
        //   (b) SUBSTANTIVE — a contentless "unspecified" failure teaches nothing and
        //       must not mint a permanent fact (closes the empty-reason blind spot).
        const substantive = Boolean(recoveryTip) || Boolean(reason && reason.trim());
        const infraTransient = isInfraTransientFailure(reason ?? '') || (!!recoveryTip && isInfraTransientFailure(recoveryTip));
        if (quarantined && substantive && !infraTransient && failureLearningEnabled()) {
          try {
            const evidenceSessionId = sessionId ?? 'skill-distiller';
            const callId = `skill-reinforce:${canonicalName}:${failureCount}`;
            const sourceUri = `clementine://skills/${encodeURIComponent(canonicalName)}/failure/${failureCount}`;
            // Persist the observed failure before deriving a durable lesson.
            // The claim must replay through this source episode, never through
            // a synthetic episode whose excerpt is merely the claim itself.
            recordMemoryEpisode({
              kind: 'reflection',
              sourceApp: 'Clementine skill distiller',
              sessionId: evidenceSessionId,
              callId,
              sourceUri,
              title: `Repeated failure evidence for ${canonicalName}`,
              content: line,
              metadata: { skill: canonicalName, failureCount, recoveryTip: Boolean(recoveryTip) },
            });
            await consolidateFact({
              kind: 'feedback',
              text: `Avoid repeating this: the "${canonicalName}" approach failed repeatedly and was retired. ${line}`.slice(0, 400),
              trustLevel: 0.6,
              authority: 'derived',
              sourceUri,
            }, {
              sessionId: evidenceSessionId,
              derivedFrom: { sessionId: evidenceSessionId, callId, tool: 'skill_reinforce' },
            });
          } catch { /* best-effort */ }
        }
      }
    } catch { /* reinforcement is best-effort */ }
  }
}

function renderSkillBody(d: DistilledSkill): string {
  const out: string[] = [d.procedureMarkdown.trim()];
  if (d.requires.length > 0) {
    out.push('', '## Requires', ...d.requires.map((r) => `- ${r}`));
  }
  if (d.provenTools.length > 0) {
    out.push('', '## Proven tool calls');
    for (const t of d.provenTools) {
      out.push(`- \`${t.tool}\` — args: ${t.argsShape}${t.notes ? ` (${t.notes})` : ''}`);
    }
  }
  if (d.pitfalls.length > 0) {
    out.push('', '## Pitfalls (observed)', ...d.pitfalls.map((p) => `- ${p}`));
  }
  return out.join('\n');
}

// Re-export for the trigger site to set the requires-vocab onto drafts.
export { loadSkill };
