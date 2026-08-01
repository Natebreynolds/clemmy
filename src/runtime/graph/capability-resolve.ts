/**
 * Capability resolution — turning a `capability_resolve` node's DEFERRED
 * requirements into a statement of what this machine can actually do right now.
 *
 * The compiler already emits the node and says what it needs (tool, mcp_server,
 * skill, workflow). Nothing answered it. That gap is the one the owner keeps
 * hitting in demos, and the live log shows exactly how it fails:
 *
 *   "I'll pull 20 eligible law firms and named contacts read-only via the
 *    Salesforce CLI … then create one Google Sheet named Firm Outreach
 *    Drafts — Jul 23. Reply go and I'll run it autonomously."
 *
 * A confident, specific, checkable plan — composed without looking at anything.
 * A later run died mid-flight on "Salesforce is disconnected (the saved login
 * expired)", a fact `capability-health` already held at the moment that plan was
 * written. The proposal was not wrong because the model was careless; it was
 * wrong because nothing in the runtime was asked.
 *
 * So this resolver answers three questions, and keeps them SEPARATE, because
 * collapsing them is what produces a plan that over-promises:
 *
 *   PROVEN     — this exact kind of work has succeeded with this binding before.
 *                Recall, not rediscovery. The reason a second identical request
 *                costs no survey at all.
 *   AVAILABLE  — connected and healthy, but unproven for this objective. Usable,
 *                and honestly described as a first attempt.
 *   DEGRADED   — known broken, expired, or unreachable. Must never appear in a
 *                plan as though it will work. This is the Salesforce case.
 *
 * Read-only and side-effect free: it reads the same stores the chat lane already
 * reads, so it can run before a user has approved anything. That is the whole
 * point — grounding a proposal must be free, or it will not happen.
 */
import { listHarnessCapabilityHealth } from '../harness/capability-health.js';
import { matchSkillChoices } from '../../memory/skill-choice-store.js';
import { matchToolChoicesForStep } from '../../memory/tool-choice-store.js';
import { resolveMcpToolScopeWithRecall } from '../mcp-tool-scope.js';
import type { TurnGraphCapabilityRequirement } from './turn-graph-ir.js';

export type CapabilityStanding = 'proven' | 'available' | 'degraded';

export interface ResolvedCapability {
  kind: TurnGraphCapabilityRequirement['kind'];
  /** Stable identifier: a tool name, slug, server slug, or skill name. */
  id: string;
  standing: CapabilityStanding;
  /** Why it carries this standing — evidence, not adjectives. */
  because: string;
}

export interface ResolvedCapabilities {
  /** Everything resolved, in standing order: proven, available, degraded. */
  capabilities: ResolvedCapability[];
  /** True when NOTHING is proven for this objective — a cold intent. The plan
   *  should say so plainly rather than implying prior experience it lacks. */
  cold: boolean;
  /** Requirements the caller pinned explicitly; passed through untouched. */
  explicit: string[];
}

/** Health states that must never be promised in a plan. */
const UNUSABLE_STATES: ReadonlySet<string> = new Set(['degraded', 'unavailable']);

function degradedCapabilities(): ResolvedCapability[] {
  let records: ReturnType<typeof listHarnessCapabilityHealth>;
  try {
    records = listHarnessCapabilityHealth({ includeHealthy: false });
  } catch {
    return [];
  }
  return records
    .filter((record) => UNUSABLE_STATES.has(record.state))
    .map((record) => ({
      kind: 'tool' as const,
      id: record.id,
      standing: 'degraded' as const,
      because: record.reason?.trim() || record.summary?.trim() || `reported ${record.state}`,
    }));
}

/**
 * Proven tool bindings for this objective. Only HIGH-tier matches count as
 * proven: a weak lexical overlap is a guess wearing evidence's clothes, and a
 * plan that cites it as experience is worse than one that admits it is new here.
 */
function provenTools(objective: string): ResolvedCapability[] {
  try {
    return matchToolChoicesForStep(objective, { limit: 5 })
      .filter((match) => match.tier === 'high')
      .map((match) => ({
        kind: match.kind === 'mcp' ? ('mcp_server' as const) : ('tool' as const),
        id: match.identifier,
        standing: 'proven' as const,
        because: `bound before for "${match.intent}"`,
      }));
  } catch {
    return [];
  }
}

function provenSkills(objective: string): ResolvedCapability[] {
  try {
    return matchSkillChoices(objective, 2)
      // A memo whose skill was since uninstalled resolves to null. Nothing to
      // name, so nothing to promise.
      .filter((match): match is typeof match & { record: { skill: string } } =>
        typeof match.record.skill === 'string' && match.record.skill.length > 0)
      .map((match) => ({
        kind: 'skill' as const,
        id: match.record.skill,
        standing: 'proven' as const,
        because: `proven standard for "${match.record.intent}"`,
      }));
  } catch {
    return [];
  }
}

