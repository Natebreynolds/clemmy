/**
 * Clem's proposal of what a connected server's tools do, for a server that
 * does not say, and the owner's one approval of it.
 *
 * When a tool cannot be installed because nothing declares its effect, Clem
 * reads every such tool of that server twice (the checker and the quick
 * model), keeps the stricter answer where they differ, and puts one card in
 * front of the owner: which tools only look things up, which change things,
 * and which delete or send, which still ask each time. Nothing is callable
 * until a person approves the card. An approval records the labels against
 * the exact definitions that were read, so a definition that changes later
 * loses its label and is proposed again.
 */
import { createHash } from 'node:crypto';
import pino from 'pino';
import { discoverMcpServers } from './mcp-config.js';
import { slugifyServerName } from './mcp-namespace-shim.js';
import {
  MCP_TOOL_EFFECT_LABELS,
  MCP_TOOL_EFFECT_PROPOSAL_OPEN_MS,
  markMcpToolEffectProposalRunning,
  readMcpToolEffectLabelFile,
  stricterLabel,
  undeclaredMcpTools,
  writeMcpToolEffectLabelFile,
  type McpToolEffectLabel,
  type PendingMcpToolEffectProposal,
} from './mcp-tool-effect-labels.js';
import * as approvalRegistry from './harness/approval-registry.js';
import { registerResumableApprovalCardAtomically } from './harness/approval-card.js';
import {
  completeViaConfiguredBrain,
  MCP_TOOL_EFFECT_LABELS_SYSTEM,
  McpToolEffectLabelsV1Schema,
} from './semantic-boundary/configured-brain-semantic-port.js';

const logger = pino({ name: 'clementine.mcp-tool-effect-labels' });

const RESUME_KEY_PREFIX = 'mcp-effect-labels:v1:';
/** A person's "no" stands this long, so a turn that retries cannot re-ask. */
const REJECTION_STANDS_MS = 24 * 60 * 60_000;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_SCHEMA_CHARS = 1_500;

export type McpToolEffectProposalResult =
  | { status: 'proposed' | 'already_pending'; approvalId: string; tools: number }
  | { status: 'nothing_to_propose' | 'declined_recently' | 'unread' };

type ReadLabels = (input: {
  purpose: 'mcp_tool_effect_labels' | 'mcp_tool_effect_labels_second';
  user: string;
}) => Promise<unknown>;

const defaultReadLabels: ReadLabels = async ({ purpose, user }) => (await completeViaConfiguredBrain({
  purpose,
  system: MCP_TOOL_EFFECT_LABELS_SYSTEM,
  user,
  schemaName: 'McpToolEffectLabelsV1',
})).raw;

let readLabels: ReadLabels = defaultReadLabels;
const inFlight = new Map<string, Promise<McpToolEffectProposalResult>>();

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
}

function serverDisplayName(serverSlug: string): string {
  try {
    const configured = discoverMcpServers().find((server) => slugifyServerName(server.name) === serverSlug);
    if (configured?.name?.trim()) return configured.name.trim();
  } catch { /* the slug still names it */ }
  return serverSlug;
}

function readingFrom(raw: unknown, ids: ReadonlySet<string>): Map<string, McpToolEffectLabel> | null {
  const parsed = McpToolEffectLabelsV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const reading = new Map<string, McpToolEffectLabel>();
  for (const entry of parsed.data.labels) {
    if (ids.has(entry.id) && MCP_TOOL_EFFECT_LABELS.includes(entry.effect)) {
      const prior = reading.get(entry.id);
      reading.set(entry.id, prior ? stricterLabel(prior, entry.effect) : entry.effect);
    }
  }
  return reading;
}

