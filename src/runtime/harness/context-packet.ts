import { existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getOpenAiApiKey } from '../../config.js';
import { getFocusSnapshot } from '../../memory/focus.js';
import {
  listActiveSkills,
  skillEligibleForAutomaticRecall,
} from '../../memory/skill-store.js';
import { listWorkflows } from '../../memory/workflow-store.js';
import { listWorkspaceProjects } from '../../tools/shared.js';
import { listMcpServerHealth, type MCPServerHealthSnapshot } from '../mcp-namespace-shim.js';
import { resolveMcpToolScope, type McpToolScope } from '../mcp-tool-scope.js';
import { pinnedCalendarRuleLabels } from './constraint-guard.js';
import { pitfallsForSkills } from './known-pitfalls.js';
import { listHarnessCapabilityHealth } from './capability-health.js';
import { renderAgentSystemGuidance, type AgentSystemGuidance } from '../agent-system-guidance.js';
import type { FanoutPosture } from '../../dashboard/agent-system-metrics.js';
import { tokenize } from '../../shared/workflow-scoring.js';
import {
  focusSummaryIsHistoricalForRequest,
  renderHistoricalFocusPointer,
} from './focus-projection.js';
import { classifyTurnIntent } from './turn-intent.js';
import {
  classifyTurnPreflight,
  confirmBeatDirective,
  recordTurnPreflightDecision,
} from './turn-control.js';
import {
  recordCapabilityResolution,
  renderCapabilityResolutionForContext,
  resolveTurnCapabilities,
  type CapabilityResolution,
} from './capability-resolution.js';
import {
  buildProspectiveIntentionContext,
  prospectiveCaptureDirective,
} from '../prospective-intentions.js';
import { standingRuleCaptureDirective } from '../../memory/rule-capture.js';
import {
  BATCH_RE,
  READ_RE,
  SEQUENCE_RE,
  WRITE_RE,
  detectMultiItemIntent,
  detectMultiItemIntentFromConversation,
  positiveActionSignalText,
  type MultiItemIntent,
} from './multi-item-intent.js';

export {
  detectMultiItemIntent,
  detectMultiItemIntentFromConversation,
  type MultiItemIntent,
} from './multi-item-intent.js';

export interface MemoryPrimerSummary {
  enabled: boolean;
  hitCount: number;
  source?: string | null;
  injected: boolean;
  skippedReason?: string | null;
}

export interface RankedContextCandidate {
  name: string;
  description: string;
  score: number;
  reason: string;
}

export interface AgentContextPacket {
  inputPreview: string;
  complexity: 'simple' | 'moderate' | 'complex';
  /** Shared "is this turn consequential" signal (turn-intent.ts). 'qa' turns
   *  skip the safe-to-skip preflight I/O (health probes, fan-out detection);
   *  capability hints (skills/workflows) are always kept. Advisory only. */
  turnIntent: 'qa' | 'action';
  memory: MemoryPrimerSummary;
  /** Relevance-gated future commitments. Empty on unrelated turns so durable
   * proactivity does not become another permanent prompt tax. */
  prospective: {
    injected: boolean;
    count: number;
    bytes: number;
    captureSuggested: boolean;
  };
  skills: RankedContextCandidate[];
  workflows: RankedContextCandidate[];
  /** Local project slash commands (proposal-builder's /seo-audit, …) whose
   *  names match the request — the project_run route to the REAL deliverable. */
  projectCommands: RankedContextCandidate[];
  toolScope: McpToolScope;
  mcp: Array<Pick<MCPServerHealthSnapshot, 'slug' | 'state' | 'toolCount' | 'failureCount' | 'lastError'>>;
  healthWarnings: string[];
  agentSystem: Pick<AgentSystemGuidance, 'injected' | 'recommendationCount' | 'recommendations' | 'policy'>;
  /**
   * Telemetry for the turn-start fan-out directive. `detected` = the pure
   * detector fired; `offered` = the directive was actually injected (detected
   * AND chat session AND flag on). Used to measure adherence lift.
   */
  multiItem: {
    detected: boolean;
    itemCount: number;
    offered: boolean;
    blockedByPolicy: boolean;
    fanoutPosture: FanoutPosture | 'unknown';
    recommendedWorkerWaveSize: number;
  };
  /** True when the conversational alignment beat was injected this turn. */
  confirmBeatOffered: boolean;
  /** The typed preflight phase this turn classified into. */
  preflightPhase: 'read' | 'align' | 'execute';
  /** Typed capability facts resolved for this ask (empty = no history). */
  capabilityResolution: CapabilityResolution;
  text: string;
}

