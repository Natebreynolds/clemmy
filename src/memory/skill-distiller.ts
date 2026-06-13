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
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { readSessionTrace, type TraceToolCall } from '../execution/trace-to-workflow.js';
import {
  listSkills, loadSkill, writeDistilledSkill, isSafeSkillName,
  updateSkillFrontmatter, appendSkillPitfall, type Skill,
} from './skill-store.js';
import { addNotification } from '../runtime/notifications.js';

const logger = pino({ name: 'clementine-next.skill-distiller' });

function distillerEnabled(): boolean {
  if ((getRuntimeEnv('CLEMMY_GOAL_CONTRACT', 'on') ?? 'on').toLowerCase() === 'off') return false;
  return (getRuntimeEnv('CLEMMY_SKILL_DISTILLER', 'on') ?? 'on').toLowerCase() !== 'off';
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

function buildDistillerAgent(): Agent<unknown, typeof DistilledSchema> {
  return new Agent<unknown, typeof DistilledSchema>({
    name: 'SkillDistiller',
    model: MODELS.fast,
    modelSettings: { reasoning: { effort: 'low' } },
    instructions: [
      'You distill a REUSABLE skill from a successful run. Output a SKILL.md draft that lets the agent repeat this capability next time without re-discovering it.',
      'Generalize: strip one-off specifics (this client, this date), keep the transferable procedure + the PROVEN tool slugs and argument SHAPES.',
      'Never include secret values (tokens, full emails/PII) — only argument keys/shapes.',
      'requires: list real prerequisites (mcp:/cli:/secret:) the procedure depends on. Empty array if none.',
      'Be concrete and short. This is a procedure to execute, not an essay.',
    ].join('\n'),
    outputType: normalizeZodForCodexStrict(DistilledSchema) as typeof DistilledSchema,
    tools: [],
  });
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
    const parsed = DistilledSchema.safeParse(result.finalOutput);
    if (!parsed.success) return { status: 'failed', detail: 'distiller output did not parse' };
    const draft = parsed.data;
    if (!isSafeSkillName(draft.name)) return { status: 'failed', detail: `unsafe skill name: ${draft.name}` };

    const dup = findDuplicate(draft.name, draft.description);
    if (dup) {
      // A re-distillation of an existing DRAFT merges (we just bump useCount via
      // the normal success path); an approved match is left untouched.
      return { status: 'skipped_duplicate', detail: `matches existing skill "${dup.name}"`, name: dup.name };
    }

    const body = renderSkillBody(draft);
    const name = writeDistilledSkill({
      name: draft.name,
      description: draft.description,
      body,
      origin: context.origin,
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
): void {
  if (!distillerEnabled()) return;
  for (const name of new Set(skillNames)) {
    try {
      const skill = loadSkill(name);
      if (!skill || skill.frontmatter.tier !== 'draft' || skill.frontmatter.quarantined) continue;
      if (outcome === 'success') {
        const useCount = (skill.frontmatter.useCount ?? 0) + 1;
        updateSkillFrontmatter(name, useCount >= 2 ? { useCount, tier: 'approved' } : { useCount });
      } else {
        const failureCount = (skill.frontmatter.failureCount ?? 0) + 1;
        appendSkillPitfall(name, (reason ? `FAILED: ${reason}` : 'FAILED (unspecified)').slice(0, 200));
        updateSkillFrontmatter(name, failureCount >= 2 ? { failureCount, quarantined: true } : { failureCount });
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
