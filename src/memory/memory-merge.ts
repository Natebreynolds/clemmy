import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import { openMemoryDb, ConsolidatedFactRow } from './db.js';
import { cosine } from './embeddings.js';
import { appendHygieneAudit, HygieneAuditEntry } from './hygiene-audit.js';

const logger = pino({ name: 'clementine-next.memory.merge' });

// Configuration
const DEFAULT_MERGE_THRESHOLD = 0.88;
const MERGE_ENABLED = getRuntimeEnv('CLEMMY_MERGE_ENABLED', 'true') === 'true';

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

/**
 * Compute Stanford-style importance score: importance × log(1 + accessCount).
 * Higher score = more important + more frequently accessed.
 */
function getStanfordScore(fact: Fact): number {
  const imp = fact.importance ?? 5;
  const acc = fact.access_count ?? 0;
  return imp * Math.log(1 + acc);
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
      // Pick canonical by Stanford score
      let canonical = seedFact;
      let bestScore = getStanfordScore(seedFact);
      for (const f of cluster.slice(1)) {
        const score = getStanfordScore(f);
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
 * Uses MAX semantics for importance and trust (facts reinforce each other),
 * and SUM for access_count (cumulative reinforcement).
 */
function consolidateCluster(canonical: Fact, others: Fact[]) {
  let maxImportance = canonical.importance ?? 5;
  let totalAccessCount = canonical.access_count ?? 0;
  let maxTrust = canonical.trust_level ?? 1.0;
  let sourceApp = canonical.source_app;

  for (const fact of others) {
    maxImportance = Math.max(maxImportance, fact.importance ?? 5);
    totalAccessCount += fact.access_count ?? 0;
    maxTrust = Math.max(maxTrust, fact.trust_level ?? 1.0);
    if (!sourceApp && fact.source_app) {
      sourceApp = fact.source_app;
    }
  }

  return {
    importance: Math.min(10, Math.max(1, maxImportance)),
    accessCount: totalAccessCount,
    trustLevel: Math.min(1, Math.max(0, maxTrust)),
    sourceApp,
  };
}

/**
 * Main paraphrase merge job. Runs nightly to consolidate semantic duplicates.
 * Fully reversible via unmergeCluster + audit log.
 */
export async function mergeParaphrases(): Promise<MergeStats> {
  if (!MERGE_ENABLED) {
    return { clustersFound: 0, factsMerged: 0, accessCountFolded: 0, importanceFolded: 0, blockedByPinned: 0, blockedByEntity: 0, errors: 0 };
  }

  const stats: MergeStats = {
    clustersFound: 0,
    factsMerged: 0,
    accessCountFolded: 0,
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
        f.pinned, f.source_app, f.access_count,
        fe.vector
      FROM consolidated_facts f
      LEFT JOIN fact_embeddings fe ON f.id = fe.fact_id
      WHERE f.active = 1
      ORDER BY f.importance DESC, f.access_count DESC
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

        // Consolidate metadata
        const folded = consolidateCluster(canonical, merged);

        // Update canonical fact
        db.prepare(`
          UPDATE consolidated_facts
          SET importance = ?, access_count = ?, trust_level = ?, last_accessed_at = ?, source_app = ?
          WHERE id = ?
        `).run(folded.importance, folded.accessCount, folded.trustLevel, new Date().toISOString(), folded.sourceApp, canonical.id);

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
            cluster: merged.map((f, idx) => ({
              id: f.id,
              sim: similarities[idx],
              reason: 'paraphrase',
            })),
            accessCountFolded: folded.accessCount,
            importanceFolded: folded.importance,
            trustFolded: folded.trustLevel,
          },
        });

        stats.clustersFound++;
        stats.factsMerged += merged.length;
        stats.accessCountFolded += folded.accessCount;
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

/**
 * Unmerge a cluster of facts. Reactivates all facts in a merge audit entry.
 * Called when a merge was incorrect and needs to be reverted.
 */
export function unmergeCluster(canonicalId: number): boolean {
  try {
    const db = openMemoryDb();

    // Read the audit log to find the merge entry
    const auditPath = require('path').join(
      require('../config.js').BASE_DIR,
      'state',
      'hygiene-audit.jsonl',
    );
    const fs = require('fs');
    if (!fs.existsSync(auditPath)) {
      logger.warn({ auditPath }, 'audit log not found, cannot unmerge');
      return false;
    }

    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    const mergeEntry = lines
      .map((line: string) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find(
        (entry: any) =>
          entry && entry.kind === 'merge' && entry.detail?.canonical === canonicalId,
      );

    if (!mergeEntry) {
      logger.warn({ canonicalId }, 'no merge entry found for canonical fact');
      return false;
    }

    // Reactivate the merged facts
    const mergedIds = (mergeEntry.detail?.cluster || []).map((c: any) => c.id);
    const now = new Date().toISOString();

    for (const id of mergedIds) {
      db.prepare('UPDATE consolidated_facts SET active = 1, updated_at = ? WHERE id = ?').run(now, id);
    }

    // Log the unmerge in the audit trail
    appendHygieneAudit({
      at: now,
      kind: 'approve-dedup', // Reuse the approval entry kind
      ids: mergedIds,
      detail: { canonical: canonicalId, action: 'unmerge', reason: 'manual reversal' },
    });

    logger.info({ canonicalId, mergedIds }, 'unmerge cluster completed');
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), canonicalId }, 'unmerge failed');
    return false;
  }
}