function cardArgs(labels: PendingMcpToolEffectProposal['labels']): Record<string, string> {
  const group = (label: McpToolEffectLabel) => labels
    .filter((entry) => entry.label === label)
    .map((entry) => words(entry.tool))
    .join(', ');
  const args: Record<string, string> = {};
  const groups: Array<[string, McpToolEffectLabel]> = [
    ['looks things up', 'read'],
    ['makes changes', 'change'],
    ['deletes (asks you each time)', 'delete'],
    ['sends (asks you each time)', 'send'],
  ];
  for (const [heading, label] of groups) {
    const tools = group(label);
    if (tools) args[heading] = tools;
  }
  return args;
}

async function propose(input: {
  serverSlug: string;
  sessionId: string;
}): Promise<McpToolEffectProposalResult> {
  const tools = undeclaredMcpTools(input.serverSlug);
  if (tools.length === 0) return { status: 'nothing_to_propose' };
  const proposalDigest = createHash('sha256')
    .update(tools.map((tool) => `${tool.tool}\0${tool.rawDefinitionDigest}`).join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  const resumeKey = `${RESUME_KEY_PREFIX}${input.serverSlug}:${proposalDigest}`;

  const prior = approvalRegistry.inspectResumableApproval(resumeKey);
  if (prior.state === 'pending') return { status: 'already_pending', approvalId: prior.row.approvalId, tools: tools.length };
  if (prior.state === 'rejected' || prior.state === 'cancelled') {
    const decidedAt = Date.parse(prior.row.resolvedAt ?? prior.row.requestedAt);
    if (Number.isFinite(decidedAt) && Date.now() - decidedAt < REJECTION_STANDS_MS) return { status: 'declined_recently' };
  }

  const serverName = serverDisplayName(input.serverSlug);
  const ids = new Map(tools.map((tool, index) => [`t${index + 1}`, tool]));
  const user = [
    `Connected server: ${serverName}`,
    'Tools:',
    JSON.stringify([...ids.entries()].map(([id, tool]) => ({
      id,
      name: tool.tool,
      description: clipped(tool.description, MAX_DESCRIPTION_CHARS),
      inputSchema: clipped(JSON.stringify(tool.inputSchema ?? null), MAX_SCHEMA_CHARS),
    }))),
  ].join('\n');
  const idSet = new Set(ids.keys());
  const readings = (await Promise.allSettled([
    readLabels({ purpose: 'mcp_tool_effect_labels', user }),
    readLabels({ purpose: 'mcp_tool_effect_labels_second', user }),
  ])).map((settled) => (settled.status === 'fulfilled' ? readingFrom(settled.value, idSet) : null))
    .filter((reading): reading is Map<string, McpToolEffectLabel> => reading !== null);
  if (readings.length === 0) return { status: 'unread' };

  const labels: PendingMcpToolEffectProposal['labels'] = [...ids.entries()].map(([id, tool]) => {
    // A tool neither reading answered for is proposed as the strictest kind:
    // the owner still sees it, and every call of it asks.
    let label: McpToolEffectLabel | null = null;
    for (const reading of readings) {
      const read = reading.get(id);
      if (read) label = label ? stricterLabel(label, read) : read;
    }
    return { tool: tool.tool, rawDefinitionDigest: tool.rawDefinitionDigest, label: label ?? 'send' };
  });

  const asking = labels.some((entry) => entry.label === 'delete' || entry.label === 'send');
  const card = registerResumableApprovalCardAtomically({
    sessionId: input.sessionId,
    subject: `Let Clem use ${serverName}'s tools`,
    tool: null,
    args: cardArgs(labels),
    ttlMs: MCP_TOOL_EFFECT_PROPOSAL_OPEN_MS,
    resumeKey,
    extra: {
      preview: {
        ask: `Can I start using ${serverName}?`,
        why: clipped(`${serverName} doesn't say which of its ${labels.length} tools only look things up and which change things, so I read each one and sorted them.${
          asking ? ' Anything that deletes or sends still asks you each time.' : ''
        }`, 260),
      },
    },
  });
  const file = readMcpToolEffectLabelFile();
  file.pending[card.row.approvalId] = {
    serverSlug: input.serverSlug,
    serverName,
    approvalId: card.row.approvalId,
    resumeKey,
    proposedAt: new Date().toISOString(),
    labels,
  };
  writeMcpToolEffectLabelFile({ ...file, servers: { ...file.servers }, pending: { ...file.pending } });
  logger.info({ serverSlug: input.serverSlug, approvalId: card.row.approvalId, tools: labels.length },
    'proposed tool effect labels for owner approval');
  return {
    status: card.approvalCreated ? 'proposed' : 'already_pending',
    approvalId: card.row.approvalId,
    tools: labels.length,
  };
}

/**
 * Ask the owner, once, to approve what this server's undeclared tools do.
 * Concurrent asks for one server share one proposal.
 */
export function proposeMcpToolEffectLabels(input: {
  serverSlug: string;
  sessionId: string;
}): Promise<McpToolEffectProposalResult> {
  const running = inFlight.get(input.serverSlug);
  if (running) return running;
  markMcpToolEffectProposalRunning(input.serverSlug, true);
  const started = propose(input)
    .catch((error: unknown) => {
      logger.warn({ serverSlug: input.serverSlug, err: error instanceof Error ? error.message : String(error) },
        'tool effect label proposal failed');
      return { status: 'unread' } as const;
    })
    .finally(() => {
      inFlight.delete(input.serverSlug);
      markMcpToolEffectProposalRunning(input.serverSlug, false);
    });
  inFlight.set(input.serverSlug, started);
  return started;
}

/** Record the owner's decision on one label card. Exactly once per approval,
 *  across processes: the registry's claim is the one that counts. */
export function settleMcpToolEffectLabelDecision(row: approvalRegistry.PendingApprovalRow): boolean {
  if (!row.resumeKey?.startsWith(RESUME_KEY_PREFIX) || row.status === 'pending') return false;
  const file = readMcpToolEffectLabelFile();
  const proposal = file.pending[row.approvalId];
  if (!proposal || proposal.resumeKey !== row.resumeKey) return false;
  const pending = { ...file.pending };
  delete pending[row.approvalId];
  if (!approvalRegistry.approvalDecidedByPerson(row)) {
    writeMcpToolEffectLabelFile({ ...file, pending });
    return false;
  }
  const claim = approvalRegistry.claimResumableApproval(row.resumeKey, row.approvalId);
  if (claim.state !== 'approved') {
    if (claim.state !== 'pending') writeMcpToolEffectLabelFile({ ...file, pending });
    return false;
  }
  const decidedAt = new Date().toISOString();
  const serverLabels = { ...(file.servers[proposal.serverSlug] ?? {}) };
  for (const entry of proposal.labels) {
    serverLabels[entry.tool] = {
      label: entry.label,
      rawDefinitionDigest: entry.rawDefinitionDigest,
      approvalId: row.approvalId,
      decidedAt,
    };
  }
  writeMcpToolEffectLabelFile({
    version: 1,
    servers: { ...file.servers, [proposal.serverSlug]: serverLabels },
    pending,
  });
  logger.info({ serverSlug: proposal.serverSlug, approvalId: row.approvalId, tools: proposal.labels.length },
    'owner approved tool effect labels');
  return true;
}

let initialized = false;

/** Listen for label decisions, and settle any made while the app was down. */
export function initMcpToolEffectLabelApprovals(): void {
  if (initialized) return;
  initialized = true;
  approvalRegistry.onApprovalResolved((row) => { settleMcpToolEffectLabelDecision(row); });
  setImmediate(() => {
    try {
      for (const approvalId of Object.keys(readMcpToolEffectLabelFile().pending)) {
        const row = approvalRegistry.get(approvalId);
        if (row && row.status !== 'pending') settleMcpToolEffectLabelDecision(row);
      }
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) },
        'tool effect label decisions could not be settled at start');
    }
  });
}

/** Tests only. */
export function _setMcpToolEffectLabelReaderForTests(reader: ReadLabels | null): void {
  readLabels = reader ?? defaultReadLabels;
  inFlight.clear();
  initialized = false;
}
