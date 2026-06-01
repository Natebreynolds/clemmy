import { existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { getFocusSnapshot } from '../../memory/focus.js';
import { listSkills } from '../../memory/skill-store.js';
import { listWorkflows } from '../../memory/workflow-store.js';
import { listMcpServerHealth, type MCPServerHealthSnapshot } from '../mcp-namespace-shim.js';
import { resolveMcpToolScope, type McpToolScope } from '../mcp-tool-scope.js';

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
  memory: MemoryPrimerSummary;
  skills: RankedContextCandidate[];
  workflows: RankedContextCandidate[];
  toolScope: Pick<McpToolScope, 'reason' | 'allowAll' | 'allowedServerSlugs' | 'maxTools'>;
  mcp: Array<Pick<MCPServerHealthSnapshot, 'slug' | 'state' | 'toolCount' | 'failureCount' | 'lastError'>>;
  healthWarnings: string[];
  text: string;
}

const MAX_CANDIDATES = 3;
const LOW_DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const CRITICAL_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'for', 'from',
  'go', 'have', 'help', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'that', 'the', 'then', 'this', 'to', 'use', 'we', 'with', 'you',
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

const READ_RE = /\b(?:find|pull|query|search|scrape|crawl|research|audit|summarize|analyze|gather|inspect)\b/i;
const WRITE_RE =
  /\b(?:create|draft|send|write|update|append|post|publish|host|deploy|file|sheet|email|proposal|report|edit)\b/i;
const BATCH_RE = /\b(?:\d+|top\s+\d+|several|many|multiple|batch|bulk|list of|all of them|for each|each one)\b/i;
const SEQUENCE_RE = /\b(?:then|after that|afterward|before .* then|once .* then|first .* then)\b/i;

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function classifyComplexity(input: string): AgentContextPacket['complexity'] {
  const text = input.trim();
  const domains = DOMAIN_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const hasRead = READ_RE.test(text);
  const hasWrite = WRITE_RE.test(text);
  const hasBatch = BATCH_RE.test(text);
  const hasSequence = SEQUENCE_RE.test(text);
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
      const haystack = field.text.toLowerCase();
      if (!haystack.includes(token)) continue;
      matched.add(token);
      score += field.weight;
      if (haystack.split(/[^a-z0-9]+/).includes(token)) score += field.weight;
    }
  }
  return { score, matched: Array.from(matched).slice(0, 5) };
}

function rankSkills(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  try {
    return listSkills()
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
          description: clip(description || '(no description)', 180),
          score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

function rankWorkflows(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
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
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
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

function focusLine(): string | null {
  try {
    const focus = getFocusSnapshot();
    if (focus.active && !focus.needsConfirm) return `Active focus: ${focus.active.title} — ${clip(focus.active.summary, 180)}`;
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
    const scope = resolveMcpToolScope({ userInput: input });
    return {
      reason: scope.reason,
      allowAll: scope.allowAll,
      allowedServerSlugs: scope.allowedServerSlugs,
      maxTools: scope.maxTools,
    };
  } catch {
    return { reason: 'tool scope unavailable' };
  }
}

export function buildAgentContextPacket(
  input: string,
  memory: MemoryPrimerSummary,
): AgentContextPacket {
  const complexity = classifyComplexity(input);
  const skills = rankSkills(input);
  const workflows = rankWorkflows(input);
  const toolScope = summarizeToolScope(input);
  const mcp = mcpHealth();
  const healthWarnings = [
    ...diskHealthWarnings(),
    ...mcp.map((server) => `MCP ${server.slug} is ${server.state}${server.lastError ? `: ${server.lastError}` : ''}`),
  ];
  const focus = focusLine();
  const memoryLine = memory.enabled
    ? `Memory preflight: ${memory.hitCount} hit${memory.hitCount === 1 ? '' : 's'} via ${memory.source ?? 'local search'}${memory.injected ? ' and injected below' : ''}${memory.skippedReason ? ` (${memory.skippedReason})` : ''}.`
    : 'Memory preflight: disabled.';

  const lines = [
    '[AGENT CONTEXT PACKET]',
    'This deterministic preflight ran before the model call. Use it to choose memory, skills, workflows, and tools instead of guessing.',
    `Complexity: ${complexity}.`,
    focus,
    memoryLine,
    `External MCP scope: ${toolScope.allowAll ? 'all external tools allowed' : `${(toolScope.allowedServerSlugs ?? []).join(', ') || 'none'}${toolScope.maxTools ? `, max ${toolScope.maxTools} tools` : ''}`} (${toolScope.reason}).`,
    ...renderCandidates('Likely skills', skills, 'If one is relevant, call skill_read before creating the deliverable.'),
    ...renderCandidates('Likely workflows', workflows, 'Use these as reusable-process candidates. Run one only if the user explicitly named or asked for that workflow; otherwise do the work directly and offer to save a workflow later.'),
    healthWarnings.length > 0 ? `Health warnings:\n${healthWarnings.map((w) => `- ${w}`).join('\n')}` : 'Health warnings: none.',
    'Parallelism reminder: for independent batches, resolve shared tools/context once, then call run_worker with one structured packet per item in parallel or use an existing workflow forEach.',
    'Approval reminder: batch related writes/sends under one clear approval with a preview whenever possible.',
  ].filter((line): line is string => Boolean(line));

  return {
    inputPreview: clip(input, 200),
    complexity,
    memory,
    skills,
    workflows,
    toolScope,
    mcp,
    healthWarnings,
    text: lines.join('\n'),
  };
}
