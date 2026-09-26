import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../../config.js';
import { withFileLockSync } from '../atomic-json.js';
import { withModelUsageAttribution } from '../usage-log.js';
import { INSTRUCTION_CACHE_DELIM } from './model-wire-registry.js';

/**
 * Where the per-turn context sits on an OpenAI-compatible wire.
 *
 * The assembled instructions are `${stable}${INSTRUCTION_CACHE_DELIM}${per-turn
 * context}`. A provider prefix cache reuses bytes only up to the first
 * difference, and many chat templates render the tool definitions AFTER the
 * system message. With the per-turn context inside the system message, the
 * first request of every turn re-bills the tool definitions and the whole
 * earlier conversation although none of it changed.
 *
 * The `turn_anchor` layout sends the same per-turn context, byte for byte and
 * still as a system message, immediately before the user message that opened
 * the current turn. Within a turn nothing moves; across turns the tools and
 * the earlier conversation remain a reusable prefix.
 *
 * Templates differ in how they render a system message that is not first, so
 * the layout is never assumed. It is measured once per endpoint and model with
 * a small synthetic probe (no user content) and adopted only when it reused
 * more than the system layout in every round. Until then, and whenever the
 * measurement is missing, stale or failed, the system layout applies
 * unchanged.
 */

export type PromptLayout = 'turn_anchor' | 'system';

export interface PromptLayoutRound {
  /** Prompt tokens of the probe request (same for both layouts). */
  prompt: number;
  /** Cached tokens after only the per-turn context changed, system layout. */
  systemReuse: number;
  /** The same measurement with the per-turn context at the turn anchor. */
  anchorReuse: number;
}

export interface PromptLayoutVerdict {
  layout: PromptLayout;
  measuredAt: string;
  reason: 'anchor_reused_more' | 'anchor_not_better' | 'no_prefix_cache' | 'probe_failed';
  rounds: PromptLayoutRound[];
  detail?: string;
}

type LayoutFile = { version: 1; entries: Record<string, PromptLayoutVerdict> };

const logger = pino({ name: 'clementine.byo-prompt-layout' });

const LAYOUT_PATH = path.join(BASE_DIR, 'state', 'byo-prompt-layout.json');
/** Providers change templates; a verdict is re-measured after this long. */
export const PROMPT_LAYOUT_VERDICT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A failed probe is retried no sooner than this. */
export const PROMPT_LAYOUT_FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
export const PROMPT_LAYOUT_PROBE_ROUNDS = 3;
/** Provider caches can miss a request issued right after the previous one. */
const PROBE_SPACING_MS = 4_000;

export function promptLayoutKey(baseURL: string, model: string): string {
  return `${baseURL.trim().replace(/\/+$/, '')}::${model.trim()}`;
}

let cache: { mtimeMs: number; data: LayoutFile } | null = null;