const MAX_CANDIDATES = 3;
const LOW_DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const CRITICAL_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'for', 'from',
  'go', 'have', 'help', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'that', 'the', 'then', 'this', 'to', 'use', 'using', 'we', 'with', 'you',
  // Turn-shaping / output-format words are not skill or workflow intent.
  'clementine', 'exactly', 'json', 'key', 'local', 'not', 'only', 'return', 'single',
  // Transport/test scaffolding is not procedural intent. These tokens caused
  // disposable smoke prompts and URLs to outrank the user's actual task.
  'com', 'data', 'http', 'https', 'www', 'external', 'smoke', 'test', 'tests',
  'url', 'user', 'users',
  // Generic execution scaffolding describes almost every procedure and should
  // never be enough to select one ("first perform one read-back" matched image,
  // SEO-report, and redesign skills on a Google Sheets write).
  'after', 'back', 'before', 'complete', 'completed', 'create', 'created',
  'all', 'blocked', 'cell', 'cells', 'clem', 'deploy', 'deployed', 'deployment',
  'disposable', 'edit', 'existing',
  'fail', 'first', 'inert', 'last', 'matrix', 'modify', 'one', 'pass', 'perform',
  'performed', 'range', 'read', 'row', 'rows', 'sheet1',
  'update', 'updated', 'validate', 'validated', 'value', 'values', 'verification',
  'verify', 'verified', 'write', 'writes', 'writing', 'wrote',
  // Coordination vocabulary is ubiquitous across unrelated skills. It can
  // shape the current turn, but it is not evidence that a stored procedure is
  // relevant ("for each item, call a worker and return its output" previously
  // recalled skills whose only overlap was exactly that scaffolding).
  'call', 'calls', 'each', 'fanout', 'item', 'items', 'its', 'output', 'outputs',
  'every', 'parallel', 'ready', 'run', 'running', 'task', 'tasks', 'worker', 'workers',
]);

const DOMAIN_PATTERNS: RegExp[] = [
  /\bsalesforce|sf cli|soql|accounts?|leads?|contacts?|opportunit(?:y|ies)\b/i,
  /\bseo|ranking|rankings|serp|keyword|keywords|backlink|organic traffic|search visibility|dataforseo\b/i,
  /\boutlook|email|emails|drafts?|calendar|meeting invite\b/i,
  /\bgoogle sheets?|googlesheets?|spreadsheet|sheet row|worksheet\b/i,
  /\bwebsite|web page|webpage|scrape|crawl|browser|article|web search|look up online\b/i,
  /\blocal file|markdown|report|proposal|docx?|deck|pdf|workspace\b/i,
  /\bgithub|repo|repository|branch|commit|pull request|pr\b/i,
  /\bnetlify|vercel|railway|deploy|host\b/i,
];

