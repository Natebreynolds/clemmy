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
  type McpToolEffectLabelFile,
  type PendingMcpToolEffectProposal,
} from './mcp-tool-effect-labels.js';
import * as approvalRegistry from './harness/approval-registry.js';
import { emitApprovalRequestedCard, registerResumableApprovalCardAtomically } from './harness/approval-card.js';
import { createSession, openEventLog } from './harness/eventlog.js';
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
let writeLabels = writeMcpToolEffectLabelFile;
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

function cardArgs(labels: PendingMcpToolEffectProposal['labels'], incompleteTools: ReadonlySet<string>): Record<string, string> {
  const group = (label: McpToolEffectLabel) => labels
    .filter((entry) => entry.label === label && !incompleteTools.has(entry.tool))
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
  if (incompleteTools.size > 0) {
    args['not fully checked (asks you each time)'] = labels.filter((entry) => incompleteTools.has(entry.tool))
      .map((entry) => words(entry.tool)).join(', ');
  }
  return args;
}

/** Put the card in the conversation that needed the tools, once. */
function showCardIn(
  sessionId: string,
  row: approvalRegistry.PendingApprovalRow,
  preview: NonNullable<PendingMcpToolEffectProposal['preview']>,
): void {
  if (sessionId === row.sessionId) return;
  try {
    const shown = openEventLog().prepare(`
      SELECT 1 FROM events
       WHERE session_id = ? AND type = 'approval_requested'
         AND json_extract(data_json, '$.approvalId') = ?
       LIMIT 1
    `).get(sessionId, row.approvalId);
    if (!shown) emitApprovalRequestedCard({ sessionId, approvalId: row.approvalId, extra: { preview } });
  } catch { /* the card still waits in Needs you */ }
}

/** The atomic card event is the durable source; the shared JSON file is its
 * replayable projection. Older cards can still recover from their pending
 * file entry. Never use a later proposal to apply an earlier approval. */
