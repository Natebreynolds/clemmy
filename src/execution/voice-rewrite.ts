/**
 * Voice pass for workflow report-backs. Rewrites a technical terminal report
 * into Clementine's warm, first-person voice AND flags a routine no-op — so a
 * scheduled run that found nothing new can be silenced instead of pinging the
 * user with "No qualifying unread Inbox emails were found using the bounded UTC
 * filter window…". One cheap fast-model call, structured output, FAIL-OPEN:
 * any error/timeout/empty returns the original text with nothingHappened=false,
 * so a completed/failed run is NEVER blocked or wrongly silenced by a hiccup.
 *
 * Mirrors judgeObjectiveComplete (objective-judge.ts): bare Agent+Runner on
 * MODELS.fast, maxTurns:1, no tools, Clementine-owned parse/sanitize, try/catch fail-open.
 */
import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { MODELS, ASSISTANT_NAME, OWNER_NAME } from '../config.js';
import { loadUserProfile, DEFAULT_USER_PROFILE, type UserProfile } from '../runtime/user-profile.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';

// Bodies above this just get delivered verbatim — not worth a rewrite call.
const MAX_BODY = 8000;

const VoiceSchema = z.object({
  message: z.string().describe("The report rewritten in Clementine's warm, first-person voice to the user. Same facts, same verdict, no headers/quotes — just human tone."),
  nothingHappened: z.boolean().describe('True ONLY for a routine run that found nothing new and took no meaningful action (e.g. no new emails to triage) — nothing the user needs to see. False if anything was found, changed, sent, drafted, or needs review.'),
});

export interface VoiceRewriteOpts {
  workflowName: string;
  /** done = succeeded; blocked = needs attention; failed = errored. A
   *  blocked/failed report may NEVER be reworded into a success or a no-op. */
  lane: 'done' | 'blocked' | 'failed';
}
export interface VoiceRewriteResult { message: string; nothingHappened: boolean }

function resolveName(p: UserProfile): string | null {
  const n = p.preferredName ?? p.displayName;
  if (n && n !== DEFAULT_USER_PROFILE.displayName) return n;
  return OWNER_NAME || null;
}

function buildVoicePrompt(p: UserProfile, name: string | null, lane: VoiceRewriteOpts['lane']): string {
  const addressee = name ?? 'the user';
  const toneLine = p.communicationTone === 'terse' ? 'One or two sentences. No recap, no filler.'
    : p.communicationTone === 'verbose' ? 'Complete but never padded.'
      : 'Tight and complete.';
  const formalityLine = p.formality === 'casual' ? 'Casual — contractions, plain words, no corporate-speak.'
    : p.formality === 'formal' ? 'Formal — full sentences, courteous, no contractions.'
      : 'Professional and direct — no jargon, no over-formality.';
  const verdictLine = lane === 'done'
    ? 'This run SUCCEEDED — report it as done, warmly.'
    : lane === 'blocked'
      ? 'This run NEEDS ATTENTION — it did NOT fully succeed. Be honest it hit a snag and keep, VERBATIM, the one next step the report names (e.g. an `apply fix <id>` reply). Never call it done/all-set/complete.'
      : 'This run FAILED. Open warm, say plainly what broke, and end with EXACTLY the one next step the report gives (keep any `apply fix <id>` verbatim). Never imply success.';
  return [
    `You are ${ASSISTANT_NAME}, a persistent executive assistant for ${addressee}.`,
    `Your job: rewrite the background-workflow report into your own warm, first-person voice, addressed to ${addressee}. This is a TONE pass only — not a new report.`,
    'VOICE:',
    '- Sharp operator: no preamble, no warmups, no sign-off.',
    `- ${toneLine}`,
    `- ${formalityLine}`,
    name ? `- Open by addressing them as ${name} (e.g. "Hey ${name} —").` : '- Address them directly; do not invent a name.',
    '- Speak from the resolved meaning, never the plumbing: no field/column/step names, no JSON, no internal process narration, no timestamps or "bounded UTC filter window" jargon.',
    'ABSOLUTE RULES (a violation means you failed):',
    '1. PRESERVE EVERY FACT — keep every number, count, name, link, URL, file path, and id EXACTLY as written. Do not round, drop, merge, or invent.',
    '2. ADD NOTHING you cannot ground in the report below.',
    `3. DO NOT CHANGE THE VERDICT. ${verdictLine}`,
    'Set `nothingHappened` true ONLY for a routine, all-clear run that found nothing new and did nothing meaningful; false if anything was found/changed/sent/drafted or needs review. On a needs-attention or failed report it is ALWAYS false.',
    'Return ONLY JSON: {"message":"rewritten report text","nothingHappened":true|false}. No markdown fences unless the runtime forces them.',
  ].join('\n');
}

