import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { openMemoryDb, ConsolidatedFactRow } from './db.js';
import { cosine } from './embeddings.js';
import { appendHygieneAudit, readHygieneAudit, HygieneAuditEntry } from './hygiene-audit.js';

const logger = pino({ name: 'clementine-next.memory.merge' });

// Configuration
const DEFAULT_MERGE_THRESHOLD = 0.88;

interface Fact extends ConsolidatedFactRow {
  embedding?: Float32Array;
}

export interface EntityAnchors {
  tableIds: Set<string>;
  accountIds: Set<string>;
  domains: Set<string>;
  clientNames: Set<string>;
  emails: Set<string>;
}

interface MergeCluster {
  canonical: Fact;
  merged: Fact[];
  similarities: number[];
  reason: string;
}

interface MergeStats {
  clustersFound: number;
  factsMerged: number;
  accessCountFolded: number;
  impressionCountFolded: number;
  utilityCountFolded: number;
  importanceFolded: number;
  blockedByPinned: number;
  blockedByEntity: number;
  errors: number;
}

/**
 * Extract entity anchors from a fact's content.
 * These are used to prevent merging facts about logically distinct entities.
 * Exported so the nightly stored-embedding dedup (reflection.ts
 * consolidateActiveFacts) gates its drops with the SAME guard the paraphrase
 * merge uses — one entity-safety primitive, never a second copy.
 */
export function extractAnchors(fact: { content: string }): EntityAnchors {
  const content = fact.content;

  // Airtable table IDs: tbl[a-zA-Z0-9]{12,}
  const tableIds = new Set((content.match(/tbl[a-zA-Z0-9]{12,}/g) || []).map(s => s.toLowerCase()));

  // Airtable/n8n app/workspace IDs: app[a-zA-Z0-9]{12,}
  const accountIds = new Set((content.match(/app[a-zA-Z0-9]{12,}/g) || []).map(s => s.toLowerCase()));

  // Domain names (critical for multi-client setups)
  const domainMatches = content.match(/\b[\w-]+\.(com|ai|io|org|net|co\.uk|dev)\b/gi) || [];
  const domains = new Set(domainMatches.map(s => s.toLowerCase()));

  // Client names (e.g., "Revill Law Firm", "Aldous Law")
  // This is a conservative set; typically captured from project facts
  const clientPatterns = [
    /Revill\s+(?:Law\s+)?Firm/gi,
    /Aldous\s+(?:Law|Law\s+Firm)?/gi,
    /Scorpion/gi,
    /Market\s+Leader/gi,
  ];
  const clientNames = new Set<string>();
  for (const pattern of clientPatterns) {
    const matches = content.match(pattern) || [];
    matches.forEach(m => clientNames.add(m.toLowerCase()));
  }

  // Email addresses (user identity)
  const emailMatches = content.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\b/g) || [];
  const emails = new Set(emailMatches.map(s => s.toLowerCase()));

  return { tableIds, accountIds, domains, clientNames, emails };
}

/**
 * Check if two facts' entity anchors are compatible for merging.
 * Returns true if they can safely be merged (anchors match or are absent).
 * Returns false if they reference different entities (would corrupt data).
 * Exported for reuse by the stored-embedding dedup (see extractAnchors).
 */
export function canMergeEntitySafe(anchors1: EntityAnchors, anchors2: EntityAnchors): boolean {
  // Helper: set intersection
  const intersect = <T>(a: Set<T>, b: Set<T>): Set<T> => {
    const result = new Set<T>();
    for (const item of a) {
      if (b.has(item)) result.add(item);
    }
    return result;
  };

  // If both facts reference table IDs, they must be the same table
  if (anchors1.tableIds.size > 0 && anchors2.tableIds.size > 0) {
    if (intersect(anchors1.tableIds, anchors2.tableIds).size === 0) {
      return false; // Different tables — do not merge
    }
  }

  // If both reference account/app IDs, they must be the same account
  if (anchors1.accountIds.size > 0 && anchors2.accountIds.size > 0) {
    if (intersect(anchors1.accountIds, anchors2.accountIds).size === 0) {
      return false; // Different accounts — do not merge
    }
  }

  // If both reference domains, they must be the same domain (critical for multi-client)
  if (anchors1.domains.size > 0 && anchors2.domains.size > 0) {
    if (intersect(anchors1.domains, anchors2.domains).size === 0) {
      return false; // Different clients — do not merge
    }
  }

  // If both mention clients, they must be the same client
  if (anchors1.clientNames.size > 0 && anchors2.clientNames.size > 0) {
    if (intersect(anchors1.clientNames, anchors2.clientNames).size === 0) {
      return false; // Different clients — do not merge
    }
  }

  // Emails are stricter: only merge if they're the SAME email or one has none
  if (anchors1.emails.size > 0 && anchors2.emails.size > 0) {
    if (intersect(anchors1.emails, anchors2.emails).size === 0) {
      return false; // Different people — do not merge
    }
  }

  return true; // Safe to merge
}