function rankingSignalText(text: string): string {
  return positiveActionSignalText(text)
    // A URL or absolute filesystem path is task payload/provenance. Tokenizing
    // its host/path components ("users", "netlify", project names) made broad
    // artifact-generation skills appear relevant to an already-prepared deploy.
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/(^|[\s("'`])\/(?:[^/\s"'`]+\/)*[^/\s"'`]+/g, '$1 ')
    // Literal matrix values are payload, not procedural intent. A quoted
    // "email" header or a cell containing "report" must not summon an Outlook
    // or report-building skill.
    .replace(/\[\s*\[[\s\S]{0,12000}?\]\s*\]/g, ' structured_matrix ')
    // Precision replays often state explicitly that email-looking values are
    // inert payload. That safety boundary is not positive email intent and
    // must not summon a mail/data procedure.
    .replace(
      /\b(?:the\s+)?e-?mail[-\s](?:shaped|like)\s+(?:strings?|values?|fields?|data|payload)\s+(?:(?:are|is)\s+)?(?:inert|cell\s+data|payload\s+data)(?:\s+(?:cell|payload)\s+data)?\b/gi,
      ' structured_payload ',
    )
    // PASS/FAIL/BLOCKED is a smoke-result contract, not a request for a
    // reporting procedure.
    .replace(/\b(?:report|return|respond\s+with)\s+(?:only\s+)?(?:pass|fail|blocked)\b[^.!?\n]*/gi, ' result_status ');
}

/**
 * Build the size-aware fan-out line for the context packet. N>=8 gets an
 * imperative "do NOT serialize" + a one-line forEach-workflow suggestion (P2);
 * 3<=N<8 gets a soft offer that leaves the model's per-item judgment intact.
 */
export function fanoutDirectiveLine(intent: MultiItemIntent, waveSize = 8): string {
  const kind = intent.itemKind ? ` ${intent.itemKind}` : ' items';
  const n = intent.itemCount;
  const cappedWaveSize = Math.max(1, Math.min(8, Math.round(waveSize || 8)));
  if (n > 256) {
    return (
      `Fan-out directive: this turn names ${n} independent same-shape${kind}, above run_worker's 256-item structural limit. `
      + 'Use or author a durable workflow with forEach so the complete item universe, bounded concurrency, resume state, and per-item evidence are preserved. '
      + 'Do not send a partial subset to run_worker and do not report a subset as complete.'
    );
  }
  if (n >= 8 || intent.explicitParallelRequest) {
    return (
      `Fan-out directive: this turn names ${n} independent same-shape${kind} to process. `
      + 'Do NOT serialize them in this context — that balloons tokens and forces the harness to clip your freshly-fetched data mid-run. '
      + 'Resolve any shared tool/connection ONCE, then pick the lane by what each item needs: '
      + `if every item is the SAME shape of read/lookup, write ONE run_tool_program covering all ${n} and return only the distilled rows; `
      + `if each item needs its own multi-step work or large payloads, call run_worker with the full ${n}-item \`items\` array and a workManifest declaring that canonical universe (parallel waves of up to ${cappedWaveSize}); `
      + 'if you can bake every item\'s exact arguments now and they are writes, use run_batch. '
      + (n >= 8
        ? 'This is a large/recurring shape: after you finish, offer in ONE line to save it as a forEach workflow — do not create or run a workflow unless the user says yes.'
        : 'The user explicitly asked for parallel/same-shape execution, so do not drip these one at a time.')
    );
  }
  return (
    `Fan-out hint: this turn names ${n} independent same-shape${kind}. `
    + `If each item needs its own multi-step work or large payloads, fan out with run_worker (one per item, parallel waves of up to ${cappedWaveSize}) to keep this context lean. `
    + 'If they are same-shape lookups, cover them in ONE run_tool_program rather than calling the tool once per item.'
  );
}

function fanoutPolicyLine(intent: MultiItemIntent, guidance: AgentSystemGuidance): string {
  const policy = guidance.policy;
  const kind = intent.itemKind ? ` ${intent.itemKind}` : ' items';
  const n = intent.itemCount;
  if (!policy) return STATIC_PARALLELISM_LINE;
  return (
    `Fan-out constrained by coordination policy: this turn names ${n} independent same-shape${kind}, `
    + `but current mode is ${policy.mode} (${policy.status}, fanout ${policy.fanoutPosture}, wave size ${policy.recommendedWorkerWaveSize}). `
    + `${policy.nextAction} Keep work centralized or use only small explicit batches until the policy changes.`
  );
}

const STATIC_PARALLELISM_LINE =
  'Parallelism reminder: for independent batches, resolve shared tools/context once, then call run_worker with one structured packet per item in parallel or use an existing workflow forEach.';

const WORKFLOW_PARALLELISM_LINE =
  'Workflow parallelism: execute this node as one scoped unit. The runner owns topology; item-level parallel work must be represented by an authored forEach step or explicit sibling nodes before the run.';

/** Lighten pure-Q&A turns (skip health probes + fan-out detection). Validated
 *  behavior is the default; CLEMMY_LIGHT_QA_TURNS=off restores the full preflight. */
function lightQaTurnsEnabled(): boolean {
  return (process.env.CLEMMY_LIGHT_QA_TURNS ?? 'on').toLowerCase() !== 'off';
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function tokens(text: string): string[] {
  // Canonical tokenizer with this matcher's general-English stopword policy.
  // Repeated words must not multiply a candidate's score: one URL-heavy prompt
  // used "Google Sheet" several times and inflated broad draft skills above
  // the exact requested operation.
  return Array.from(new Set(
    tokenize(rankingSignalText(text), { minLen: 3, stopwords: STOPWORDS }),
  ));
}

function explicitlyNamesCandidate(input: string, name: string): boolean {
  const inputTokens = new Set(tokens(input));
  const nameTokens = tokens(name);
  return nameTokens.length > 0 && nameTokens.every((token) => inputTokens.has(token));
}

function classifyComplexity(input: string): AgentContextPacket['complexity'] {
  const text = input.trim();
  const actionText = positiveActionSignalText(text);
  const domains = DOMAIN_PATTERNS.reduce((count, pattern) => count + (pattern.test(actionText) ? 1 : 0), 0);
  const hasRead = READ_RE.test(actionText);
  const hasWrite = WRITE_RE.test(actionText);
  const hasBatch = BATCH_RE.test(actionText);
  const hasSequence = SEQUENCE_RE.test(actionText);
  if (domains >= 3 && (hasRead || hasWrite)) return 'complex';
  if (domains >= 2 && hasRead && hasWrite) return 'complex';
  if (domains >= 2 && hasBatch && hasSequence) return 'complex';
  if (text.length >= 300 && hasRead && hasWrite) return 'complex';
  if (domains >= 1 && (hasBatch || hasSequence || (hasRead && hasWrite))) return 'moderate';
  return 'simple';
}

function candidateScore(queryTokens: string[], fields: Array<{ text: string; weight: number }>): { score: number; matched: string[] } {
  const matched = new Set<string>();
  let score = 0;
  for (const token of queryTokens) {
    for (const field of fields) {
      const words = new Set(field.text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      const singular = token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
      const plural = token.length > 3 && !token.endsWith('s') ? `${token}s` : token;
      if (!words.has(token) && !words.has(singular) && !words.has(plural)) continue;
      matched.add(token);
      score += field.weight;
      // Exact lexical matches carry the second weight beat; singular/plural
      // normalization keeps "sheet"/"sheets" useful without substring noise
      // such as "read" matching "ready".
      if (words.has(token)) score += field.weight;
    }
  }
  return { score, matched: Array.from(matched).slice(0, 5) };
}

function rankSkills(
  input: string,
  opts: { includeSemanticallyMatchedDrafts?: boolean } = {},
): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  try {
    return listActiveSkills()
      .filter((skill) => (
        opts.includeSemanticallyMatchedDrafts
        || skillEligibleForAutomaticRecall(skill)
        || explicitlyNamesCandidate(input, skill.name)
      ))
      .map((skill) => {
        const description = skill.frontmatter.description || skill.bodyPreview || '';
        const { score, matched } = candidateScore(queryTokens, [
          { text: skill.name, weight: 5 },
          { text: skill.frontmatter.name, weight: 4 },
          { text: description, weight: 3 },
          { text: skill.bodyPreview, weight: 1 },
        ]);
        return {
          name: skill.name,
          description: `${skill.frontmatter.tier === 'draft' ? '[draft] ' : ''}${clip(description || '(no description)', 180)}`,
          score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
          matchCount: matched.length,
          draft: skill.frontmatter.tier === 'draft',
          explicitlyNamed: explicitlyNamesCandidate(input, skill.name),
        };
      })
      .filter((candidate) => candidate.score >= 8 && (
        candidate.matchCount >= 2 || explicitlyNamesCandidate(input, candidate.name)
      ) && (
        opts.includeSemanticallyMatchedDrafts
        || !candidate.draft
        || candidate.explicitlyNamed
      ))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES)
      .map(({ matchCount: _matchCount, draft: _draft, explicitlyNamed: _explicitlyNamed, ...candidate }) => candidate);
  } catch {
    return [];
  }
}

/** The pre-flight error-library line for a raw user input — rank the likely
 *  skills, pull their freshest pitfall lessons. Shared with the Claude brain
 *  lane, which does not consume the context packet (lane-parity export). */
export function knownPitfallLineForInput(input: string): string | null {
  try {
    // A self-distilled skill starts as a draft, so keep its full procedure out
    // of ambient context until explicitly requested—but do not suppress a
    // strongly matched failure lesson. Remembering what went wrong is lower
    // authority than executing an unproven procedure and is the core value of
    // this pre-flight seam.
    return pitfallsForSkills(
      rankSkills(input, { includeSemanticallyMatchedDrafts: true }).map((s) => s.name),
    );
  } catch {
    return null;
  }
}

function rankWorkflows(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  // Existing workflows are relevant only when the user is talking about a
  // reusable/recurring process or clearly asks to run one. Ad-hoc work is the
  // default; injecting similarly named smoke workflows into every one-off
  // request adds noise without granting capability.
  const workflowIntent =
    /\b(?:workflow|automation|automate|recurring|scheduled|schedule|daily|weekly|monthly|routine)\b/i.test(input)
    || /\b(?:run|start|launch|execute|kick\s+off)\b[^.!?\n]{0,80}\b(?:flow|routine|automation|workflow)\b/i.test(input);
  try {
    return listWorkflows()
      .map((entry) => {
        const data = entry.data;
        const description = data.whenToUse || data.description || data.description_body || '';
        const { score, matched } = candidateScore(queryTokens, [
          { text: entry.name, weight: 5 },
          { text: data.name, weight: 4 },
          { text: data.whenToUse ?? '', weight: 6 },
          { text: data.description, weight: 3 },
          { text: data.description_body ?? '', weight: 1 },
          { text: data.steps.map((step) => `${step.id} ${step.prompt}`).join('\n'), weight: 1 },
        ]);
        return {
          name: entry.name,
          description: `${data.enabled === false ? '[disabled] ' : ''}${clip(description || '(no description)', 200)}`,
          score: data.enabled === false ? Math.max(0, score - 2) : score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
          matchCount: matched.length,
        };
      })
      .filter((candidate) => candidate.score >= 8 && (
        candidate.matchCount >= 2 || explicitlyNamesCandidate(input, candidate.name)
      ) && (workflowIntent || explicitlyNamesCandidate(input, candidate.name)))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES)
      .map(({ matchCount: _matchCount, ...candidate }) => candidate);
  } catch {
    return [];
  }
}

