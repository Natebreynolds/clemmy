/**
 * Candidate-assisted routing (v3.8.0/F2).
 *
 * This is the whole of what retrieval is allowed to do: given the accepted
 * request, produce a small, scoped set of PROVEN capabilities worth putting in
 * front of the brain. It does not choose an effect, arguments, or an account,
 * and it never authorizes a dispatch. The brain still selects; the governed
 * boundary still gates. A wrong candidate costs one ordinary cold turn.
 *
 * Two tiers, in cost order:
 *
 *   EXACT/LEXICAL (synchronous, always available) — the existing tool-choice
 *   matcher, which now also resolves an exact accepted-source alias. A phrase
 *   that already settled successfully retrieves its capability on repeat even
 *   though it never names the tool.
 *
 *   SEMANTIC (local model, deadline-bounded) — natural paraphrases. Runs ONLY
 *   against the bundled local model, only when it is already warm, and only
 *   inside a request-scoped deadline. A cold model warms in the background and
 *   the turn proceeds on the lexical tier: a chat turn never waits on a model
 *   load, and semantic retrieval being unavailable degrades the experience by
 *   one cold turn rather than breaking it.
 */
import {
  backfillCapabilityAliasEmbeddings,
  daemonAliasScope,
  semanticCapabilityAliases,
  type CapabilityAliasRow,
  type CapabilityAliasScope,
} from '../../memory/capability-alias-index.js';
import {
  getLocalEmbeddingProvider,
  localEmbeddingProviderSync,
  localEmbeddingSpaceKey,
} from '../../memory/embeddings.js';
import {
  getCachedToolSchema,
  liveComposioSchemaFingerprint,
} from '../../tools/composio-schema-cache.js';
import {
  listToolChoices,
  toolFamilyForChoice,
  type MatchToolChoicesOptions,
  type StepToolChoiceMatch,
} from '../../memory/tool-choice-store.js';
import {
  capabilityEffectIsCompatible,
  requestedCapabilityEffectScope,
  type CapabilityEffect,
  type RequestedCapabilityEffectScope,
} from '../../memory/capability-effect-scope.js';
import { requestSemanticSegments } from '../../assistant/request-segments.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  capabilityCandidateKey,
  diversifyCapabilities,
  lexicalCapabilityProjectionForRequest,
  type CapabilityRequirementSegment,
  type RoleScopedStepToolChoiceMatch,
} from './lexical-capability-matches.js';

export type CapabilityCandidateTier = 'exact' | 'semantic';

export type CapabilityCandidate = {
  identifier: string;
  kind: string;
  intent: string;
  /** Always `capability_only` today: retrieval never carries execution rights. */
  klass: string;
  /** The stable account this capability was proven against, when bound. */
  accountIdentity?: string;
  via: CapabilityCandidateTier;
  score: number;
  /** Receipt-backed aliases are read; legacy lexical rows may be unknown. */
  effectClass?: CapabilityEffect;
  /** Live request contract, when this daemon has current provider authority. */
  requiredFields?: string[];
  schemaFingerprint?: string;
  schemaAuthority?: 'live' | 'validation_only' | 'missing' | 'not_applicable';
  /** Runtime-owned requirement identity; never derived from provider/query words. */
  roleKey?: string;
  /** One proven operation may satisfy more than one clause. */
  roleKeys?: string[];
  /** Requirement roles this candidate has structural evidence to resolve.
   * Medium lexical overlaps stay advisory and are intentionally absent. */
  resolutionRoleKeys?: string[];
  requirementIndex?: number;
  requirementText?: string;
  requestedEffect?: RequestedCapabilityEffectScope;
};

export interface CapabilityRequirementDescriptor extends CapabilityRequirementSegment {
  resolved: boolean;
  /** Exact capabilities that resolve this requirement, with live schema keys. */
  resolvedCapabilities: CapabilityCandidate[];
}

export type TurnCapabilityCandidates = {
  candidates: CapabilityCandidate[];
  /** Source-ordered requirements, including genuinely unresolved roles. */
  requirements: CapabilityRequirementDescriptor[];
  /** Advisory matches for the existing MCP recall seam. */
  matches: StepToolChoiceMatch[];
  /** Tool names to pin into the turn's JIT surface. */
  pinnedTools: string[];
  /** Whether the semantic tier actually participated in THIS turn. */
  semanticApplied: boolean;
  /** Whether the accepted request is action-shaped and therefore consumes
   * role-scoped discovery. Omitted by legacy fixtures, which remain enabled. */
  roleScopedDiscovery?: boolean;
};

const DEFAULT_LIMIT = 5;
/** A request-scoped ceiling. A warm local embed is ~3ms; this is the point at
 *  which we stop waiting and answer from the lexical tier instead. */
