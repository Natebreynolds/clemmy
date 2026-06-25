import { writeToolOutput } from './eventlog.js';
import { getToolOutputContext } from './tool-output-context.js';
import { digestToolOutput } from './tool-output-digest.js';

// Raised 4000 → 12000 (2026-05-29): 4000 clipped normal "show me N" results
// (e.g. 10 Salesforce accounts ≈ 5.5KB) into head+tail, which read as
// "aggressive" clipping. 12000 (~3K tokens) lets typical results through
// whole while genuinely huge outputs (100KB+ Composio dumps) still digest +
// stay recoverable. Compaction handles long sessions.
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 12000;

export interface RecallableToolTextOptions {
  maxChars?: number;
  toolName?: string | null;
  sessionId?: string;
  callId?: string;
}

export function truncateToolText(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const dropped = text.length - maxChars;
  return `${head}\n\n…[truncated — ${dropped.toLocaleString()} of ${text.length.toLocaleString()} chars omitted; re-call with a narrower scope (offset/limit, filter, specific query) if you need the rest]`;
}

// Keys whose array value is a list of ADDRESSABLE resources the model targets
// by id in a follow-up call (tables, sheets, databases, objects, …). Used to
// preserve ids through digest/clip. `records`/`rows`/`value` are excluded —
// those are bulk DATA rows, not addressable schema, and would add noise.
const RESOURCE_LIST_KEYS = new Set([
  'tables', 'items', 'results', 'views', 'bases', 'databases', 'sheets',
  'objects', 'files', 'list', 'entries', 'channels', 'repositories', 'projects', 'boards',
]);
const MAX_INDEX_PAIRS = 40;
const MAX_ITEMS_SCANNED = 600;

/**
 * GLOBAL root-cause fix: a large tool result that LISTS addressable resources
 * (a base's tables, a workspace's sheets/objects/files, …) gets digested/clipped
 * for the context window — and the digest summarizes the list to `array(N)`,
 * DROPPING the very ids the model needs to make the next call. The model then
 * can't target the resource, guesses an id/name, gets NOT_FOUND, re-discovers,
 * and loops into the tool-call guardrail. This affects EVERY tool that returns
 * id-keyed lists (Composio, native MCP, local), because they all format through
 * here. So: extract a compact `id = name` index and surface it ABOVE the
 * clipped body, uncllipped, so discovery always yields usable ids.
 */
export function extractResourceIdIndex(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return ''; }
  const arrays: Record<string, unknown>[] = [];
  let scanned = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || !node || typeof node !== 'object' || arrays.length > MAX_ITEMS_SCANNED) return;
    if (Array.isArray(node)) return; // arrays are only harvested via a resource-list key
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(v) && RESOURCE_LIST_KEYS.has(k.toLowerCase())) {
        for (const it of v) {
          if (++scanned > MAX_ITEMS_SCANNED) break;
          if (it && typeof it === 'object' && !Array.isArray(it)) arrays.push(it as Record<string, unknown>);
        }
      } else if (v && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  visit(parsed, 0);
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const o of arrays) {
    const id = typeof o.id === 'string' ? o.id
      : typeof o.key === 'string' ? o.key
      : typeof o.gid === 'string' ? o.gid
      : typeof o.slug === 'string' ? o.slug : '';
    const name = typeof o.name === 'string' ? o.name
      : typeof o.title === 'string' ? o.title
      : typeof o.displayName === 'string' ? o.displayName : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    pairs.push(`${id} = ${name}`);
    if (pairs.length >= MAX_INDEX_PAIRS) break;
  }
  if (pairs.length === 0) return '';
  return `📋 IDs available in this result (use these EXACT ids in follow-up calls — do NOT guess names):\n  ${pairs.join('\n  ')}`;
}

/**
 * Canonical model-facing tool-output formatter.
 *
 * If a harness session + call id is available, this stores the full
 * output in `tool_outputs` before returning a small prompt-safe stub
 * that tells the model exactly how to recover the original with
 * `recall_tool_result`. Without call context it falls back to a plain
 * truncation marker, which is the best a detached MCP/dev path can do.
 */
export function formatRecallableToolText(
  text: string,
  options: RecallableToolTextOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (text.length <= maxChars) return text;

  // The result is about to be clipped/digested. If it lists addressable
  // resources, surface their ids ABOVE the body so they survive (the root-cause
  // fix — see extractResourceIdIndex). Global: every tool formats through here.
  const idIndex = extractResourceIdIndex(text);
  const withIndex = (body: string): string => (idIndex ? `${idIndex}\n\n${body}` : body);

  const active = getToolOutputContext();
  const sessionId = options.sessionId ?? active?.sessionId;
  const callId = options.callId ?? active?.callId;
  const toolName = options.toolName ?? active?.toolName ?? 'tool';

  if (!sessionId || !callId) {
    return withIndex(truncateToolText(text, maxChars));
  }

  try {
    writeToolOutput({
      sessionId,
      callId,
      tool: toolName,
      output: text,
    });
  } catch {
    return withIndex(truncateToolText(text, maxChars));
  }

  // Full payload is now parked in tool_outputs (above). Replace the raw
  // mid-content cut with a structure-aware digest so the model never sees
  // a JSON array severed mid-record — it gets complete records + the true
  // total + how to pull any slice (tool_output_query / recall_tool_result).
  return withIndex(digestToolOutput(text, { maxChars, toolName, callId }));
}