const PROJECT_COMMANDS_INSTRUCTION = 'The user\'s local project already produces this deliverable with its own slash command, skills, and connected data. Offer to run it via project_run (one approval, runs in the background, you poll status and deliver the produced files). Do NOT rebuild the deliverable by hand in-loop when a matching project command exists.';

/** Project slash commands as deliverable routes. When the ask matches a
 *  command a project already implements (its own skills, MCP creds, and
 *  templates behind it), the honest answer is to DRIVE that project via
 *  project_run — an in-loop rebuild produces a lookalike, not the real
 *  deliverable. Matching is deliberately strict (two token hits or an
 *  explicit name) so unrelated turns pay zero prompt tax. */
function rankProjectCommands(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  try {
    const candidates: Array<RankedContextCandidate & { matchCount: number }> = [];
    for (const project of listWorkspaceProjects()) {
      for (const command of project.capabilities?.commands ?? []) {
        const { score, matched } = candidateScore(queryTokens, [
          { text: command.replace(/[-:]/g, ' '), weight: 6 },
          { text: project.name.replace(/[-]/g, ' '), weight: 3 },
          { text: project.description, weight: 2 },
        ]);
        if (score <= 0) continue;
        candidates.push({
          name: `/${command} in ${project.name}`,
          description: `project_run {"action":"start","project":"${project.name}","prompt":"/${command} <args>"} — runs the project's own command via the user's CLI.`,
          score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
          matchCount: matched.length,
        });
      }
    }
    return candidates
      .filter((candidate) => candidate.score >= 8 && (
        candidate.matchCount >= 2 || explicitlyNamesCandidate(input, candidate.name)
      ))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES)
      .map(({ matchCount: _matchCount, ...candidate }) => candidate);
  } catch {
    return [];
  }
}