const DEFAULT_DEADLINE_MS = 120;

function requiredFields(schema: Record<string, unknown> | null): string[] {
  const value = schema?.required;
  return Array.isArray(value)
    ? value.filter((field): field is string => typeof field === 'string').slice(0, 20)
    : [];
}

function attachLiveContract(candidate: CapabilityCandidate): CapabilityCandidate {
  if (candidate.kind !== 'composio') {
    return { ...candidate, schemaAuthority: 'not_applicable' };
  }
  const schema = getCachedToolSchema(candidate.identifier);
  const fingerprint = liveComposioSchemaFingerprint(candidate.identifier);
  if (fingerprint && schema) {
    return {
      ...candidate,
      schemaAuthority: 'live',
      schemaFingerprint: fingerprint,
      requiredFields: requiredFields(schema),
    };
  }
  return {
    ...candidate,
    schemaAuthority: schema ? 'validation_only' : 'missing',
  };
}

function candidateFromMatch(match: RoleScopedStepToolChoiceMatch): CapabilityCandidate {
  return attachLiveContract({
    identifier: match.identifier,
    kind: match.kind,
    intent: match.intent,
    klass: 'capability_only',
    ...(match.accountIdentity ? { accountIdentity: match.accountIdentity } : {}),
    via: 'exact',
    score: match.score,
    ...(match.effectClass ? { effectClass: match.effectClass } : {}),
    roleKey: match.roleKey,
    roleKeys: [match.roleKey],
    resolutionRoleKeys: match.tier === 'high' || match.acceptedPhraseAlias === true
      ? [match.roleKey]
      : [],
    requirementIndex: match.requirementIndex,
    requirementText: match.requirementText,
    requestedEffect: match.requestedEffect,
  });
}

function candidateFromAlias(
  row: CapabilityAliasRow,
  score: number,
  requirement: CapabilityRequirementSegment,
): CapabilityCandidate {
  return attachLiveContract({
    identifier: row.identifier,
    kind: row.kind,
    intent: row.intent,
    klass: row.klass,
    ...(row.accountIdentity ? { accountIdentity: row.accountIdentity } : {}),
    via: 'semantic',
    score,
    // The semantic alias index is materialized only from verified successful
    // read receipts; writes never enter this retrieval class.
    effectClass: 'read',
    // Semantic similarity is advisory evidence that this read may fit; it is
    // not evidence that an open-vocabulary clause itself is a read. Preserve
    // the runtime-owned role exactly and let only exact lexical receipt
    // agreement refine an unknown effect.
    roleKey: requirement.roleKey,
    roleKeys: [requirement.roleKey],
    resolutionRoleKeys: requirement.effect !== 'unknown' ? [requirement.roleKey] : [],
    requirementIndex: requirement.clauseIndex,
    requirementText: requirement.text,
    requestedEffect: requirement.effect,
  });
}

function mergeCandidate(
  current: CapabilityCandidate | undefined,
  incoming: CapabilityCandidate,
): CapabilityCandidate {
  if (!current) return incoming;
  const roleKeys = [...new Set([
    ...(current.roleKeys ?? (current.roleKey ? [current.roleKey] : [])),
    ...(incoming.roleKeys ?? (incoming.roleKey ? [incoming.roleKey] : [])),
  ])];
  const resolutionRoleKeys = [...new Set([
    ...(current.resolutionRoleKeys ?? []),
    ...(incoming.resolutionRoleKeys ?? []),
  ])];
  const preferred = incoming.score > current.score ? incoming : current;
  return {
    ...preferred,
    ...(roleKeys.length > 0 ? { roleKey: roleKeys[0], roleKeys } : {}),
    resolutionRoleKeys,
  };
}

