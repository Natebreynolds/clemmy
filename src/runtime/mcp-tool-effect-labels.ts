/**
 * What an external MCP tool does, as the owner approved it, for a tool whose
 * own server does not say.
 *
 * A server's readOnly/destructive hints are the only evidence of a tool's
 * effect that Clem trusts, and many servers declare none, so their tools could
 * be listed but never called. Clem reads such a server's tools and proposes a
 * label for each; the owner approves once. An approved label acts as the
 * server's own declaration would, for that exact tool definition only: a tool
 * whose definition changes, or whose server starts declaring its own effect,
 * no longer takes the label.
 *
 * The store is a file, read again whenever it changes, because more than one
 * process lists the same server's tools and all of them must agree.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export type McpToolEffectLabel = 'read' | 'change' | 'delete' | 'send';

export const MCP_TOOL_EFFECT_LABELS: readonly McpToolEffectLabel[] = ['read', 'change', 'delete', 'send'];

/** Strictest first: where two readings differ, the stricter one is proposed. */
const STRICTNESS: Record<McpToolEffectLabel, number> = { read: 0, change: 1, delete: 2, send: 3 };

export function stricterLabel(a: McpToolEffectLabel, b: McpToolEffectLabel): McpToolEffectLabel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export interface StoredMcpToolEffectLabel {
  label: McpToolEffectLabel;
  /** The exact tool definition the label was approved for. */
  rawDefinitionDigest: string;
  approvalId: string;
  decidedAt: string;
}

export interface PendingMcpToolEffectProposal {
  serverSlug: string;
  serverName: string;
  approvalId: string;
  resumeKey: string;
  proposedAt: string;
  /** The card's preview: Clem's question and why, and what approving does. */
  preview?: { operation: string; fields: Array<{ name: string; value: string }>; ask: string; why: string };
  labels: Array<{ tool: string; rawDefinitionDigest: string; label: McpToolEffectLabel }>;
}

export interface McpToolEffectLabelFile {
  version: 1;
  servers: Record<string, Record<string, StoredMcpToolEffectLabel>>;
  pending: Record<string, PendingMcpToolEffectProposal>;
}

function labelFilePath(): string {
  return path.join(BASE_DIR, 'state', 'mcp-tool-effect-labels.json');
}

let cached: { mtimeMs: number; size: number; value: McpToolEffectLabelFile } | null = null;

function emptyFile(): McpToolEffectLabelFile {
  return { version: 1, servers: {}, pending: {} };
}