/** Lane-parity export (same contract as knownPitfallLineForInput): the
 *  project-commands deliverable-route block for a raw user input, for lanes
 *  that do not consume the context packet (the Claude brain builds its turn
 *  context piecewise — live 07-30: an "seo audit" ask on the Claude brain
 *  got a hand-rolled in-loop audit because this section never reached it). */
export function projectCommandsLineForInput(input: string): string | null {
  try {
    const candidates = rankProjectCommands(input);
    if (candidates.length === 0) return null;
    return renderCandidates(
      'Project commands (the real deliverable route)',
      candidates,
      PROJECT_COMMANDS_INSTRUCTION,
    ).join('\n');
  } catch {
    return null;
  }
}

function existingBaseDir(): string {
  let cursor = BASE_DIR;
  while (cursor && cursor !== path.dirname(cursor)) {
    if (existsSync(cursor)) return cursor;
    cursor = path.dirname(cursor);
  }
  return process.cwd();
}

function diskHealthWarnings(): string[] {
  try {
    const stats = statfsSync(existingBaseDir());
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < CRITICAL_DISK_WARNING_BYTES) {
      return [`Critical local disk space: ${Math.round(freeBytes / 1024 / 1024)} MB free. State writes may fail.`];
    }
    if (freeBytes < LOW_DISK_WARNING_BYTES) {
      return [`Low local disk space: ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free. Long workflows may fail if tools create large files.`];
    }
  } catch {
    // Best-effort only.
  }
  return [];
}

function mcpHealth(): AgentContextPacket['mcp'] {
  try {
    return listMcpServerHealth()
      .filter((server) => server.state !== 'connected')
      .slice(0, 5)
      .map((server) => ({
        slug: server.slug,
        state: server.state,
        toolCount: server.toolCount,
        failureCount: server.failureCount,
        lastError: server.lastError ? clip(server.lastError, 160) : undefined,
      }));
  } catch {
    return [];
  }
}

function focusLine(input?: string, sessionId?: string): string | null {
  try {
    const focus = getFocusSnapshot();
    if (focus.active && !focus.needsConfirm) {
      if (focusSummaryIsHistoricalForRequest(focus.active, input, sessionId)) {
        return renderHistoricalFocusPointer(focus.active).replace(/\n/g, ' ');
      }
      return `Active focus: ${focus.active.title} — ${clip(focus.active.summary, 180)}`;
    }
    if (focus.active && focus.needsConfirm) return `Stale focus exists: ${focus.active.title}. Confirm before relying on it.`;
    if (focus.parked.length > 0) return `Parked resumable threads: ${focus.parked.slice(0, 3).map((p) => p.title).join('; ')}`;
  } catch {
    return null;
  }
  return null;
}