/**
 * Convert a buffer to Float32Array for cosine calculation.
 */
function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** Canonical selection must only reward material use. `access_count` is kept
 * as legacy telemetry and may include passive prompt exposure, while
 * `impression_count` explicitly measures exposure. Neither is evidence that a
 * fact helped. This mirrors the reviewed duplicate path in self-heal.ts. */
export function mergeCanonicalQuality(fact: Pick<ConsolidatedFactRow,
  'score' | 'importance' | 'trust_level' | 'utility_count'>): number {
  return (fact.score ?? 0)
    + (fact.importance ?? 5) / 10
    + Math.log1p(Math.max(0, fact.utility_count ?? 0)) / 10
    + (fact.trust_level ?? 0.6);
}

/**
 * Find all paraphrase clusters within a kind, respecting entity boundaries.
 */
function findClustersInKind(
  facts: Fact[],
  threshold: number,
  anchorsMap: Map<number, EntityAnchors>,
): MergeCluster[] {
  const clusters: MergeCluster[] = [];
  const processed = new Set<number>();

  for (let i = 0; i < facts.length; i++) {
    const seedFact = facts[i];
    if (processed.has(seedFact.id)) continue;
    if (!seedFact.embedding) continue;

    const seedAnchors = anchorsMap.get(seedFact.id)!;
    const cluster: Fact[] = [seedFact];
    const similarities: number[] = [];

    for (let j = i + 1; j < facts.length; j++) {
      const candidate = facts[j];
      if (processed.has(candidate.id)) continue;
      if (!candidate.embedding) continue;

      const candidateAnchors = anchorsMap.get(candidate.id)!;

      // Entity gate: the candidate must be entity-compatible with EVERY current
      // cluster member, not just the seed. Seed-only gating let a no-anchor fact
      // bridge two entity-distinct facts into one cluster — and if that bridge
      // then won canonical selection, Guard-2's member-vs-canonical check
      // (anchors-vs-empty = always true) could not catch it, soft-deleting two
      // distinct-client facts. Pairwise coherence closes the bridge.
      if (!cluster.every((m) => canMergeEntitySafe(anchorsMap.get(m.id)!, candidateAnchors))) {
        continue;
      }

      const sim = cosine(seedFact.embedding, candidate.embedding);
      if (sim >= threshold) {
        cluster.push(candidate);
        similarities.push(sim);
      }
    }

    if (cluster.length >= 2) {
      // Pick canonical by durable quality and material utility. Passive
      // exposure must never decide which duplicate survives.
      let canonical = seedFact;
      let bestScore = mergeCanonicalQuality(seedFact);
      for (const f of cluster.slice(1)) {
        const score = mergeCanonicalQuality(f);
        if (score > bestScore) {
          canonical = f;
          bestScore = score;
        }
      }

      const nonCanonical = cluster.filter(f => f.id !== canonical.id);
      clusters.push({
        canonical,
        merged: nonCanonical,
        similarities,
        reason: 'paraphrase',
      });

      for (const f of cluster) {
        processed.add(f.id);
      }
    }
  }

  return clusters;
}

/**
 * Consolidate metadata when merging a cluster of paraphrases.
 * Uses MAX semantics for importance and trust. Usage and exposure telemetry
 * are folded into their own columns; only utility can reinforce later recall.
 */