function describeRequirements(
  requirements: readonly CapabilityRequirementSegment[],
  candidates: readonly CapabilityCandidate[],
): CapabilityRequirementDescriptor[] {
  return requirements.map((requirement) => {
    const roleCandidates = candidates.filter((candidate) =>
      (candidate.roleKeys ?? (candidate.roleKey ? [candidate.roleKey] : []))
        .includes(requirement.roleKey));
    // A strong lexical/exact-phrase match is structural evidence. Medium
    // overlap remains advisory even when its effect agrees: one generic action
    // token cannot let a stale memo settle a destination role. Semantic hits
    // populate this key only for known effects and never rewrite unknown roles.
    const resolvedCapabilities = roleCandidates.filter((candidate) =>
      candidate.resolutionRoleKeys?.includes(requirement.roleKey));
    return {
      ...requirement,
      resolved: resolvedCapabilities.length > 0,
      resolvedCapabilities,
    };
  });
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load the local model and give every stored alias a vector in the current
 * space. Production calls this once at startup (fire-and-forget); settlements
 * schedule their own incremental backfill so a mid-life learning event never
 * waits for the next boot.
 */
export async function warmCapabilityRetrieval(
  options: { scope?: CapabilityAliasScope } = {},
): Promise<boolean> {
  return backfillCapabilityAliasEmbeddings(options);
}

/**
 * The candidates worth showing the brain for THIS request. Advisory only.
 */
export async function resolveTurnCapabilityCandidates(options: {
  userInput: string;
  scope?: CapabilityAliasScope;
  limit?: number;
  deadlineMs?: number;
  liveSchemaFingerprintFor?: (identifier: string) => string | null | undefined;
  /** Deterministic fixture seam. Production reads the active procedural store. */
  choices?: MatchToolChoicesOptions['choices'];
  /** Semantic retrieval is on by default; tests may isolate the lexical class. */
  semantic?: boolean;
}): Promise<TurnCapabilityCandidates> {
  const input = options.userInput?.trim();
  if (!input) {
    return {
      candidates: [], requirements: [], matches: [], pinnedTools: [],
      semanticApplied: false, roleScopedDiscovery: false,
    };
  }
  const requestIntent = classifyMessageIntent(input).intent;
  const roleScopedDiscovery = requestIntent === 'action' || requestIntent === 'tool_intent';
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));
  const scope = options.scope ?? daemonAliasScope();

  let matches: RoleScopedStepToolChoiceMatch[] = [];
  let requirements: CapabilityRequirementSegment[] = [];
  try {
    const projection = lexicalCapabilityProjectionForRequest({
      userInput: input,
      limit,
      scope,
      liveSchemaFingerprintFor: options.liveSchemaFingerprintFor,
      choices: options.choices,
    });
    matches = projection.matches;
    requirements = projection.requirements;
  } catch { /* retrieval never fails a turn */ }

  const byIdentifier = new Map<string, CapabilityCandidate>();
  for (const match of matches) {
    const candidate = candidateFromMatch(match);
    const key = capabilityCandidateKey(candidate);
    byIdentifier.set(key, mergeCandidate(byIdentifier.get(key), candidate));
  }

  // Semantic tier: only against an ALREADY WARM local model, inside the
  // request deadline. A cold model warms in the background for later turns.
  let semanticApplied = false;
  const provider = options.semantic === false ? null : localEmbeddingProviderSync();
  if (provider) {
    const semanticRequirements = requirements.length > 0
      ? requirements
      : requestSemanticSegments(input).map((text, clauseIndex) => ({
          text,
          clauseIndex,
          effect: requestedCapabilityEffectScope(text),
          roleKey: `clause-${clauseIndex}:${requestedCapabilityEffectScope(text)}`,
        }));
    const semanticSegments = semanticRequirements.map((requirement) => requirement.text);
    const vectors = await withDeadline(
      provider.embed(semanticSegments).catch(() => null),
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );
    if (vectors?.some(Boolean)) {
      semanticApplied = true;
      for (let index = 0; index < semanticSegments.length; index += 1) {
        const query = vectors?.[index];
        if (!query) continue;
        const requestedEffect = requestedCapabilityEffectScope(semanticSegments[index] ?? input);
        const hits = semanticCapabilityAliases(query, {
          scope,
          embeddingSpace: localEmbeddingSpaceKey(),
          limit,
          // A moved provider contract stops a stored capability from serving;
          // an unknown contract proves nothing and passes through.
          liveSchemaFingerprintFor: options.liveSchemaFingerprintFor ?? liveComposioSchemaFingerprint,
        });
        for (const hit of hits) {
          const requirement = semanticRequirements[index];
          if (!requirement) continue;
          const candidate = candidateFromAlias(hit.row, hit.score, requirement);
          if (!capabilityEffectIsCompatible(requestedEffect, candidate.effectClass ?? 'unknown')) continue;
          const key = capabilityCandidateKey(candidate);
          byIdentifier.set(key, mergeCandidate(byIdentifier.get(key), candidate));
        }
      }
    }
  } else if (options.semantic !== false) {
    void getLocalEmbeddingProvider().catch(() => null);
  }

  const candidates = diversifyCapabilities([...byIdentifier.values()], limit);
  if (candidates.length === 0) {
    return {
      candidates: [],
      requirements: describeRequirements(requirements, []),
      matches: [],
      pinnedTools: [],
      semanticApplied,
      roleScopedDiscovery,
    };
  }
  const selectedKeys = new Set(candidates.map(capabilityCandidateKey));
  matches = matches.filter((match) => selectedKeys.has(capabilityCandidateKey(match)));

  // Pin the CARRIER each candidate needs, so the brain can actually reach it.
  // Retrieval widens what is visible; it never narrows what the brain may pick.
  const pinnedTools = new Set<string>();
  const records = (() => {
    try { return listToolChoices(); } catch { return []; }
  })();
  for (const candidate of candidates) {
    const record = records.find((r) => r.intent === candidate.intent && r.choice);
    if (record?.choice) for (const family of toolFamilyForChoice(record.choice)) pinnedTools.add(family);
  }

  // Every candidate the semantic tier contributed also becomes an advisory
  // match, so the MCP recall seam sees exactly what the JIT surface sees.
  const semanticMatches: StepToolChoiceMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.via !== 'semantic') continue;
    const record = records.find((r) => r.intent === candidate.intent && r.choice);
    if (!record?.choice) continue;
    semanticMatches.push({
      intent: record.intent,
      ...(record.procedureId ? { procedureId: record.procedureId } : {}),
      kind: record.choice.kind,
      identifier: record.choice.identifier,
      score: candidate.score,
      tier: 'medium',
      matched: [],
      alreadyBound: false,
      autoBindable: false,
      family: toolFamilyForChoice(record.choice),
      command: '',
    });
  }

  return {
    candidates,
    requirements: describeRequirements(requirements, candidates),
    matches: [...matches, ...semanticMatches],
    pinnedTools: [...pinnedTools],
    semanticApplied,
    roleScopedDiscovery,
  };
}