function renderCandidates(title: string, candidates: RankedContextCandidate[], instruction: string): string[] {
  if (candidates.length === 0) return [`${title}: none strongly matched.`];
  return [
    `${title}:`,
    ...candidates.map((candidate) =>
      `- ${candidate.name}: ${candidate.description}${candidate.reason ? ` (${candidate.reason})` : ''}`,
    ),
    instruction,
  ];
}

function summarizeToolScope(input: string): AgentContextPacket['toolScope'] {
  try {
    return resolveMcpToolScope({ userInput: input, pinnedCalendarLabels: pinnedCalendarRuleLabels() });
  } catch {
    return { reason: 'tool scope unavailable' };
  }
}

function harnessCapabilityHealthWarnings(limit = 3): string[] {
  try {
    return listHarnessCapabilityHealth()
      .slice(0, limit)
      .map((rec) => `Harness ${rec.id} is ${rec.state}${rec.reason ? `: ${rec.reason}` : ''}`);
  } catch {
    return [];
  }
}

/** Provider-access facts (live 2026-07-24): a run burned half an hour
 *  filesystem-hunting for an OpenAI API key that does not exist, asked the
 *  user for it twice, and never proposed the lane it already had (the OAuth
 *  model). The harness KNOWS these facts — state them up front. Names and
 *  presence only; never values. */
function providerAccessLine(): string {
  try {
    // The REAL accessor (secrets vault first, then env) — live 2026-07-24 the
    // key existed in the secrets vault for embeddings/voice while an env-only
    // check (and the model's filesystem hunt through the NOTES vault) said no.
    const hasRawOpenAI = Boolean(getOpenAiApiKey().trim());
    let byoLabels: string[] = [];
    try {
      const raw = (process.env.BYO_PROVIDERS ?? '').trim();
      if (raw) {
        byoLabels = (JSON.parse(raw) as Array<{ label?: string; id?: string }>)
          .map((p) => p.label || p.id || '')
          .filter(Boolean);
      }
    } catch { /* unparseable BYO list — omit labels */ }
    const openaiPart = hasRawOpenAI
      ? 'OpenAI: raw API key configured (harness secret store — reachable through harness config, NEVER print or export it) plus the connected OAuth model lane'
      : 'OpenAI: connected OAuth model lane ONLY — no raw API key is configured';
    const byoPart = byoLabels.length ? `BYO model providers: ${byoLabels.join(', ')}` : 'BYO model providers: none';
    return [
      'Provider access (harness facts — do NOT search the filesystem, vault, or env for API keys):',
      `${openaiPart}. ${byoPart}.`,
      'If a task seems to need a missing credential, say so plainly and propose the closest available lane',
      '(e.g. run model checks through the connected OAuth model) instead of searching or repeatedly asking.',
    ].join(' ');
  } catch {
    return '';
  }
}

