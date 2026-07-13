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
 * Kill-switch CLEMMY_SKILL_DISTILLER=off (and the master CLEMMY_GOAL_CONTRACT).
 *
 * Novelty gate (deterministic, BEFORE any LLM call): a routine execution — one
 * that purely ran an existing skill or a fully-specified workflow — distills
 * nothing. Only a session that did real discovery/trial-and-error qualifies.
 */
import pino from 'pino';
import { z } from 'zod';
import { Agent, Runner } from '@openai/agents';
import { getRuntimeEnv, MODELS } from '../config.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { readSessionTrace, readSessionToolReturns, type TraceToolCall } from '../execution/trace-to-workflow.js';
import {
  listSkills, loadSkill, writeDistilledSkill, isSafeSkillName,
  updateSkillFrontmatter, appendSkillPitfall, type Skill,
} from './skill-store.js';
import { evidenceLooksFailedOrBlocked } from './tool-choice-store.js';
import { isTransientFailure } from './procedural-recall-link.js';
import { addNotification } from '../runtime/notifications.js';
import { rememberFact } from './facts.js';

const logger = pino({ name: 'clementine-next.skill-distiller' });

function distillerEnabled(): boolean {
  if ((getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() === 'off') return false;
  return (getRuntimeEnv('CLEMMY_SKILL_DISTILLER', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Wave 2 Move B: on a quarantine (a proven-repeated failure), persist the lesson
 *  as a durable, recallable fact so it outlives the draft. Kill-switch =off. */
function failureLearningEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_FAILURE_LEARNING', 'on') ?? 'on').toLowerCase() !== 'off';
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
}

/**
 * Did this session figure something out worth keeping? Requires real work
 * (≥5 substantive calls), breadth (≥2 tool families), AND evidence of discovery
 * (a composio_search_tools call, or the same slug retried with changed args —
 * trial-and-error). A session that just executed a known recipe fails the gate.
 */
export function assessNovelty(calls: TraceToolCall[]): NoveltyAssessment {
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
  const hadDiscovery = searched || retriedWithChange;
  const novel = substantive.length >= 5 && families.size >= 2 && hadDiscovery;
  return {
    novel,
    reason: novel
      ? 'session did multi-system discovery worth distilling'
      : `not novel (calls=${substantive.length}/5, families=${families.size}/2, discovery=${hadDiscovery})`,
    substantiveCalls: substantive.length,
    families: families.size,
    hadDiscovery,
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
 * Returns null when there's no corrected retry, or when the failure is TRANSIENT
 * (429/timeout/5xx) — a transient blip is not a reusable lesson and would poison
 * the draft with a bogus "recovery". Pure: caller supplies calls + results.
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

/** Cheap dedup: an existing skill with the same name, or a near-identical
 *  description (normalized-token Jaccard ≥ 0.8), means we don't spawn a variant. */
function findDuplicate(name: string, description: string): Skill | null {
  const existing = listSkills();
  const byName = existing.find((s) => s.name === name);
  if (byName) return byName;
  const tokens = (t: string) => new Set(t.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const a = tokens(description);
  for (const s of existing) {
    const b = tokens(s.frontmatter.description || '');
    if (a.size === 0 || b.size === 0) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const jaccard = inter / (a.size + b.size - inter);
    if (jaccard >= 0.8) return s;
  }
  return null;
}

export interface DistillResult {
  status: 'written' | 'skipped_not_novel' | 'skipped_duplicate' | 'skipped_disabled' | 'failed';
  name?: string;
  detail?: string;
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
    const calls = readSessionTrace(sessionId);
    if (!context.force) {
      const novelty = assessNovelty(calls);
      if (!novelty.novel) return { status: 'skipped_not_novel', detail: novelty.reason };
    }
    if (calls.length === 0) return { status: 'skipped_not_novel', detail: 'no tool calls in trace' };
    return distillFromCalls(calls, context);
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

    const dup = findDuplicate(draft.name, draft.description);
    if (dup) {
      // A re-distillation of an existing DRAFT merges (we just bump useCount via
      // the normal success path); an approved match is left untouched.
      return { status: 'skipped_duplicate', detail: `matches existing skill "${dup.name}"`, name: dup.name };
    }

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

    const body = renderSkillBody(draft);
    const name = writeDistilledSkill({
      name: draft.name,
      description: draft.description,
      body,
      origin: context.origin,
      applicability,
    });
    if (!name) return { status: 'failed', detail: 'write failed' };

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
    const calls = sessionIds.flatMap((id) => {
      try { return readSessionTrace(id); } catch { return []; }
    });
    const novelty = assessNovelty(calls);
    if (!novelty.novel) return { status: 'skipped_not_novel', detail: novelty.reason };
    // Reuse the single-session path by faking a combined trace through a tiny
    // shim: write the calls onto a synthetic objective + run the same pipeline.
    return distillFromCalls(calls, {
      objective: context.objective,
      evidence: context.evidence ?? '',
      origin: { kind: 'workflow', sourceId: context.sourceId },
    });
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
export function reinforceDraftSkills(
  skillNames: string[],
  outcome: 'success' | 'failure',
  reason?: string,
  sessionId?: string,
): void {
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
      if (outcome === 'success') {
        const useCount = (skill.frontmatter.useCount ?? 0) + 1;
        updateSkillFrontmatter(name, useCount >= 2 ? { useCount, tier: 'approved' } : { useCount });
      } else {
        const failureCount = (skill.frontmatter.failureCount ?? 0) + 1;
        const line = recoveryTip ?? (reason ? `FAILED: ${reason}` : 'FAILED (unspecified)');
        appendSkillPitfall(name, line.slice(0, 200));
        const quarantined = failureCount >= 2;
        updateSkillFrontmatter(name, quarantined ? { failureCount, quarantined: true } : { failureCount });
        // Wave 2 Move B: when an approach is QUARANTINED (2+ real failures — proven
        // bad, not transient), persist the lesson as a durable, deduped 'feedback'
        // fact. Today the lesson lives only on the quarantined draft and dies with
        // it; as a fact it survives deletion AND surfaces via unified recall on a
        // future relevant turn, so a proven failure doesn't silently repeat in an
        // unrelated later session. High-signal + rare + content-hash-deduped, so it
        // never pollutes recall. Best-effort; a lesson write must never break
        // reinforcement.
        if (quarantined && failureLearningEnabled()) {
          try {
            rememberFact({
              kind: 'feedback',
              content: `Avoid repeating this: the "${name}" approach failed repeatedly and was retired. ${line}`.slice(0, 400),
              ...(sessionId ? { derivedFrom: { sessionId, tool: 'skill_reinforce' } } : {}),
              trustLevel: 0.6,
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