export function readMcpToolEffectLabelFile(options: { strict?: boolean } = {}): McpToolEffectLabelFile {
  const file = labelFilePath();
  try {
    const stat = statSync(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<McpToolEffectLabelFile>;
    if (!parsed || parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== 'object'
      || Array.isArray(parsed.servers) || !parsed.pending || typeof parsed.pending !== 'object'
      || Array.isArray(parsed.pending)) throw new Error('Tool effect label store is malformed');
    const value: McpToolEffectLabelFile = {
      version: 1,
      servers: parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {},
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
    };
    cached = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch (error) {
    // Listing fails closed. A projection writer must not mistake a broken
    // existing store for an empty one and erase unrelated approved labels.
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return emptyFile();
  }
}

/** Changes whenever the store does, so a cached tool list can tell that an
 *  approval landed (in this process or another) and list again. */
export function mcpToolEffectLabelStamp(): string {
  try {
    const stat = statSync(labelFilePath());
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'none';
  }
}

export function writeMcpToolEffectLabelFile(value: McpToolEffectLabelFile): void {
  const file = labelFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
  cached = null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

interface RawMcpTool {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** The exact definition a server listed, before Clem renames or labels it. */
export function rawMcpToolDefinitionDigest(tool: RawMcpTool): string {
  return createHash('sha256').update(canonical({
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
  }), 'utf8').digest('hex');
}

/** Whether the server itself says what the tool does. */
export function mcpToolDeclaresEffect(tool: RawMcpTool): boolean {
  const annotations = tool.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  const record = annotations as Record<string, unknown>;
  return typeof record.readOnlyHint === 'boolean' || typeof record.destructiveHint === 'boolean';
}

/** The declaration an approved label stands for. A delete or a send is
 *  destructive, so every call still asks the owner. */
export function annotationsForLabel(label: McpToolEffectLabel): Record<string, boolean> {
  switch (label) {
    case 'read': return { readOnlyHint: true, destructiveHint: false };
    case 'change': return { readOnlyHint: false, destructiveHint: false };
    case 'delete': return { readOnlyHint: false, destructiveHint: true };
    case 'send': return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  }
}

/** The approved label for this exact tool definition, if any. */
export function approvedMcpToolEffectLabel(serverSlug: string, tool: RawMcpTool): StoredMcpToolEffectLabel | null {
  if (mcpToolDeclaresEffect(tool)) return null;
  const stored = readMcpToolEffectLabelFile().servers[serverSlug]?.[tool.name];
  if (!stored || !MCP_TOOL_EFFECT_LABELS.includes(stored.label)) return null;
  return stored.rawDefinitionDigest === rawMcpToolDefinitionDigest(tool) ? stored : null;
}

/** Tools listed without a declared effect, per server, as last listed. */
const undeclared = new Map<string, Map<string, { rawDefinitionDigest: string; description: string; inputSchema: unknown }>>();

/** The tool as every reader should see it: the server's own definition, with
 *  the owner's approved label standing in for a declaration it lacks. */
export function withApprovedMcpToolEffect<T extends RawMcpTool>(serverSlug: string, tool: T): T {
  if (mcpToolDeclaresEffect(tool)) return tool;
  const approved = approvedMcpToolEffectLabel(serverSlug, tool);
  if (!approved) {
    const tools = undeclared.get(serverSlug) ?? new Map();
    tools.set(tool.name, {
      rawDefinitionDigest: rawMcpToolDefinitionDigest(tool),
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema ?? null,
    });
    undeclared.set(serverSlug, tools);
    return tool;
  }
  undeclared.get(serverSlug)?.delete(tool.name);
  const existing = tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)
    ? tool.annotations as Record<string, unknown>
    : {};
  return {
    ...tool,
    annotations: { ...existing, ...annotationsForLabel(approved.label) },
  };
}

/** The tools of one server that declare no effect and have no approved label. */
export function undeclaredMcpTools(serverSlug: string): Array<{
  tool: string; rawDefinitionDigest: string; description: string; inputSchema: unknown;
}> {
  return [...(undeclared.get(serverSlug)?.entries() ?? [])]
    .map(([tool, entry]) => ({ tool, ...entry }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

/** How long a label card stays open for the owner. */
export const MCP_TOOL_EFFECT_PROPOSAL_OPEN_MS = 7 * 24 * 60 * 60_000;

const proposing = new Set<string>();

export function markMcpToolEffectProposalRunning(serverSlug: string, running: boolean): void {
  if (running) proposing.add(serverSlug);
  else proposing.delete(serverSlug);
}

/** Whether the owner has been asked, or is about to be, to approve what this
 *  server's tools do. Until they answer, its undeclared tools wait on them. */
export function mcpToolEffectApprovalOpen(serverSlug: string, now = Date.now()): boolean {
  if (proposing.has(serverSlug)) return true;
  return Object.values(readMcpToolEffectLabelFile().pending).some((proposal) => (
    proposal.serverSlug === serverSlug
    && now - Date.parse(proposal.proposedAt) < MCP_TOOL_EFFECT_PROPOSAL_OPEN_MS
  ));
}

/** Tests only. */
export function _resetMcpToolEffectLabelsForTests(): void {
  undeclared.clear();
  proposing.clear();
  cached = null;
}