function storedProposal(
  row: approvalRegistry.PendingApprovalRow,
  file: McpToolEffectLabelFile,
): PendingMcpToolEffectProposal | null {
  const event = openEventLog().prepare(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = 'approval_requested'
       AND json_extract(data_json, '$.approvalId') = ?
     ORDER BY seq ASC LIMIT 1
  `).get(row.sessionId, row.approvalId) as { data_json: string } | undefined;
  const durable = event ? JSON.parse(event.data_json).mcpToolEffectProposal : null;
  const proposal = durable ? { ...durable, approvalId: row.approvalId } : file.pending[row.approvalId];
  if (!proposal || proposal.resumeKey !== row.resumeKey || proposal.approvalId !== row.approvalId
    || typeof proposal.serverSlug !== 'string' || !proposal.serverSlug
    || typeof proposal.serverName !== 'string' || typeof proposal.proposedAt !== 'string'
    || !Array.isArray(proposal.labels) || proposal.labels.length === 0
    || !proposal.labels.every((entry: PendingMcpToolEffectProposal['labels'][number]) => entry
      && typeof entry.tool === 'string' && entry.tool.length > 0
      && typeof entry.rawDefinitionDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.rawDefinitionDigest)
      && MCP_TOOL_EFFECT_LABELS.includes(entry.label))) return null;
  return proposal;
}

function projectPendingProposal(row: approvalRegistry.PendingApprovalRow): void {
  openEventLog().transaction(() => {
    const current = approvalRegistry.get(row.approvalId);
    if (!current || current.status !== 'pending') return;
    const file = readMcpToolEffectLabelFile({ strict: true });
    const proposal = storedProposal(current, file);
    if (proposal) {
      writeLabels({ ...file, pending: { ...file.pending, [current.approvalId]: proposal } });
    }
  }).immediate();
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
  if (prior.state === 'pending') {
    const pending = storedProposal(prior.row, readMcpToolEffectLabelFile());
    projectPendingProposal(prior.row);
    if (pending?.preview) showCardIn(input.sessionId, prior.row, pending.preview);
    return { status: 'already_pending', approvalId: prior.row.approvalId, tools: tools.length };
  }
  if (prior.state === 'approved' || prior.state === 'consumed') {
    settleMcpToolEffectLabelDecision(prior.row);
    const stored = readMcpToolEffectLabelFile().servers[input.serverSlug];
    if (tools.every((tool) => stored?.[tool.tool]?.rawDefinitionDigest === tool.rawDefinitionDigest)) {
      return { status: 'nothing_to_propose' };
    }
  }
  if (prior.state === 'rejected' || prior.state === 'cancelled') {
    const decidedAt = Date.parse(prior.row.resolvedAt ?? prior.row.requestedAt);
    if (Number.isFinite(decidedAt) && Date.now() - decidedAt < REJECTION_STANDS_MS) return { status: 'declined_recently' };
  }

  const serverName = serverDisplayName(input.serverSlug);
  const ids = new Map(tools.map((tool, index) => [`t${index + 1}`, tool]));
  const incompleteDefinitions = new Set([...ids.entries()].filter(([, tool]) => (
    tool.description.length > MAX_DESCRIPTION_CHARS
    || JSON.stringify(tool.inputSchema ?? null).length > MAX_SCHEMA_CHARS
  )).map(([id]) => id));
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
  ])).map((settled) => (settled.status === 'fulfilled' ? readingFrom(settled.value, idSet) : null));
  if (readings.every((reading) => reading === null)) return { status: 'unread' };

  const incompleteTools = new Set<string>();
  const labels: PendingMcpToolEffectProposal['labels'] = [...ids.entries()].map(([id, tool]) => {
    // A relaxed label requires two complete readings of this exact tool.
    // A missing/failed reader or clipped definition is uncertainty, never
    // evidence that the tool is safe to call without asking each time.
    const first = readings[0]?.get(id);
    const second = readings[1]?.get(id);
    const fullyChecked = first && second && !incompleteDefinitions.has(id);
    if (!fullyChecked) incompleteTools.add(tool.tool);
    const label: McpToolEffectLabel = fullyChecked ? stricterLabel(first, second) : 'send';
    return { tool: tool.tool, rawDefinitionDigest: tool.rawDefinitionDigest, label };
  });

  const asking = labels.some((entry) => entry.label === 'delete' || entry.label === 'send');
  const subject = `Let Clem use ${serverName}'s tools`;
  const args = cardArgs(labels, incompleteTools);
  const preview = {
    // The card's own shape: what is asked, why, and exactly what approving does.
    operation: `use ${serverName} tools`,
    fields: Object.entries(args).map(([name, value]) => ({ name, value })),
    ask: `Can I start using ${serverName}?`,
    why: clipped(incompleteTools.size > 0
      ? `${incompleteTools.size} of ${labels.length} tools could not be fully checked. Each still asks you each time; its effects need a full check. The others were checked and sorted from their definitions.`
      : `${serverName} doesn't say which of its ${labels.length} tools only look things up and which change things, so I read each one and sorted them.${
        asking ? ' Anything that deletes or sends still asks you each time.' : ''
      }`, 260),
  };
  // The decision is about a server, not a step of the conversation it came up
  // in. The approval belongs to its own session and the chat only shows the
  // card: a pending approval owned by a chat holds that chat, so every next
  // message would start a new branch until the owner answered.
  const owner = createSession({
    kind: 'execution',
    userId: 'clem',
    title: subject,
    metadata: { source: 'mcp_tool_effect_labels', serverSlug: input.serverSlug },
  });
  const proposal = { serverSlug: input.serverSlug, serverName, resumeKey,
    proposedAt: new Date().toISOString(), preview, labels };
  const card = registerResumableApprovalCardAtomically({
    sessionId: owner.id,
    subject,
    tool: null,
    args,
    ttlMs: MCP_TOOL_EFFECT_PROPOSAL_OPEN_MS,
    resumeKey,
    extra: { preview, mcpToolEffectProposal: proposal },
  });
  showCardIn(input.sessionId, card.row, preview);
  // If projection fails, the already-committed card retains the complete
  // proposal. Startup or the next request can project it without new reads.
  projectPendingProposal(card.row);
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

/** Apply the exact human-approved proposal idempotently, then mark it applied.
 * The SQLite writer lock serializes competing projections. A crash before
 * consumption leaves the immutable proposal available for another attempt;
 * reapplying these labels has no external effect. */
export function settleMcpToolEffectLabelDecision(row: approvalRegistry.PendingApprovalRow): boolean {
  if (!row.resumeKey?.startsWith(RESUME_KEY_PREFIX) || row.status === 'pending') return false;
  return openEventLog().transaction(() => {
    const current = approvalRegistry.get(row.approvalId);
    if (!current || current.resumeKey !== row.resumeKey || current.status === 'pending') return false;
    const file = readMcpToolEffectLabelFile({ strict: true });
    if (current.consumedAt && !file.pending[current.approvalId]) return false;
    const proposal = storedProposal(current, file);
    if (!proposal) return false;
    const pending = { ...file.pending };
    delete pending[current.approvalId];
    if (current.presentation || !approvalRegistry.approvalDecidedByPerson(current)) {
      if (file.pending[current.approvalId]) writeLabels({ ...file, pending });
      return false;
    }
    const decidedAt = current.resolvedAt!;
    const serverLabels = { ...(file.servers[proposal.serverSlug] ?? {}) };
    for (const entry of proposal.labels) {
      const existing = serverLabels[entry.tool];
      // Recovery of an older grant must not replace a later owner decision.
      if (existing && (existing.decidedAt > decidedAt
        || (existing.decidedAt === decidedAt && existing.approvalId !== current.approvalId))) continue;
      serverLabels[entry.tool] = {
        label: entry.label, rawDefinitionDigest: entry.rawDefinitionDigest,
        approvalId: current.approvalId, decidedAt,
      };
    }
    writeLabels({ version: 1, servers: { ...file.servers, [proposal.serverSlug]: serverLabels }, pending });
    if (!current.consumedAt) {
      const claim = approvalRegistry.claimResumableApproval(current.resumeKey!, current.approvalId);
      if (claim.state !== 'approved') throw new Error('Tool label approval application could not be recorded');
    }
    logger.info({ serverSlug: proposal.serverSlug, approvalId: current.approvalId, tools: proposal.labels.length },
      'owner approved tool effect labels');
    return true;
  }).immediate();
}

/** Repair interrupted card projection and application without asking again.
 * Legacy consumed-before-write rows remain recoverable while their pending
 * file proposal exists. New rows retain their proposal in the atomic card. */
export function reconcileMcpToolEffectLabelApprovals(): void {
  const ids = new Set(Object.keys(readMcpToolEffectLabelFile().pending));
  const rows = openEventLog().prepare(`
    SELECT approval_id FROM pending_approvals
     WHERE resume_key LIKE ? AND (status = 'pending' OR (resolution = 'approved' AND consumed_at IS NULL))
  `).all(`${RESUME_KEY_PREFIX}%`) as Array<{ approval_id: string }>;
  for (const row of rows) ids.add(row.approval_id);
  for (const approvalId of ids) {
    try {
      const row = approvalRegistry.get(approvalId);
      if (!row) continue;
      if (row.status === 'pending') projectPendingProposal(row);
      else settleMcpToolEffectLabelDecision(row);
    } catch (error) {
      logger.warn({ approvalId, err: error instanceof Error ? error.message : String(error) },
        'tool effect label decision awaits projection retry');
    }
  }
}

let initialized = false;
const onLabelDecision = (row: approvalRegistry.PendingApprovalRow) => { settleMcpToolEffectLabelDecision(row); };

/** Listen for label decisions, and settle any made while the app was down. */
export function initMcpToolEffectLabelApprovals(): void {
  if (initialized) return;
  initialized = true;
  approvalRegistry.onApprovalResolved(onLabelDecision);
  setImmediate(() => {
    try { reconcileMcpToolEffectLabelApprovals(); }
    catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) },
        'tool effect label decisions could not be settled at start');
    }
  });
}

/** Inject only the projection boundary for interrupted-write tests. */
export function _setMcpToolEffectLabelWriterForTests(writer: typeof writeMcpToolEffectLabelFile | null): void {
  writeLabels = writer ?? writeMcpToolEffectLabelFile;
}

/** Tests only. */
export function _setMcpToolEffectLabelReaderForTests(reader: ReadLabels | null): void {
  readLabels = reader ?? defaultReadLabels;
  writeLabels = writeMcpToolEffectLabelFile;
  inFlight.clear();
  initialized = false;
}