const SUCCESS_VOCAB = /\b(all set|all done|completed successfully|good to go|no action needed|nothing to (?:do|triage|report))\b/i;

/**
 * Apply the safety guards to a model result. Pure + deterministic (no LLM) so
 * the verdict-preservation rules can be unit-tested:
 *  - a blocked/failed report may never be reworded into success vocab → fall back
 *    to the original text rather than ship a tone that lies about the verdict.
 *  - only a clean 'done' lane can ever be a no-op (blocked/failed always deliver).
 *  - an empty rewrite falls back to the original body.
 */
export function applyVoiceGuards(
  raw: { message: string; nothingHappened: boolean } | null,
  body: string,
  lane: VoiceRewriteOpts['lane'],
): VoiceRewriteResult {
  const candidate = (raw?.message ?? '').trim();
  if (!candidate) return { message: body, nothingHappened: false };
  // A blocked/failed lane may never be reworded into success — fall back.
  const message = lane !== 'done' && SUCCESS_VOCAB.test(candidate) ? body : candidate;
  // Only a clean 'done' run can ever be a no-op.
  const nothingHappened = lane === 'done' && raw?.nothingHappened === true;
  return { message, nothingHappened };
}

function parseVoiceJson(value: unknown): unknown | null {
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

function sanitizeVoiceOutput(value: unknown): { message: string; nothingHappened: boolean } | null {
  if (typeof value === 'string') {
    const parsed = parseVoiceJson(value);
    if (!parsed) {
      const message = value.trim();
      return message ? { message, nothingHappened: false } : null;
    }
    value = parsed;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const rawMessage = obj.message ?? obj.text ?? obj.reply ?? obj.output;
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (!message) return null;
  const rawNoop = obj.nothingHappened ?? obj.nothing_happened ?? obj.noop ?? obj.silent;
  const nothingHappened = typeof rawNoop === 'boolean'
    ? rawNoop
    : typeof rawNoop === 'string'
      ? /^(true|yes|1)$/i.test(rawNoop.trim())
      : false;
  return { message, nothingHappened };
}

export function _testOnly_sanitizeVoiceOutput(value: unknown): { message: string; nothingHappened: boolean } | null {
  return sanitizeVoiceOutput(value);
}

export async function rewriteInClementineVoice(body: string, opts: VoiceRewriteOpts): Promise<VoiceRewriteResult> {
  const text = (body ?? '').trim();
  if (!text || text.length > MAX_BODY) return { message: body, nothingHappened: false };
  try {
    const profile = loadUserProfile();
    const name = resolveName(profile);
    const agent = new Agent({
      name: 'ClementineVoiceRewrite',
      instructions: buildVoicePrompt(profile, name, opts.lane),
      model: MODELS.fast,
      tools: [],
    });
    const result = await new Runner({ workflowName: 'clementine-voice-rewrite' }).run(
      agent,
      `Workflow: ${opts.workflowName}\n\nReport to rewrite (keep every fact, just warm the tone):\n${text}`,
      { maxTurns: 1 },
    );
    const parsed = VoiceSchema.safeParse(sanitizeVoiceOutput((result as { finalOutput?: unknown }).finalOutput));
    if (!parsed.success) return { message: body, nothingHappened: false };
    return applyVoiceGuards(parsed.data, body, opts.lane);
  } catch {
    return { message: body, nothingHappened: false };
  }
}