/**
 * Connected servers this objective would plausibly reach. Reuses the SAME scope
 * resolver the turn will use, so a plan can never name reach the run will not
 * be granted — the two would otherwise drift, which is precisely how a
 * destination vocabulary and an authority vocabulary ended up disagreeing.
 */
function availableServers(objective: string, awaitingAnswer: boolean): ResolvedCapability[] {
  try {
    const scope = resolveMcpToolScopeWithRecall({ userInput: objective, awaitingAnswer });
    return (scope.allowedServerSlugs ?? []).map((slug) => ({
      kind: 'mcp_server' as const,
      id: slug,
      standing: 'available' as const,
      because: 'connected and in scope for this request',
    }));
  } catch {
    return [];
  }
}

const STANDING_ORDER: Record<CapabilityStanding, number> = { proven: 0, available: 1, degraded: 2 };

/**
 * Resolve one `capability_resolve` node. `requirements` come straight from the
 * compiled IR; an `explicit` requirement is authority the caller already pinned
 * and is passed through rather than re-derived.
 */
export function resolveTurnCapabilities(input: {
  objective: string;
  requirements: readonly TurnGraphCapabilityRequirement[];
  /** The previous turn asked a question, so scope inherits. Same signal the
   *  MCP scope resolver uses; threaded so a go-ahead resolves like its request. */
  awaitingAnswer?: boolean;
}): ResolvedCapabilities {
  const objective = (input.objective ?? '').trim();
  const wants = new Set(input.requirements.filter((r) => r.resolution === 'deferred').map((r) => r.kind));
  const explicit = input.requirements
    .filter((requirement) => requirement.resolution === 'explicit')
    .flatMap((requirement) => requirement.names ?? []);

  const resolved: ResolvedCapability[] = [];
  if (objective) {
    if (wants.has('tool') || wants.has('mcp_server')) resolved.push(...provenTools(objective));
    if (wants.has('skill')) resolved.push(...provenSkills(objective));
    if (wants.has('mcp_server')) resolved.push(...availableServers(objective, input.awaitingAnswer === true));
  }
  // Degraded capabilities are reported whatever was asked for. A plan that does
  // not mention the tool is still a plan the user will read as "everything is
  // fine", and the one thing we know is broken belongs in front of them.
  resolved.push(...degradedCapabilities());

  // Ill health is a property of the THING, not of the kind we happened to
  // resolve it under. Salesforce reaches this list twice — once as a connected
  // mcp_server the objective names, once as a degraded tool — and a per-kind
  // de-dup let the "connected" row survive alongside the warning, so a plan
  // reading the available line would promise it anyway. That is the precise
  // failure this resolver exists to prevent, caught by its own pin. So a
  // degraded id poisons every standing for that id.
  const degradedIds = new Set(
    resolved.filter((capability) => capability.standing === 'degraded').map((capability) => capability.id.toLowerCase()),
  );
  const byKey = new Map<string, ResolvedCapability>();
  for (const capability of resolved) {
    if (capability.standing !== 'degraded' && degradedIds.has(capability.id.toLowerCase())) continue;
    const key = `${capability.kind}:${capability.id.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, capability); continue; }
    if (STANDING_ORDER[capability.standing] < STANDING_ORDER[existing.standing]) byKey.set(key, capability);
  }

  const capabilities = [...byKey.values()].sort((left, right) =>
    STANDING_ORDER[left.standing] - STANDING_ORDER[right.standing] || left.id.localeCompare(right.id));

  return {
    capabilities,
    cold: !capabilities.some((capability) => capability.standing === 'proven'),
    explicit,
  };
}

/**
 * The grounding a proposal is built from, in the model's reading order. Compact
 * on purpose: this rides into a turn that has not been approved yet, so it must
 * cost a few lines, not a catalog. Returns '' when there is nothing to say, so
 * an ordinary turn is byte-identical to today.
 */
export function renderCapabilityGrounding(resolved: ResolvedCapabilities): string {
  if (resolved.capabilities.length === 0) return '';
  const lines: string[] = ['[capabilities — what you actually have for this, checked just now]'];
  const say = (standing: CapabilityStanding, label: string): void => {
    const rows = resolved.capabilities.filter((capability) => capability.standing === standing);
    if (rows.length === 0) return;
    lines.push(`${label}: ${rows.map((row) => `${row.id} (${row.because})`).join('; ')}`);
  };
  say('proven', 'PROVEN here before');
  say('available', 'CONNECTED, not yet used for this');
  say('degraded', 'DO NOT PROMISE — known broken');
  if (resolved.cold) {
    lines.push('Nothing is proven for this kind of work yet. Say so plainly rather than implying experience you do not have.');
  }
  lines.push('Name the ones you will actually use. Never name a DO-NOT-PROMISE capability as part of the plan.');
  return lines.join('\n');
}
