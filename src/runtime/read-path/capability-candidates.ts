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
  aliasRowsMissingEmbedding,
  attachCapabilityAliasEmbedding,
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
 * space. Production calls this once at startup (fire-and-forget); a caller that
 * needs semantic retrieval to be live right now awaits it.
 */
export async function warmCapabilityRetrieval(
  options: { scope?: CapabilityAliasScope } = {},
): Promise<boolean> {
  const provider = await getLocalEmbeddingProvider();
  if (!provider) return false;
  const space = localEmbeddingSpaceKey();
  for (;;) {
    const pending = aliasRowsMissingEmbedding(space, { ...options, limit: 32 });
    if (pending.length === 0) return true;
    let vectors: Float32Array[] | null = null;
    try {
      vectors = await provider.embed(pending.map((row) => row.terms.join(' ')));
    } catch {
      return false;
    }
    if (!vectors || vectors.length !== pending.length) return false;
    let wrote = 0;
    pending.forEach((row, index) => {
      const vector = vectors![index];
      if (!vector) return;
      if (attachCapabilityAliasEmbedding(row.aliasDigest, options.scope, vector, space)) wrote += 1;
    });
    // A row that will not take a vector must not spin this loop forever.
    if (wrote === 0) return false;
  }
}

/**
 * The candidates worth showing the brain for THIS request. Advisory only.
 */
export async function resolveTurnCapabilityCandidates(options: {
  userInput: string;
  scope?: CapabilityAliasScope;
  limit?: number;
  deadlineMs?: number;
  liveSchemaFingerprint?: string | null;
}): Promise<TurnCapabilityCandidates> {
  const empty: TurnCapabilityCandidates = {
    candidates: [], matches: [], pinnedTools: [], semanticApplied: false,
  };
  const input = options.userInput?.trim();
  if (!input) return empty;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));

  let matches: StepToolChoiceMatch[] = [];
  try {
    matches = matchToolChoicesForStep(input, { limit, scope: options.scope });
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
        scope: options.scope,
        embeddingSpace: localEmbeddingSpaceKey(),
        limit,
        ...(options.liveSchemaFingerprint !== undefined
          ? { liveSchemaFingerprint: options.liveSchemaFingerprint }
          : {}),
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