function consolidateCluster(canonical: Fact, others: Fact[]) {
  let maxImportance = canonical.importance ?? 5;
  let totalAccessCount = canonical.access_count ?? 0;
  let totalImpressionCount = canonical.impression_count ?? 0;
  let totalUtilityCount = canonical.utility_count ?? 0;
  let maxTrust = canonical.trust_level ?? 1.0;
  let lastAccessedAt = canonical.last_accessed_at ?? null;
  let lastUsedAt = canonical.last_used_at ?? null;
  let sourceApp = canonical.source_app;

  for (const fact of others) {
    maxImportance = Math.max(maxImportance, fact.importance ?? 5);
    totalAccessCount += fact.access_count ?? 0;
    totalImpressionCount += fact.impression_count ?? 0;
    totalUtilityCount += fact.utility_count ?? 0;
    maxTrust = Math.max(maxTrust, fact.trust_level ?? 1.0);
    if (fact.last_accessed_at && (!lastAccessedAt || fact.last_accessed_at > lastAccessedAt)) {
      lastAccessedAt = fact.last_accessed_at;
    }
    if (fact.last_used_at && (!lastUsedAt || fact.last_used_at > lastUsedAt)) {
      lastUsedAt = fact.last_used_at;
    }
    if (!sourceApp && fact.source_app) {
      sourceApp = fact.source_app;
    }
  }

  return {
    importance: Math.min(10, Math.max(1, maxImportance)),
    accessCount: totalAccessCount,
    impressionCount: totalImpressionCount,
    utilityCount: totalUtilityCount,
    trustLevel: Math.min(1, Math.max(0, maxTrust)),
    lastAccessedAt,
    lastUsedAt,
    sourceApp,
  };
}

/**
 * Main paraphrase merge job. Available as an explicit operator action to
 * consolidate reviewed semantic duplicates. It is disabled by default because
 * embedding similarity is candidate evidence, not proof of identity: production
 * merges previously collapsed distinct phone numbers, dates, and legal topics.
 * Reversible via unmergeCluster + audit log. New merge entries retain the
 * canonical fact's pre-merge metadata so a reversal can restore it exactly.
 */
