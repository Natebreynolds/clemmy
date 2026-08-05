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
import { liveComposioSchemaFingerprint } from '../../tools/composio-schema-cache.js';
import {
  listToolChoices,
  matchToolChoicesForStep,
  toolFamilyForChoice,
  type StepToolChoiceMatch,
} from '../../memory/tool-choice-store.js';

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
};

export type TurnCapabilityCandidates = {
  candidates: CapabilityCandidate[];
  /** Advisory matches for the existing MCP recall seam. */
  matches: StepToolChoiceMatch[];
  /** Tool names to pin into the turn's JIT surface. */
  pinnedTools: string[];
  /** Whether the semantic tier actually participated in THIS turn. */
  semanticApplied: boolean;
};

const DEFAULT_LIMIT = 5;
/** A request-scoped ceiling. A warm local embed is ~3ms; this is the point at
 *  which we stop waiting and answer from the lexical tier instead. */
const DEFAULT_DEADLINE_MS = 120;

function candidateFromMatch(match: StepToolChoiceMatch): CapabilityCandidate {
  return {
    identifier: match.identifier,
    kind: match.kind,
    intent: match.intent,
    klass: 'capability_only',
    via: 'exact',
    score: match.score,
  };
}

function candidateFromAlias(row: CapabilityAliasRow, score: number): CapabilityCandidate {
  return {
    identifier: row.identifier,
    kind: row.kind,
    intent: row.intent,
    klass: row.klass,
    ...(row.accountIdentity ? { accountIdentity: row.accountIdentity } : {}),
    via: 'semantic',
    score,
  };
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
}): Promise<TurnCapabilityCandidates> {
  const empty: TurnCapabilityCandidates = {
    candidates: [], matches: [], pinnedTools: [], semanticApplied: false,
  };
  const input = options.userInput?.trim();
  if (!input) return empty;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));
  const scope = options.scope ?? daemonAliasScope();

  let matches: StepToolChoiceMatch[] = [];
  try {
    matches = matchToolChoicesForStep(input, { limit, scope });
  } catch { /* retrieval never fails a turn */ }

  const byIdentifier = new Map<string, CapabilityCandidate>();
  for (const match of matches) byIdentifier.set(match.identifier, candidateFromMatch(match));

  // Semantic tier: only against an ALREADY WARM local model, inside the
  // request deadline. A cold model warms in the background for later turns.
  let semanticApplied = false;
  const provider = localEmbeddingProviderSync();
  if (provider) {
    const vectors = await withDeadline(
      provider.embed([input]).catch(() => null),
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );
    const query = vectors?.[0];
    if (query) {
      semanticApplied = true;
      const hits = semanticCapabilityAliases(query, {
        scope,
        embeddingSpace: localEmbeddingSpaceKey(),
        limit,
        // A moved provider contract stops a stored capability from serving;
        // an unknown contract proves nothing and passes through.
        liveSchemaFingerprintFor: options.liveSchemaFingerprintFor ?? liveComposioSchemaFingerprint,
      });
      for (const hit of hits) {
        if (byIdentifier.has(hit.row.identifier)) continue;
        byIdentifier.set(hit.row.identifier, candidateFromAlias(hit.row, hit.score));
      }
    }
  } else {
    void getLocalEmbeddingProvider().catch(() => null);
  }

  const candidates = [...byIdentifier.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (candidates.length === 0) return empty;

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
    matches: [...matches, ...semanticMatches],
    pinnedTools: [...pinnedTools],
    semanticApplied,
  };
}

/**
 * The bounded advisory card a brain sees for its turn's candidates: kind,
 * exact identifier, intent, provenance — never prior invocation arguments,
 * which are exactly the thing a stale replay would be made of.
 */
export function renderCapabilityCandidateCard(resolved: TurnCapabilityCandidates | undefined): string {
  const rows = resolved?.candidates.slice(0, 5) ?? [];
  if (rows.length === 0) return '';
  const lines = rows.map((c) => {
    const provenance = [
      c.klass,
      c.via === 'semantic' ? `matched by meaning (${c.score.toFixed(2)})` : 'proven for phrasing like this',
      ...(c.accountIdentity ? [`account ${c.accountIdentity}`] : []),
    ].join('; ');
    return `- ${c.kind} \`${c.identifier}\` (${c.intent}) — ${provenance}`;
  });
  return [
    '## Proven capabilities for this request (advisory)',
    'These worked before for requests like this one. Verify fit and choose your own arguments/account — nothing here is pre-authorized.',
    ...lines,
  ].join('\n');
}