/**
 * The bounded advisory card a brain sees for its turn's candidates: kind,
 * exact identifier, intent, provenance — never prior invocation arguments,
 * which are exactly the thing a stale replay would be made of.
 */
export function renderCapabilityCandidateCard(resolved: TurnCapabilityCandidates | undefined): string {
  const rows = resolved?.candidates.slice(0, 5) ?? [];
  const requirements = resolved?.roleScopedDiscovery === false
    ? []
    : resolved?.requirements ?? [];
  if (rows.length === 0 && requirements.length === 0) return '';
  const lines = rows.map((c) => {
    const provenance = [
      c.klass,
      c.via === 'semantic' ? `matched by meaning (${c.score.toFixed(2)})` : 'proven for phrasing like this',
      ...(c.accountIdentity ? [`account ${c.accountIdentity}`] : []),
    ].join('; ');
    const contract = c.schemaAuthority === 'live'
      ? ` Live schema${c.requiredFields?.length ? ` requires: ${c.requiredFields.join(', ')}` : ' has no required keys'}.`
      : c.schemaAuthority === 'validation_only'
        ? ' A cached validation contract exists, but live schema authority must be refreshed exactly if validation rejects the call.'
        : c.schemaAuthority === 'missing'
          ? ' No current contract is mounted; one exact-schema refresh remains available.'
          : '';
    const execution = c.kind === 'composio'
      ? `Execute with \`composio_execute_tool\`; set \`tool_slug\` to exactly \`${c.identifier}\`.`
      : `Exact ${c.kind} identifier: \`${c.identifier}\`.`;
    const role = c.roleKey ? ` Requirement ${c.roleKey}.` : '';
    return `- ${execution}${contract}${role} Learned intent label (metadata only; NEVER a tool name): ${JSON.stringify(c.intent)} — ${provenance}`;
  });
  const unresolved = requirements.filter((requirement) => !requirement.resolved);
  const discovery = requirements.length === 0
    ? []
    : unresolved.length === 0
      ? [
          '## Discovery roles for this request',
          `All ${requirements.length} load-bearing requirement${requirements.length === 1 ? '' : 's'} already have resolved paths. Use them first; exact selected-tool schema repair remains available.`,
        ]
      : [
          '## Discovery roles for this request',
          'For broad `tool_search`, copy one unresolved `role_key` exactly; synonymous queries/providers for that key share its slot. Claude native ToolSearch uses a `[role:<role_key>]` query prefix. Exact selected-tool schema repair is separate.',
          ...unresolved.map((requirement) => {
            const text = requirement.text.replace(/\s+/g, ' ').trim();
            return `- role_key \`${requirement.roleKey}\`: ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`;
          }),
        ];
  return [
    ...discovery,
    ...(lines.length > 0 ? [
      '## Proven execution paths for this request (advisory)',
      'These worked before for requests like this one. Verify fit and choose fresh arguments/account — nothing here is pre-authorized.',
      'A learned intent label is descriptive metadata, not an executable tool. NEVER pass it to `call_tool`. For a Composio row, call `composio_execute_tool` with the exact identifier as `tool_slug`; do not rediscover that capability.',
      ...lines,
    ] : []),
  ].join('\n');
}