export async function mergeParaphrases(): Promise<MergeStats> {
  // Read this at dispatch time so console/runtime feature-flag changes take
  // effect without restarting the daemon.
  if (getRuntimeEnv('CLEMMY_MERGE_ENABLED', 'false') !== 'true') {
    return { clustersFound: 0, factsMerged: 0, accessCountFolded: 0, impressionCountFolded: 0, utilityCountFolded: 0, importanceFolded: 0, blockedByPinned: 0, blockedByEntity: 0, errors: 0 };
  }

  const stats: MergeStats = {
    clustersFound: 0,
    factsMerged: 0,
    accessCountFolded: 0,
    impressionCountFolded: 0,
    utilityCountFolded: 0,
    importanceFolded: 0,
    blockedByPinned: 0,
    blockedByEntity: 0,
    errors: 0,
  };

  try {
    // openMemoryDb returns the process-wide cached singleton — NEVER close it
    // here. The nightly merge used to db.close() this handle on every exit
    // path, leaving every later caller (recall, fact writes, listConstraints →
    // the sender-constraint gate) a dead connection until daemon restart
    // (audit 2026-06-12: "The database connection is not open" all day after
    // the 4:45 AM merge).
    const db = openMemoryDb();

    const threshold = parseFloat(getRuntimeEnv('CLEMMY_MERGE_THRESHOLD', String(DEFAULT_MERGE_THRESHOLD)));
    if (threshold < 0 || threshold > 1) {
      logger.warn({ threshold }, 'invalid merge threshold, skipping merge job');
      return stats;
    }

    // Load all active facts with embeddings
    const rows = db.prepare(`
      SELECT
        f.id, f.kind, f.content, f.content_hash, f.source_session_id, f.source_path,
        f.score, f.active, f.created_at, f.updated_at,
        f.derived_from_session_id, f.derived_from_call_id, f.derived_from_tool,
        f.trust_level, f.extracted_at,
        f.importance, f.last_accessed_at,
        f.derivation_depth, f.derived_from_fact_ids,
        f.pinned, f.source_app, f.access_count, f.impression_count,
        f.utility_count, f.last_used_at,
        fe.vector
      FROM consolidated_facts f
      LEFT JOIN fact_embeddings fe ON f.id = fe.fact_id
      WHERE f.active = 1
      ORDER BY f.importance DESC, f.utility_count DESC, f.id ASC
    `).all() as any[];

    const factsWithEmbedding = rows
      .filter(r => r.vector)
      .map(r => ({
        ...r,
        embedding: bufferToFloat32Array(r.vector),
      })) as Fact[];

    if (factsWithEmbedding.length < 2) {
      return stats;
    }

    // Pre-compute anchors for all facts to avoid repeated extraction
    const anchorsMap = new Map<number, EntityAnchors>();
    for (const fact of factsWithEmbedding) {
      anchorsMap.set(fact.id, extractAnchors(fact));
    }

    // Group by kind to avoid cross-kind merges
    const byKind = new Map<string, Fact[]>();
    for (const fact of factsWithEmbedding) {
      if (!byKind.has(fact.kind)) byKind.set(fact.kind, []);
      byKind.get(fact.kind)!.push(fact);
    }

    const mergeAudit: HygieneAuditEntry[] = [];

    // Find clusters within each kind
    for (const [kind, kindFacts] of byKind) {
      const clusters = findClustersInKind(kindFacts, threshold, anchorsMap);

      for (const { canonical, merged, similarities } of clusters) {
        // Guard 1: don't merge if any cluster member is pinned
        if ([canonical, ...merged].some(f => f.pinned === 1)) {
          stats.blockedByPinned++;
          logger.debug(
            { canonicalId: canonical.id, mergedIds: merged.map(m => m.id) },
            'blocked merge: contains pinned fact',
          );
          continue;
        }

        // Guard 2: entity safety — check ALL PAIRS, not just member-vs-canonical.
        // A member-vs-canonical loop is blind when the canonical itself has empty
        // anchors (the bridging case): empty-vs-X is always "safe". All-pairs makes
        // the whole cluster entity-coherent before any soft-delete.
        const members = [canonical, ...merged];
        const allAnchorsSafe = members.every((f1, i) =>
          members.slice(i + 1).every((f2) =>
            canMergeEntitySafe(anchorsMap.get(f1.id)!, anchorsMap.get(f2.id)!)));
        if (!allAnchorsSafe) {
          stats.blockedByEntity++;
          logger.warn(
            { canonicalId: canonical.id, mergedIds: merged.map(m => m.id) },
            'blocked merge: entity mismatch detected in merge guard',
          );
          continue;
        }

        // Consolidate metadata. Preserve the exact canonical values in the
        // audit record before folding anything so future reversals do not have
        // to guess which member contributed a field.
        const canonicalBefore = {
          importance: canonical.importance ?? 5,
          accessCount: canonical.access_count ?? 0,
          impressionCount: canonical.impression_count ?? 0,
          utilityCount: canonical.utility_count ?? 0,
          trustLevel: canonical.trust_level ?? 1.0,
          lastAccessedAt: canonical.last_accessed_at ?? null,
          lastUsedAt: canonical.last_used_at ?? null,
          sourceApp: canonical.source_app ?? null,
        };
        const folded = consolidateCluster(canonical, merged);

        // Update canonical fact
        db.prepare(`
          UPDATE consolidated_facts
          SET importance = ?, access_count = ?, impression_count = ?, utility_count = ?,
              trust_level = ?, last_accessed_at = ?, last_used_at = ?, source_app = ?
          WHERE id = ?
        `).run(
          folded.importance,
          folded.accessCount,
          folded.impressionCount,
          folded.utilityCount,
          folded.trustLevel,
          folded.lastAccessedAt,
          folded.lastUsedAt,
          folded.sourceApp,
          canonical.id,
        );

        // Soft-delete merged facts
        const now = new Date().toISOString();
        for (const fact of merged) {
          db.prepare('UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = ?').run(now, fact.id);
        }

        // Log audit entry
        mergeAudit.push({
          at: now,
          kind: 'merge',
          ids: merged.map(f => f.id),
          detail: {
            canonical: canonical.id,
            canonicalBefore,
            cluster: merged.map((f, idx) => ({
              id: f.id,
              sim: similarities[idx],
              reason: 'paraphrase',
            })),
            accessCountFolded: folded.accessCount,
            impressionCountFolded: folded.impressionCount,
            utilityCountFolded: folded.utilityCount,
            importanceFolded: folded.importance,
            trustFolded: folded.trustLevel,
          },
        });

        stats.clustersFound++;
        stats.factsMerged += merged.length;
        stats.accessCountFolded += folded.accessCount;
        stats.impressionCountFolded += folded.impressionCount;
        stats.utilityCountFolded += folded.utilityCount;
        stats.importanceFolded += folded.importance;
      }
    }

    // Persist audit entries
    for (const entry of mergeAudit) {
      appendHygieneAudit(entry);
    }

    logger.info(stats, 'paraphrase merge job completed');
  } catch (err) {
    stats.errors++;
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'paraphrase merge job failed');
  }

  return stats;
}

function mergeAuditKey(canonicalId: number, at: string): string {
  return `${canonicalId}:${at}`;
}

/** Select the newest merge for a canonical fact that has not already been
 * reversed. Exported as a pure helper so reversal ordering is regression
 * tested without opening a real memory database. */