function readLayouts(): LayoutFile {
  try {
    if (!existsSync(LAYOUT_PATH)) return { version: 1, entries: {} };
    const mtimeMs = statSync(LAYOUT_PATH).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.data;
    const parsed = JSON.parse(readFileSync(LAYOUT_PATH, 'utf-8')) as LayoutFile;
    const data = parsed && parsed.version === 1 && parsed.entries
      ? parsed
      : { version: 1 as const, entries: {} };
    cache = { mtimeMs, data };
    return data;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function readPromptLayoutVerdict(baseURL: string, model: string): PromptLayoutVerdict | undefined {
  return readLayouts().entries[promptLayoutKey(baseURL, model)];
}

export function recordPromptLayoutVerdict(baseURL: string, model: string, verdict: PromptLayoutVerdict): void {
  try {
    mkdirSync(path.dirname(LAYOUT_PATH), { recursive: true });
    withFileLockSync(LAYOUT_PATH, () => {
      cache = null;
      const base = readLayouts();
      const out: LayoutFile = {
        ...base,
        entries: { ...base.entries, [promptLayoutKey(baseURL, model)]: verdict },
      };
      const tmp = `${LAYOUT_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
      renameSync(tmp, LAYOUT_PATH);
    });
    cache = null;
  } catch { /* a lost verdict only means the system layout stays in use */ }
}

/** The layout to send now. Anything short of a fresh measured win is `system`. */
export function promptLayoutFor(baseURL: string, model: string, now = Date.now()): PromptLayout {
  const verdict = readPromptLayoutVerdict(baseURL, model);
  if (!verdict || verdict.layout !== 'turn_anchor') return 'system';
  const at = Date.parse(verdict.measuredAt);
  return Number.isFinite(at) && now - at < PROMPT_LAYOUT_VERDICT_TTL_MS ? 'turn_anchor' : 'system';
}

export function promptLayoutProbeDue(baseURL: string, model: string, now = Date.now()): boolean {
  const verdict = readPromptLayoutVerdict(baseURL, model);
  if (!verdict) return true;
  const at = Date.parse(verdict.measuredAt);
  if (!Number.isFinite(at)) return true;
  const wait = verdict.reason === 'probe_failed' ? PROMPT_LAYOUT_FAILED_RETRY_MS : PROMPT_LAYOUT_VERDICT_TTL_MS;
  return now - at >= wait;
}

/** Adopt the anchor layout only when it reused clearly more in every round. */
export function decidePromptLayout(rounds: readonly PromptLayoutRound[]): Pick<PromptLayoutVerdict, 'layout' | 'reason'> {
  if (rounds.length < PROMPT_LAYOUT_PROBE_ROUNDS) return { layout: 'system', reason: 'probe_failed' };
  if (rounds.every((round) => round.systemReuse <= 0 && round.anchorReuse <= 0)) {
    return { layout: 'system', reason: 'no_prefix_cache' };
  }
  const anchorWins = rounds.every((round) => round.anchorReuse > round.systemReuse * 1.15 + 256);
  return anchorWins
    ? { layout: 'turn_anchor', reason: 'anchor_reused_more' }
    : { layout: 'system', reason: 'anchor_not_better' };
}

// --- turn anchor --------------------------------------------------------

type ContentPart = { type?: unknown; text?: unknown };

/** The visible text of a user message, in the item shape or the chat shape. */
export function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentPart[])
    .filter((part) => part && typeof part.text === 'string'
      && (part.type === 'input_text' || part.type === 'text'))
    .map((part) => part.text as string)
    .join('\n');
}

function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Digest of the user message that opened the current turn: the last user
 * message in the canonical model input. Host guidance for a single request is
 * appended after the canonical input, so it is never mistaken for the anchor
 * when the caller computes this before appending it.
 */
export function turnAnchorDigest(input: readonly unknown[]): string | undefined {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as { role?: unknown; type?: unknown; content?: unknown } | undefined;
    if (!item || item.role !== 'user') continue;
    if (item.type !== undefined && item.type !== 'message') continue;
    const text = userMessageText(item.content);
    return text.trim() ? textDigest(text) : undefined;
  }
  return undefined;
}

/**
 * Move the per-turn context to the turn anchor. Returns `undefined` (send the
 * body unchanged) unless the first system message carries the exact stable /
 * per-turn delimiter and the anchor message is present.
 */
export function placeTurnContextAtAnchor(
  body: Record<string, unknown>,
  anchorDigest: string | undefined,
): Record<string, unknown> | undefined {
  if (!anchorDigest || !Array.isArray(body.messages)) return undefined;
  const messages = body.messages as Array<Record<string, unknown>>;
  const system = messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return undefined;
  const at = system.content.indexOf(INSTRUCTION_CACHE_DELIM);
  if (at < 0) return undefined;
  const stable = system.content.slice(0, at);
  const perTurn = system.content.slice(at + INSTRUCTION_CACHE_DELIM.length);
  if (!stable.trim() || !perTurn.trim()) return undefined;
  let anchor = -1;
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = userMessageText(message.content);
    if (text.trim() && textDigest(text) === anchorDigest) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return undefined;
  return {
    ...body,
    messages: [
      { ...system, content: stable },
      ...messages.slice(1, anchor),
      { role: 'system', content: perTurn },
      ...messages.slice(anchor),
    ],
  };
}

// --- measurement ----------------------------------------------------------

type CreateFn = (params: Record<string, unknown>, options?: unknown) => Promise<unknown>;

function lines(tag: string, count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `${tag} guidance ${i}: keep answers short, cite the source of each figure, prefer verified reads, `
    + `never guess an identifier, and report exact numbers from tool results when they exist (${tag}-${i}).`,
  ).join('\n');
}

/** Synthetic request pair: identical except for the per-turn context. With
 *  `opening`, the anchor layout of a conversation's first turn, where the two
 *  system messages are adjacent. */
function probeRequest(
  model: string,
  nonce: string,
  layout: PromptLayout,
  version: 1 | 2,
  opening = false,
): Record<string, unknown> {
  const stable = `You are a measurement assistant ${nonce}.\n${lines('stable', 60)}`;
  const perTurn = `Turn context ${version} ${nonce}\n${lines(`turn${version}`, 12)}`;
  const earlierAsk = `Earlier request:\n${lines('earlier', 40)}`;
  const earlierAnswer = `Earlier answer:\n${lines('answer', 20)}`;
  const ask = 'Reply with the single digit 4.';
  const tools = Array.from({ length: 12 }, (_, i) => ({
    type: 'function',
    function: {
      name: `lookup_${i}`,
      description: lines(`tool${i}`, 4),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look up.' }, limit: { type: 'number' } },
        required: ['query'],
      },
    },
  }));
  if (opening) {
    return {
      model,
      messages: [
        { role: 'system', content: stable },
        { role: 'system', content: perTurn },
        { role: 'user', content: ask },
      ],
      tools,
      max_tokens: 16,
      stream: false,
    };
  }
  const messages = layout === 'system'
    ? [
        { role: 'system', content: `${stable}\n\n---\n\n${perTurn}` },
        { role: 'user', content: earlierAsk },
        { role: 'assistant', content: earlierAnswer },
        { role: 'user', content: ask },
      ]
    : [
        { role: 'system', content: stable },
        { role: 'user', content: earlierAsk },
        { role: 'assistant', content: earlierAnswer },
        { role: 'system', content: perTurn },
        { role: 'user', content: ask },
      ];
  return { model, messages, tools, max_tokens: 16, stream: false };
}

function usageOf(completion: unknown): { prompt: number; cached: number } {
  const usage = (completion as { usage?: Record<string, unknown> } | undefined)?.usage ?? {};
  const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return { prompt: n(usage.prompt_tokens), cached: n(details?.cached_tokens) || n(usage.cached_tokens) };
}

export interface PromptLayoutProbeInput {
  baseURL: string;
  model: string;
  /** The provider's unwrapped chat-completions create. */
  create: CreateFn;
  /** Every probe response, so its spend is recorded like any other call. */
  onUsage?: (completion: unknown, startedAt: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function measurePromptLayout(input: PromptLayoutProbeInput): Promise<PromptLayoutVerdict> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const rounds: PromptLayoutRound[] = [];
  const send = async (body: Record<string, unknown>): Promise<{ prompt: number; cached: number }> => {
    const startedAt = now();
    const completion = await input.create(body);
    input.onUsage?.(completion, startedAt);
    await sleep(PROBE_SPACING_MS);
    return usageOf(completion);
  };
  const reuseAfterChange = async (layout: PromptLayout): Promise<{ prompt: number; cached: number }> => {
    const nonce = randomUUID();
    await send(probeRequest(input.model, nonce, layout, 1));
    return send(probeRequest(input.model, nonce, layout, 2));
  };
  try {
    for (let round = 0; round < PROMPT_LAYOUT_PROBE_ROUNDS; round += 1) {
      // Alternate which layout goes first so ordering cannot favour either.
      const order: PromptLayout[] = round % 2 === 0 ? ['system', 'turn_anchor'] : ['turn_anchor', 'system'];
      const measured = new Map<PromptLayout, { prompt: number; cached: number }>();
      for (const layout of order) measured.set(layout, await reuseAfterChange(layout));
      rounds.push({
        prompt: measured.get('system')!.prompt,
        systemReuse: measured.get('system')!.cached,
        anchorReuse: measured.get('turn_anchor')!.cached,
      });
    }
    // A first turn puts the two system messages side by side; the provider
    // must accept that shape too before the layout can be used.
    await send(probeRequest(input.model, randomUUID(), 'turn_anchor', 1, true));
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    return {
      layout: 'system',
      reason: 'probe_failed',
      measuredAt: new Date(now()).toISOString(),
      rounds,
      detail: typeof status === 'number' ? `provider status ${status}` : 'provider request failed',
    };
  }
  return { ...decidePromptLayout(rounds), measuredAt: new Date(now()).toISOString(), rounds };
}

const inFlight = new Set<string>();

/** Captured at load, before any request exists. A measurement belongs to no
 *  turn: it must not inherit the triggering request's run context or have its
 *  spend recorded as that turn's work. */
const outsideAnyRequest = AsyncLocalStorage.snapshot();

/** Usage lane that identifies measurement spend in the usage log. */
export const PROMPT_LAYOUT_PROBE_CHANNEL = 'prompt-layout-probe';

/** Measure in the background when due; the current request never waits. */
export function schedulePromptLayoutProbe(input: PromptLayoutProbeInput): void {
  const key = promptLayoutKey(input.baseURL, input.model);
  if (inFlight.has(key) || !promptLayoutProbeDue(input.baseURL, input.model)) return;
  inFlight.add(key);
  outsideAnyRequest(() => withModelUsageAttribution(
    { sessionId: PROMPT_LAYOUT_PROBE_CHANNEL, sourceUserSeq: 0, channel: PROMPT_LAYOUT_PROBE_CHANNEL },
    () => {
      void (async () => {
        try {
          const verdict = await measurePromptLayout(input);
          recordPromptLayoutVerdict(input.baseURL, input.model, verdict);
          logger.info({ baseURL: input.baseURL, model: input.model, ...verdict }, 'measured prompt layout');
        } catch { /* measurement is additive; the system layout stays in use */ } finally {
          inFlight.delete(key);
        }
      })();
    },
  ));
}

export function _resetPromptLayoutForTest(): void {
  cache = null;
  inFlight.clear();
}