export function buildAgentContextPacket(
  input: string,
  memory: MemoryPrimerSummary,
  opts?: { sessionKind?: string; sessionId?: string; sourceUserSeq?: number; suppressConfirmBeat?: boolean },
): AgentContextPacket {
  const complexity = classifyComplexity(input);
  // Pure-Q&A turns skip ONLY the health probes (disk + MCP I/O) — pure telemetry
  // that never changes what the model CAN do, so it's safe to drop on a question.
  // Everything that affects capability — skills, workflows, fan-out detection,
  // tool scope — is ALWAYS computed, so lightening can never drop a capability
  // hint (the regression that a narrow action-verb classifier would otherwise
  // risk). Honors a kill-switch; default-on. A continuation turn may classify
  // 'qa' and be lightened too — that's safe, since lightening drops ONLY
  // health-probe telemetry, never anything the turn's work depends on.
  const turnIntent: 'qa' | 'action' = classifyTurnIntent(input);
  const lightenQa = lightQaTurnsEnabled() && turnIntent === 'qa';
  // A workflow node already has a pinned graph, exact step prompt, allowed-tool
  // scope, upstream data, and (when authored) its explicit usesSkill body.
  // Ambient recall of similarly-worded skills/workflows is both redundant and
  // contaminating: live synthesis nodes were receiving Salesforce/SEO helpers
  // merely because their prompt contained generic words such as "manager" and
  // "report". Route only node-owned context here.
  const constrainedWorkflowNode = opts?.sessionKind === 'workflow';
  const skills = constrainedWorkflowNode ? [] : rankSkills(input);
  const workflows = constrainedWorkflowNode ? [] : rankWorkflows(input);
  const projectCommands = constrainedWorkflowNode ? [] : rankProjectCommands(input);
  const toolScope = summarizeToolScope(input);
  const mcp = lightenQa || constrainedWorkflowNode ? [] : mcpHealth();
  const healthWarnings = [
    ...harnessCapabilityHealthWarnings(),
    ...(lightenQa
      ? []
      : [
          ...diskHealthWarnings(),
          ...mcp.map((server) => `MCP ${server.slug} is ${server.state}${server.lastError ? `: ${server.lastError}` : ''}`),
        ]),
  ];
  const focus = focusLine(input, opts?.sessionId);
  const memoryLine = memory.enabled
    ? `Memory preflight: ${memory.hitCount} hit${memory.hitCount === 1 ? '' : 's'} via ${memory.source ?? 'local search'}${memory.injected ? ' and injected below' : ''}${memory.skippedReason ? ` (${memory.skippedReason})` : ''}.`
    : 'Memory preflight: disabled.';
  let prospective = { text: '', count: 0, ids: [] as string[], bytes: 0 };
  let prospectiveCapture: string | null = null;
  // Standing-rule capture steer (2026-07-31): a rule-shaped user statement
  // ("we ONLY use the sf CLI for Salesforce") must become a pinned constraint
  // at the moment it is said, not stay chat prose the next session forgets.
  // Deterministic detection, model-owned decision — same conditional pattern
  // as the prospective steer. Workflow nodes never capture rules.
  const ruleCapture = constrainedWorkflowNode ? null : standingRuleCaptureDirective(input);
  if (!constrainedWorkflowNode) {
    try {
      prospective = buildProspectiveIntentionContext({
        query: input,
        sessionId: opts?.sessionId,
      });
      prospectiveCapture = prospectiveCaptureDirective(input);
    } catch {
      // Future-intention projection is advisory context, never turn authority.
    }
  }

  // Turn-start fan-out directive (P0). Fires only for CHAT sessions. A workflow
  // step cannot restructure its active graph: forEach/sibling topology is an
  // authoring-time, runner-owned decision. Give that lane truthful guidance
  // instead of the chat reminder, which names a tool the step cannot call.
  // Other non-chat kinds retain the static line.
  // Fan-out detection always runs — a multi-item request ("research these 8
  // companies") has no action verb but is NOT light; dropping it would lose the
  // parallelism directive. Only the health probes (below) are safe to skip on qa.
  const multiItem = detectMultiItemIntent(input);
  const agentSystem = renderAgentSystemGuidance(input, opts?.sessionKind);
  const fanoutPosture = agentSystem.policy?.fanoutPosture ?? 'unknown';
  const recommendedWorkerWaveSize = agentSystem.policy?.recommendedWorkerWaveSize ?? 8;
  // The count-aware fan-out directive belongs to EVERY non-workflow lane.
  // It was chat-only, so a 30-item BACKGROUND task — the lane built for big
  // work — detected the 30 items, logged the detection, and then silently
  // withheld the one instruction that names the count and says "run_worker
  // with the full items array" (2026-08-04 efficiency audit; matches the
  // measured chat-runs-heavy-work-as-one-loop pattern). Workflow keeps its
  // own line; the policy block applies wherever the directive can fire.
  const fanoutLaneEligible = multiItem.isMultiItem && opts?.sessionKind !== 'workflow';
  const fanoutBlockedByPolicy = Boolean(
    fanoutLaneEligible &&
    agentSystem.policy &&
    (agentSystem.policy.fanoutPosture === 'block' || agentSystem.policy.fanoutPosture === 'constrain'),
  );
  const offerFanout = fanoutLaneEligible && !fanoutBlockedByPolicy;
  const parallelismLine = opts?.sessionKind === 'workflow'
    ? WORKFLOW_PARALLELISM_LINE
    : offerFanout
      ? fanoutDirectiveLine(multiItem, recommendedWorkerWaveSize)
      : fanoutBlockedByPolicy
        ? fanoutPolicyLine(multiItem, agentSystem)
        : STATIC_PARALLELISM_LINE;

  // TURN-CONTROL SPINE confirm beat: a fresh execution-shaped chat request
  // gets ONE conversational alignment beat before autonomous execution;
  // continuations, questions, pre-authorized hand-offs, and non-chat kinds
  // classify 'execute'/'read' and stay silent.
  // suppressConfirmBeat: the loop substitutes a goal OBJECTIVE for synthetic
  // continuation/retry inputs — the beat must only ever evaluate a REAL user
  // message, never a substituted one mid-run.
  const preflightDecision = opts?.suppressConfirmBeat
    ? { phase: 'execute', consequential: false, reason: 'ordinary_execution' } as const
    : classifyTurnPreflight({
        message: input,
        sessionId: opts?.sessionId,
        sessionKind: opts?.sessionKind,
        isMultiItem: multiItem.isMultiItem,
        itemCount: multiItem.itemCount,
        sourceUserSeq: opts?.sourceUserSeq,
      });
  // Persistence is execution authority, so write it only on a live chat turn
  // with the exact accepted source row. Pure previews/context probes frequently
  // pass a display-only session id; they do not dispatch tools and must not mint
  // orphan event rows. runTurn always supplies this exact source identity.
  if (
    !opts?.suppressConfirmBeat
    && opts?.sessionKind === 'chat'
    && Number.isSafeInteger(opts?.sourceUserSeq)
    && (opts?.sourceUserSeq ?? 0) > 0
  ) {
    recordTurnPreflightDecision(opts.sessionId, preflightDecision, opts.sourceUserSeq);
  }
  const confirmBeat = preflightDecision.phase === 'align'
    ? confirmBeatDirective({
        message: input,
        sessionId: opts?.sessionId,
        sessionKind: opts?.sessionKind,
        isMultiItem: multiItem.isMultiItem,
        itemCount: multiItem.itemCount,
        sourceUserSeq: opts?.sourceUserSeq,
      })
    : null;

  // Typed capability resolution: what THIS ask can already rely on, what has
  // failed before, what has no active connection — runtime facts as DATA.
  // Same chat-only persistence condition as the preflight decision.
  let capabilityResolution: CapabilityResolution = { entries: [], registryAvailable: false };
  let capabilityBlock = '';
  if (!constrainedWorkflowNode) {
    try {
      capabilityResolution = resolveTurnCapabilities(input);
      capabilityBlock = renderCapabilityResolutionForContext(capabilityResolution);
      if (
        opts?.sessionKind === 'chat'
        && Number.isSafeInteger(opts?.sourceUserSeq)
        && (opts?.sourceUserSeq ?? 0) > 0
        && opts.sessionId
      ) {
        recordCapabilityResolution(opts.sessionId, capabilityResolution, opts.sourceUserSeq);
      }
    } catch {
      capabilityBlock = '';
    }
  }

  const lines = [
    '[AGENT CONTEXT PACKET]',
    'This deterministic preflight ran before the model call. Use it to choose memory, skills, workflows, and tools instead of guessing.',
    `Complexity: ${complexity}.`,
    focus,
    memoryLine,
    prospective.text,
    prospectiveCapture,
    ruleCapture,
    `External MCP scope: ${toolScope.allowAll ? 'all external tools allowed' : `${(toolScope.allowedServerSlugs ?? []).join(', ') || 'none'}${toolScope.maxTools ? `, max ${toolScope.maxTools} tools` : ''}`} (${toolScope.reason}).`,
    providerAccessLine(),
    ...renderCandidates('Likely skills', skills, 'If one is relevant, call skill_read before creating the deliverable.'),
    // Pre-flight error library: the freshest distilled lessons for the skills
    // this turn will likely use — surfaced BEFORE acting so a known mistake
    // isn't repeated (they used to be reachable only via skill_read).
    pitfallsForSkills(skills.map((s) => s.name)),
    ...renderCandidates('Project commands (the real deliverable route)', projectCommands, PROJECT_COMMANDS_INSTRUCTION),
    ...renderCandidates('Likely workflows', workflows, 'Use these as reusable-process candidates. If the user asks to RUN/start/kick off something by name — even a loose one ("run my email flow", "kick off the prospect routine") — call workflow_run with their exact phrasing: the resolver matches it to the right saved workflow (or asks which) and confirms before anything runs, then it executes in the background and reports back here. Do NOT auto-run a workflow the user did not ask to run; for a task that merely resembles a saved workflow, do it directly and offer to save it as a workflow afterward.'),
    healthWarnings.length > 0 ? `Health warnings:\n${healthWarnings.map((w) => `- ${w}`).join('\n')}` : 'Health warnings: none.',
    agentSystem.text,
    parallelismLine,
    confirmBeat,
    capabilityBlock,
    'Approval reminder: batch related writes/sends under one clear approval with a preview whenever possible.',
  ].filter((line): line is string => Boolean(line));

  return {
    inputPreview: clip(input, 200),
    complexity,
    turnIntent,
    memory,
    prospective: {
      injected: prospective.count > 0,
      count: prospective.count,
      bytes: prospective.bytes,
      captureSuggested: Boolean(prospectiveCapture),
    },
    skills,
    workflows,
    projectCommands,
    toolScope,
    mcp,
    healthWarnings,
    agentSystem: {
      injected: agentSystem.injected,
      recommendationCount: agentSystem.recommendationCount,
      recommendations: agentSystem.recommendations,
      policy: agentSystem.policy,
    },
    multiItem: {
      detected: multiItem.isMultiItem,
      itemCount: multiItem.itemCount,
      offered: offerFanout,
      blockedByPolicy: fanoutBlockedByPolicy,
      fanoutPosture,
      recommendedWorkerWaveSize,
    },
    confirmBeatOffered: Boolean(confirmBeat),
    preflightPhase: preflightDecision.phase,
    capabilityResolution,
    text: lines.join('\n'),
  };
}