export function selectMergeAuditToRevert(
  entries: HygieneAuditEntry[],
  canonicalId: number,
  mergeAt?: string,
): HygieneAuditEntry | null {
  const reverted = new Set(
    entries
      .filter((entry) => entry.kind === 'merge-revert')
      .map((entry) => {
        const canonical = Number(entry.detail?.canonical);
        const originalMergeAt = typeof entry.detail?.originalMergeAt === 'string'
          ? entry.detail.originalMergeAt
          : '';
        return mergeAuditKey(canonical, originalMergeAt);
      }),
  );

  return entries.find((entry) => {
    if (entry.kind !== 'merge' || Number(entry.detail?.canonical) !== canonicalId) return false;
    if (mergeAt && entry.at !== mergeAt) return false;
    return !reverted.has(mergeAuditKey(canonicalId, entry.at));
  }) ?? null;
}

/**
 * Unmerge a cluster of facts. Reactivates all facts in a merge audit entry.
 * Called when a merge was incorrect and needs to be reverted.
 */
export function unmergeCluster(
  canonicalId: number,
  options: { mergeAt?: string; reason?: string } = {},
): boolean {
  try {
    const db = openMemoryDb();
    const mergeEntry = selectMergeAuditToRevert(
      readHygieneAudit(2_000),
      canonicalId,
      options.mergeAt,
    );

    if (!mergeEntry) {
      logger.warn({ canonicalId, mergeAt: options.mergeAt }, 'no unreversed merge entry found for canonical fact');
      return false;
    }

    const cluster = Array.isArray(mergeEntry.detail?.cluster) ? mergeEntry.detail.cluster : [];
    const mergedIds = cluster
      .map((item) => Number((item as { id?: unknown })?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (mergedIds.length === 0) {
      logger.warn({ canonicalId, mergeAt: mergeEntry.at }, 'merge audit entry has no valid member ids');
      return false;
    }

    const now = new Date().toISOString();
    const canonicalBefore = mergeEntry.detail?.canonicalBefore as {
      importance?: unknown;
      accessCount?: unknown;
      impressionCount?: unknown;
      utilityCount?: unknown;
      trustLevel?: unknown;
      lastAccessedAt?: unknown;
      lastUsedAt?: unknown;
      sourceApp?: unknown;
    } | undefined;
    const canRestoreCanonical = canonicalBefore !== undefined
      && Number.isFinite(Number(canonicalBefore.importance))
      && Number.isFinite(Number(canonicalBefore.accessCount))
      && Number.isFinite(Number(canonicalBefore.trustLevel));

    const reactivatedIds = db.transaction(() => {
      const restored: number[] = [];
      const reactivate = db.prepare(
        'UPDATE consolidated_facts SET active = 1, updated_at = ? WHERE id = ? AND active = 0',
      );
      for (const id of mergedIds) {
        if (reactivate.run(now, id).changes > 0) restored.push(id);
      }

      if (canRestoreCanonical) {
        db.prepare(`
          UPDATE consolidated_facts
          SET importance = ?, access_count = ?, impression_count = ?, utility_count = ?,
              trust_level = ?, last_accessed_at = ?, last_used_at = ?, source_app = ?
          WHERE id = ?
        `).run(
          Number(canonicalBefore!.importance),
          Number(canonicalBefore!.accessCount),
          Number.isFinite(Number(canonicalBefore!.impressionCount)) ? Number(canonicalBefore!.impressionCount) : 0,
          Number.isFinite(Number(canonicalBefore!.utilityCount)) ? Number(canonicalBefore!.utilityCount) : 0,
          Number(canonicalBefore!.trustLevel),
          typeof canonicalBefore!.lastAccessedAt === 'string' ? canonicalBefore!.lastAccessedAt : null,
          typeof canonicalBefore!.lastUsedAt === 'string' ? canonicalBefore!.lastUsedAt : null,
          typeof canonicalBefore!.sourceApp === 'string' ? canonicalBefore!.sourceApp : null,
          canonicalId,
        );
      }
      return restored;
    })();

    if (reactivatedIds.length === 0) {
      logger.warn({ canonicalId, mergeAt: mergeEntry.at, mergedIds }, 'merge members were already active or missing');
      return false;
    }

    appendHygieneAudit({
      at: now,
      kind: 'merge-revert',
      ids: reactivatedIds,
      detail: {
        canonical: canonicalId,
        originalMergeAt: mergeEntry.at,
        canonicalMetadataRestored: canRestoreCanonical,
        reason: options.reason?.trim() || 'manual reversal',
      },
    });

    logger.info({ canonicalId, reactivatedIds, mergeAt: mergeEntry.at, canonicalMetadataRestored: canRestoreCanonical }, 'unmerge cluster completed');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), canonicalId }, 'unmerge failed');
    return false;
  }
}
