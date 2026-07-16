import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSearchHits, searchVaultAsync } from '../memory/search.js';
import { recallHybrid } from '../memory/recall.js';
import { embedMissingChunks, embedMissingFacts, readEmbeddingStats, readFactEmbeddingStats } from '../memory/embeddings.js';
import { FACT_KINDS, forgetFact, getFact, listActiveFacts, listAllFacts, reactivateFact, reviewStandingInstructions, searchFacts, setFactPinned, recordFactImpression } from '../memory/facts.js';
import { consolidateFact } from '../memory/reflection.js';
import { upsertResourcePointer, isSourceMapEnabled } from '../memory/source-map.js';
import { recallEverything, formatUnifiedRecall, unifiedHitRecallRef, visibleUnifiedRecallHits } from '../memory/unified-recall.js';
import { createRecallRunId, recordRecallRun, recordRecallUse } from '../memory/recall-usage.js';
import { appendFactRecallTrace } from '../memory/recall-trace.js';
import { scheduleRecallShadow } from '../memory/recall-shadow.js';
import { applyMemoryFix, detectMemoryHealCandidates, listProposedMemoryFixes, revertMemoryHeal, runMemorySelfHeal, type ProposedMemoryFix } from '../memory/self-heal.js';
import { looksLikeHighConfidenceTransientRequest } from '../memory/memory-quality.js';
import { WORKING_MEMORY_FILE } from '../memory/vault.js';
import { addNotification } from '../runtime/notifications.js';
import { readText, replaceFile, resolveMemoryTarget, textResult } from './shared.js';
import type { ConsolidatedFact } from '../memory/facts.js';
import { openMemoryDb, type EntityType } from '../memory/db.js';
import { upsertEntity, type EntityIdentifierInput } from '../memory/entity-identity.js';
import { addFactEntityLinks, recordGroundedEntityRelationship, type EntityRelationshipOutcome } from '../memory/relations.js';
import { getFactEvidence } from '../memory/temporal-memory.js';
import { compileWordMatcher } from '../memory/word-match.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';

/** Register a recall run with the active turn so the post-turn auto-credit
 *  hook can match its candidates against what the turn produced. */
function noteTurnRecallRun(runId: string): void {
  const ctx = harnessRunContextStorage.getStore();
  if (!ctx) return;
  (ctx.turnRecallRunIds ??= []).push(runId);
}

/**
 * Standing-instruction protection for the DIRECT memory tools.
 *
 * The autonomous paths (conflict resolver, nightly reflection) already refuse
 * to touch pinned facts — but memory_forget/memory_pin are model-callable
 * with no guard, so one misguided tool call could silently remove a standing
 * rule (the same class as the 2026-06-09 wrong-mailbox incident: protection
 * existed, the removal path didn't surface). Policy, enforced here:
 *   - forgetting a PINNED fact is refused — unpin first (a deliberate,
 *     separately-surfaced step), then forget;
 *   - hard-deleting a constraint-kind fact is refused outright (soft-delete
 *     keeps it recoverable via reactivateFact);
 *   - every pin/unpin/forget that touches a constraint or pinned fact emits
 *     a user-visible notification, so a standing-rule change can never
 *     happen silently.
 * Pure decision function, exported for tests.
 */
export function reviewForgetRequest(
  fact: Pick<ConsolidatedFact, 'id' | 'kind' | 'pinned' | 'content'>,
  hard: boolean,
): { allow: boolean; reason?: string } {
  if (fact.pinned) {
    return {
      allow: false,
      reason: `Fact #${fact.id} is a PINNED standing instruction — refusing to forget it directly. `
        + `If the user wants this rule gone: (1) call memory_pin with pinned=false (this is surfaced to the user), then (2) call memory_forget. `
        + 'Do NOT do this unless the user explicitly asked to drop the rule.',
    };
  }
  if (hard && fact.kind === 'constraint') {
    return {
      allow: false,
      reason: `Fact #${fact.id} is a constraint — hard delete is refused so the rule stays recoverable. `
        + 'Call memory_forget without hard to soft-delete it instead.',
    };
  }
  return { allow: true };
}

/** One visible card per standing-rule change — never silent. Best-effort. */
function notifyStandingRuleChange(
  action: 'unpinned' | 'pinned' | 'forgotten',
  fact: Pick<ConsolidatedFact, 'id' | 'kind' | 'content'>,
): void {
  try {
    addNotification({
      id: `${Date.now()}-standing-rule-${action}-${fact.id}`,
      kind: 'system',
      title: `Standing rule ${action}: fact #${fact.id}`,
      body: `Clem ${action} ${fact.kind === 'constraint' ? 'a CONSTRAINT' : 'a pinned fact'} via a memory tool call:\n\n"${fact.content.slice(0, 280)}"\n\nIf you didn't ask for this, say "re-pin fact #${fact.id}" (or "restore fact #${fact.id}" if it was forgotten).`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { factId: fact.id, kind: fact.kind, action, source: 'memory-tools-guard' },
    });
  } catch { /* notification must never block the tool */ }
}

// Tier A1 — when CLEMMY_REMEMBER_RECONCILE=on, the agent's explicit
// memory_remember writes route through the Mem0 conflict resolver
// (consolidateFact) instead of blind-appending, so a restated/contradicted
// preference UPDATEs or supersedes the old fact instead of stacking a
// duplicate. Below this cosine bar a candidate is treated as clearly novel
// and ADDed without an LLM resolver call (cost fast-path).
const REMEMBER_NOVELTY_FAST_PATH_SIM = 0.6;
const MEMORY_ENTITY_TYPES = ['person', 'company', 'project', 'place', 'thing'] as const;

export interface RememberedEntityAnnotation {
  type: EntityType;
  name: string;
  aliases?: string[];
  identifiers?: EntityIdentifierInput[];
  confidence?: number;
}

export interface RememberedEntityAttachmentResult {
  linkedEntityIds: number[];
  identifiersStored: number;
  skipped: Array<{ name: string; reason: string }>;
  resolved: Array<{ name: string; aliases: string[]; entityId: number }>;
}

export interface RememberedRelationshipAnnotation {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
}

export interface RememberedRelationshipAttachmentResult {
  outcomes: Record<EntityRelationshipOutcome, number>;
  skipped: Array<{ relationship: string; reason: string }>;
}

function textMentionsName(text: string, value: string): boolean {
  return compileWordMatcher(value.trim().toLowerCase(), 2)?.test(text.toLowerCase()) ?? false;
}

function textContainsIdentifier(text: string, identifier: EntityIdentifierInput): boolean {
  const value = identifier.value.trim();
  if (!value) return false;
  const scheme = identifier.scheme.trim().toLowerCase();
  if (scheme === 'phone') {
    const wanted = value.replace(/\D/g, '');
    return wanted.length >= 7 && text.replace(/\D/g, '').includes(wanted);
  }
  if (scheme === 'domain') {
    const wanted = value
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#]/, 1)[0]
      .toLowerCase();
    return wanted.length >= 4 && text.toLowerCase().includes(wanted);
  }
  return text.toLowerCase().includes(value.toLowerCase());
}

/**
 * Attach structured entity annotations to an already-durable direct fact.
 * Every accepted identity must be named in both the canonical fact and one
 * surviving evidence excerpt. Identifiers and aliases are retained only when
 * they literally occur in that same excerpt, preventing a model annotation
 * from becoming unsupported identity evidence.
 */
export function attachRememberedEntities(
  factId: number,
  annotations: RememberedEntityAnnotation[],
): RememberedEntityAttachmentResult {
  const fact = getFact(factId);
  const result: RememberedEntityAttachmentResult = { linkedEntityIds: [], identifiersStored: 0, skipped: [], resolved: [] };
  if (!fact?.active) {
    for (const annotation of annotations) result.skipped.push({ name: annotation.name, reason: 'fact_unavailable' });
    return result;
  }
  const evidence = getFactEvidence(factId).filter(
    (item) => item.excerpt.trim().length > 0 && (item.status === 'available' || item.status === 'partial'),
  );
  if (evidence.length === 0) {
    for (const annotation of annotations) result.skipped.push({ name: annotation.name, reason: 'durable_evidence_unavailable' });
    return result;
  }

  const linked = new Set<number>();
  for (const annotation of annotations.slice(0, 12)) {
    const name = annotation.name.replace(/\s+/g, ' ').trim();
    const aliases = Array.from(new Set((annotation.aliases ?? [])
      .map((alias) => alias.replace(/\s+/g, ' ').trim())
      .filter(Boolean)))
      .slice(0, 12);
    const mentionedNames = [name, ...aliases].filter((candidate) => textMentionsName(fact.content, candidate));
    if (!name || mentionedNames.length === 0) {
      result.skipped.push({ name: name || '(blank)', reason: 'not_named_in_fact' });
      continue;
    }
    const supporting = evidence.find((item) => mentionedNames.some((candidate) => textMentionsName(item.excerpt, candidate)));
    if (!supporting) {
      result.skipped.push({ name, reason: 'not_named_in_evidence' });
      continue;
    }
    const groundedAliases = aliases.filter((alias) => textMentionsName(supporting.excerpt, alias));
    const groundedIdentifiers = (annotation.identifiers ?? [])
      .filter((identifier) => textContainsIdentifier(supporting.excerpt, identifier))
      .slice(0, 12);
    const confidence = Math.max(0, Math.min(1, annotation.confidence ?? 0.95));

    try {
      const entityId = openMemoryDb().transaction(() => {
        const id = upsertEntity({
          type: annotation.type,
          name,
          aliases: groundedAliases,
          identifiers: groundedIdentifiers,
          confidence,
          evidenceEpisodeId: supporting.episodeId,
          sourceUri: supporting.sourceUri,
          sourceFactId: factId,
          sourceKind: 'fact_link',
        });
        addFactEntityLinks(factId, [id], {
          linkType: 'extracted',
          confidence,
          evidenceEpisodeId: supporting.episodeId,
          evidenceExcerpt: supporting.excerpt,
        });
        return id;
      })();
      linked.add(entityId);
      result.resolved.push({ name, aliases: groundedAliases, entityId });
      result.identifiersStored += groundedIdentifiers.length;
    } catch (error) {
      result.skipped.push({
        name,
        reason: `write_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 180),
      });
    }
  }
  result.linkedEntityIds = Array.from(linked);
  return result;
}

function normalizedEntityReference(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Persist direct entity relationships only when both endpoints were grounded
 * by this fact and the same durable excerpt explicitly supports the edge. */
export function attachRememberedRelationships(
  factId: number,
  annotations: RememberedRelationshipAnnotation[],
  entities: RememberedEntityAttachmentResult,
): RememberedRelationshipAttachmentResult {
  const result: RememberedRelationshipAttachmentResult = {
    outcomes: { add: 0, reinforce: 0, supersede: 0, ignore: 0 },
    skipped: [],
  };
  const evidence = getFactEvidence(factId).filter(
    (item) => item.excerpt.trim().length > 0 && (item.status === 'available' || item.status === 'partial'),
  );
  const refs = new Map<string, Set<number>>();
  for (const entity of entities.resolved) {
    for (const value of [entity.name, ...entity.aliases]) {
      const key = normalizedEntityReference(value);
      if (!key) continue;
      const ids = refs.get(key) ?? new Set<number>();
      ids.add(entity.entityId);
      refs.set(key, ids);
    }
  }
  const resolve = (value: string): number | undefined => {
    const ids = refs.get(normalizedEntityReference(value));
    return ids?.size === 1 ? ids.values().next().value : undefined;
  };

  for (const annotation of annotations.slice(0, 12)) {
    const label = `${annotation.subject} -${annotation.predicate}-> ${annotation.object}`;
    const subjectId = resolve(annotation.subject);
    const objectId = resolve(annotation.object);
    if (!subjectId || !objectId) {
      result.skipped.push({ relationship: label, reason: 'endpoint_not_uniquely_grounded_in_entities' });
      continue;
    }
    let recorded = false;
    let lastReason = 'durable_evidence_unavailable';
    for (const item of evidence) {
      const outcome = recordGroundedEntityRelationship({
        subjectId,
        predicate: annotation.predicate,
        objectId,
        evidenceEpisodeId: item.episodeId,
        evidenceExcerpt: item.excerpt,
        sourceText: item.excerpt,
        sourceUri: item.sourceUri,
        sourceFactId: factId,
        confidence: Math.max(0, Math.min(1, annotation.confidence ?? 0.95)),
        validFrom: annotation.validFrom,
        validTo: annotation.validTo,
        extractionMethod: 'manual',
      });
      lastReason = outcome.reason;
      if (outcome.outcome !== 'ignore' || outcome.reason === 'duplicate_evidence') {
        result.outcomes[outcome.outcome] += 1;
        recorded = true;
        break;
      }
    }
    if (!recorded) result.skipped.push({ relationship: label, reason: lastReason });
  }
  return result;
}

function enrichRememberedFact(
  factId: number,
  entities: RememberedEntityAnnotation[] | undefined,
  relationships: RememberedRelationshipAnnotation[] | undefined,
): string {
  if (!entities?.length && !relationships?.length) return '';
  const attached = entities?.length
    ? attachRememberedEntities(factId, entities)
    : { linkedEntityIds: [], identifiersStored: 0, skipped: [], resolved: [] } satisfies RememberedEntityAttachmentResult;
  const relationResult = relationships?.length
    ? attachRememberedRelationships(factId, relationships, attached)
    : null;
  const parts = [
    `linked ${attached.linkedEntityIds.length} canonical entit${attached.linkedEntityIds.length === 1 ? 'y' : 'ies'}`,
  ];
  if (relationResult) {
    const stored = relationResult.outcomes.add + relationResult.outcomes.reinforce
      + relationResult.outcomes.supersede + relationResult.outcomes.ignore;
    parts.push(`grounded ${stored} relationship${stored === 1 ? '' : 's'}`);
  }
  const rejected = attached.skipped.length + (relationResult?.skipped.length ?? 0);
  if (rejected > 0) parts.push(`rejected ${rejected} unsupported annotation(s)`);
  return ` · ${parts.join(' · ')}`;
}

function formatMemoryFix(fix: ProposedMemoryFix): string {
  const status = fix.status ?? 'pending';
  const ids = fix.targetIds.length > 0 ? ` ids=${fix.targetIds.join(',')}` : '';
  const audit = fix.auditId ? ` audit=${fix.auditId}` : '';
  const skipped = fix.skipReason ? ` skipped="${fix.skipReason.slice(0, 120)}"` : '';
  return `- ${fix.id} [${status}] ${fix.kind}${ids}${audit}${skipped}: ${fix.evidence.slice(0, 240)}`;
}

function formatMemorySelfHealOutcome(outcome: Awaited<ReturnType<typeof runMemorySelfHeal>>): string {
  if (!outcome.ran) return `Memory self-heal did not run: ${outcome.reason ?? 'unknown reason'}.`;
  const lines = [
    `Memory self-heal ${outcome.dryRun ? 'dry run' : 'run'}: proposed ${outcome.proposed}, applied ${outcome.applied}, skipped ${outcome.skipped.length}.`,
  ];
  for (const result of outcome.results.slice(0, 20)) {
    lines.push(`- ${result.ok ? 'ok' : 'skip'} ${result.kind} ${result.fixId}: ${result.message}${result.auditId ? ` audit=${result.auditId}` : ''}`);
  }
  if (outcome.results.length > 20) lines.push(`- ... ${outcome.results.length - 20} more result(s) omitted.`);
  if (outcome.skipped.length > 0) {
    lines.push('Skipped:');
    for (const skipped of outcome.skipped.slice(0, 10)) {
      lines.push(`- ${skipped.id} ${skipped.kind}: ${skipped.reason}`);
    }
  }
  return lines.join('\n');
}

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    'memory_search',
    'Search the local Clementine vault for relevant notes and memories. Uses FTS5 and, when an embedding provider is available, an embedding rerank.',
    { query: z.string().min(1) },
    async ({ query }) => {
      const hits = await searchVaultAsync(query, 8);
      const text = hits.length > 0 ? formatSearchHits(hits, 3000) : 'No relevant memory hits found.';
      return textResult(text);
    },
  );

  server.tool(
    'memory_read',
    'Read a key memory file or a vault-relative markdown path.',
    { target: z.string().min(1) },
    async ({ target }) => {
      const resolved = resolveMemoryTarget(target);
      return textResult(readText(resolved, `Not found: ${target}`));
    },
  );

  server.tool(
    'working_memory',
    'Read, append, replace, or clear the working-memory scratchpad.',
    {
      action: z.enum(['read', 'append', 'replace', 'clear']),
      content: z.string().optional(),
    },
    async ({ action, content }) => {
      if (action === 'read') {
        const text = existsSync(WORKING_MEMORY_FILE)
          ? readFileSync(WORKING_MEMORY_FILE, 'utf-8')
          : 'Working memory is empty.';
        return textResult(text);
      }

      if (action === 'clear') {
        if (existsSync(WORKING_MEMORY_FILE)) {
          unlinkSync(WORKING_MEMORY_FILE);
        }
        return textResult('Working memory cleared.');
      }

      if (!content) {
        return textResult(`Missing content for ${action} action.`);
      }

      if (action === 'append') {
        const existing = existsSync(WORKING_MEMORY_FILE) ? readFileSync(WORKING_MEMORY_FILE, 'utf-8').trimEnd() : '';
        const next = existing ? `${existing}\n${content.trim()}` : content.trim();
        replaceFile(WORKING_MEMORY_FILE, next);
        return textResult('Working memory updated.');
      }

      writeFileSync(WORKING_MEMORY_FILE, `${content.trim()}\n`, 'utf-8');
      return textResult('Working memory replaced.');
    },
  );

  // ---------------------------------------------------------------------
  // SQLite-backed memory: FTS recall + durable facts.
  // ---------------------------------------------------------------------

  server.tool(
    'memory_recall',
    'Recall vault chunks. FTS5 narrows the pool; when an embedding provider is available, an embedding rerank reorders via reciprocal rank fusion. Supports limit and pathPrefix filters.',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      pathPrefix: z.string().optional(),
    },
    async ({ query, limit, pathPrefix }) => {
      const hits = await recallHybrid(query, { limit: limit ?? 6, pathPrefix });
      if (hits.length === 0) {
        return textResult('No vault hits.');
      }
      return textResult(formatSearchHits(hits, 3000));
    },
  );

  server.tool(
    'memory_embed_backfill',
    'Compute embeddings for vault chunks and/or durable facts using the active embedding provider. Runs in small batches; safe to invoke repeatedly. No-ops when no provider is available.',
    {
      maxChunks: z.number().int().min(1).max(2000).optional(),
      scope: z.enum(['vault', 'facts', 'all']).optional(),
    },
    async ({ maxChunks, scope }) => {
      const selectedScope = scope ?? 'all';
      const max = maxChunks ?? 200;
      const lines = [`Embedding backfill (${selectedScope}, max ${max} per store):`];

      if (selectedScope === 'vault' || selectedScope === 'all') {
        const stats = await embedMissingChunks({ maxChunks: max });
        const embStats = readEmbeddingStats();
        lines.push(
          `Vault chunks: embedded ${stats.embedded} / ${stats.candidateChunks} candidates in ${stats.durationMs}ms`,
          `Vault batches: ${stats.batched}, failures: ${stats.failed}${stats.reason ? `, reason: ${stats.reason}` : ''}`,
          `Vault total embeddings: ${embStats.count} (${embStats.model ?? '-'}, dim ${embStats.dim ?? '-'})`,
        );
      }

      if (selectedScope === 'facts' || selectedScope === 'all') {
        const stats = await embedMissingFacts({ maxChunks: max });
        const embStats = readFactEmbeddingStats();
        lines.push(
          `Facts: embedded ${stats.embedded} / ${stats.candidateChunks} candidates in ${stats.durationMs}ms`,
          `Fact batches: ${stats.batched}, failures: ${stats.failed}${stats.reason ? `, reason: ${stats.reason}` : ''}`,
          `Fact total embeddings: ${embStats.count} (${embStats.model ?? '-'}, dim ${embStats.dim ?? '-'})`,
        );
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'memory_remember',
    'Record a durable fact in long-term memory. One-off commands, questions, and task requests are rejected; put those in task/focus/working memory instead. Use for user preferences (kind=user), project context (project), standing feedback (feedback), or external references (reference). When the fact explicitly names people, companies, projects, places, or things, include structured entities so Clementine creates or reuses their canonical identity and grounds the graph link in this fact\'s durable evidence. If the content explicitly states a relationship between two included entities, add subject/predicate/object under relationships; only controlled predicates and relationships supported verbatim by the durable fact are accepted. Include an alias or identifier only when it is literally present in content; unsupported annotations are rejected. Use kind=constraint for an ENFORCEABLE standing rule that must HARD-GATE tool dispatch — a sender/account/destination routing rule ("always send Outlook mail from billing@acme.co", "only write Salesforce in the sandbox org") or a never-do guardrail ("never post to the prod channel"). A constraint is auto-pinned and is checked by the dispatch gate on every matching tool call, so reserve it for rules that should BLOCK a wrong action, not general preferences. Idempotent — re-recording the same fact bumps its score.',
    {
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]),
      content: z.string().min(3).max(800),
      sessionId: z.string().optional(),
      sourcePath: z.string().optional(),
      entities: z.array(z.object({
        type: z.enum(MEMORY_ENTITY_TYPES),
        name: z.string().min(2).max(120),
        aliases: z.array(z.string().min(2).max(120)).max(12).optional(),
        identifiers: z.array(z.object({
          scheme: z.enum(['email', 'phone', 'domain', 'url', 'handle']),
          value: z.string().min(2).max(240),
          confidence: z.number().min(0).max(1).optional(),
        })).max(12).optional(),
        confidence: z.number().min(0).max(1).optional(),
      })).max(12).optional(),
      relationships: z.array(z.object({
        subject: z.string().min(2).max(120),
        predicate: z.string().min(2).max(80),
        object: z.string().min(2).max(120),
        confidence: z.number().min(0).max(1).optional(),
        validFrom: z.string().max(64).optional(),
        validTo: z.string().max(64).optional(),
      })).max(12).optional(),
    },
    async ({ kind, content, sessionId, sourcePath, entities, relationships }) => {
      try {
        if (looksLikeHighConfidenceTransientRequest(content)) {
          return textResult(
            'Not remembered: this reads like a one-time command, question, or task request rather than durable memory. '
            + 'Keep it in the active task/focus or create a task; rewrite only the stable fact or recurring rule if one was actually stated.',
          );
        }
        // There is intentionally no legacy direct-write switch here. Every
        // public remember operation must pass through the same semantic
        // duplicate/conflict resolver, evidence capture, and temporal history
        // path or reliability depends on deployment configuration.
        const outcome = await consolidateFact(
          {
            kind: kind as (typeof FACT_KINDS)[number],
            text: content,
            trustLevel: 1.0,
            authority: 'user',
            sourceUri: sourcePath,
          },
          { sessionId },
          { noveltyFastPathSim: REMEMBER_NOVELTY_FAST_PATH_SIM },
        );
        const verb = outcome.action === 'supersede'
          ? 'Superseded the prior fact with'
          : outcome.action === 'reinforce'
            ? 'Reinforced an existing fact'
            : outcome.action === 'ignore'
              ? 'Already known — no change'
              : 'Remembered';
        const graphSummary = outcome.factId
          ? enrichRememberedFact(
              outcome.factId,
              entities as RememberedEntityAnnotation[] | undefined,
              relationships as RememberedRelationshipAnnotation[] | undefined,
            )
          : '';
        return textResult(`${verb} (${kind}): ${content}${graphSummary}`);
      } catch (err) {
        return textResult(`memory_remember failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'memory_list_facts',
    'List durable facts. Defaults to top active facts by score; set includeInactive=true to see soft-deleted history.',
    {
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeInactive: z.boolean().optional(),
    },
    async ({ kind, limit, includeInactive }) => {
      const facts = includeInactive
        ? listAllFacts(limit ?? 25).filter((fact) => !kind || fact.kind === kind)
        : listActiveFacts({
            limit: limit ?? 25,
            kind: kind as (typeof FACT_KINDS)[number] | undefined,
          });

      if (facts.length === 0) return textResult('No facts recorded yet.');

      const lines = facts.map((fact) => {
        const flag = fact.active ? '' : ' [inactive]';
        return `- #${fact.id} ${fact.kind} (${fact.score.toFixed(2)})${flag}: ${fact.content}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'source_map_upsert',
    'Record WHERE a resource lives in one of the user\'s connected sources — a Drive folder, an Airtable base/table, a CRM object, a mail label/folder — as a navigation POINTER, never its content. Use when you enumerate or discover the STRUCTURE of a connected source (the user asks to "map"/"index" a source, or you list its folders/bases/objects). One call per resource. Pass providerId (the real id from the source, e.g. the Drive folder id) so the pointer dedupes and stays stable; parentRef links it into a tree.',
    {
      app: z.string().min(1),                 // friendly app name, e.g. "Google Drive"
      kind: z.string().min(1),                // folder | file | base | table | object | channel | label
      name: z.string().min(1),
      providerId: z.string().optional(),      // the source's stable id (preferred)
      whatsHere: z.string().optional(),       // one phrase: what this holds
      whenToUse: z.string().optional(),       // when to navigate here
      parentRef: z.string().optional(),       // canonicalRef of the parent (tree)
    },
    async ({ app, kind, name, providerId, whatsHere, whenToUse, parentRef }) => {
      // Writes are gated on the same flag as the reader (renderSourceMapForContext)
      // — otherwise the model could write resource_pointers rows that nothing ever
      // surfaces when the feature is off (silent, invisible accumulation).
      if (!isSourceMapEnabled()) {
        return textResult('source_map_upsert is disabled (CLEMMY_SOURCE_MAP is off) — not recording.');
      }
      try {
        const p = upsertResourcePointer({ app, kind, name, providerId, whatsHere, whenToUse, parentRef, source: 'reactive' });
        return textResult(`Mapped ${p.app} ${p.kind}: ${p.name}`);
      } catch (err) {
        return textResult(`source_map_upsert failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'memory_search_facts',
    'Semantically search durable FACTS (your long-term memory of the user, projects, standing feedback, references) by meaning. Unlike memory_search/memory_recall (which search the vault notes), this queries the consolidated_facts store directly via embeddings — use it to answer "what do I already know about X?" before asking the user or re-deriving. Returns the most relevant facts even when they share no exact words with the query.',
    {
      query: z.string().min(1),
      kind: z.enum(FACT_KINDS as unknown as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ query, kind, limit }) => {
      const facts = await searchFacts(query, {
        kind: kind as (typeof FACT_KINDS)[number] | undefined,
        topK: limit ?? 8,
      });
      // A returned candidate is an impression, not proof the agent materially
      // used it. Utility is reserved for an applied/cited memory signal so a
      // broad search cannot make every displayed row rank higher next time.
      for (const fact of facts) recordFactImpression(fact.id);
      appendFactRecallTrace({
        surface: 'memory_search_facts',
        query,
        facts: facts.map((fact) => ({ fact, reason: 'agent-tool-semantic-search' })),
      });
      let recallId: string | undefined;
      try {
        const run = recordRecallRun({
          objective: query,
          surface: 'memory_search_facts',
          answerability: facts.length > 0 ? 'partial' : 'insufficient',
          candidateRefs: facts.map((fact) => ({ type: 'fact', id: String(fact.id), snippet: fact.content })),
        });
        recallId = run.id;
        noteTurnRecallRun(run.id);
      } catch {
        // Attribution must never make a scoped recall unavailable.
      }
      if (facts.length === 0) {
        return textResult(`No relevant facts found.${recallId ? ` Recall ${recallId}.` : ''}`);
      }
      const lines = facts.map((fact) => `- [fact:${fact.id}] ${fact.kind}: ${fact.content}`);
      if (recallId) {
        lines.push(`[USE FEEDBACK] If an exact fact materially changes your answer, plan, or tool choice, call memory_mark_used once with recall_id ${recallId} and only the exact fact:<id> ref(s) used.`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'memory_recall_all',
    'Recall EVERYTHING relevant to an objective in one call — durable facts, vault notes, known people/things (entities), where data lives (resources), and proven tools (tool-recall) — ranked together across all memory stores. Use this as the FIRST lookup for "what do I already know / have / use for X?" instead of firing memory_search, memory_search_facts, etc. separately. Returns a single ranked list tagged by kind (FACT/NOTE/WHO·WHAT/WHERE/HOW).',
    {
      objective: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ objective, limit }) => {
      const result = await recallEverything(objective, { limit: limit ?? 12 });
      scheduleRecallShadow({ query: objective, surface: 'memory_recall_all', limit: limit ?? 12 });
      try {
        const recallId = createRecallRunId();
        result.recallId = recallId;
        result.hits = visibleUnifiedRecallHits(result, 4000);
        const run = recordRecallRun({
          id: recallId,
          objective,
          surface: 'memory_recall_all',
          answerability: result.answerability ?? 'partial',
          candidateRefs: result.hits.map(unifiedHitRecallRef),
        });
        result.recallId = run.id;
        noteTurnRecallRun(run.id);
      } catch {
        delete result.recallId;
        // Attribution must never make recall unavailable.
      }
      if (result.hits.length === 0) {
        const recall = result.recallId ? ` Recall ${result.recallId}.` : '';
        return textResult(`No relevant memory found across facts, notes, entities, resources, episodes, policies, or procedures.${recall}`);
      }
      const block = formatUnifiedRecall(result, 4000);
      // Record exposure only. Unified recall deliberately returns alternatives;
      // simply appearing in that pack does not establish material usefulness.
      const recalledFactIds = new Set(result.hits
        .filter((h) => h.type === 'fact' || h.type === 'policy')
        .map((h) => Number(h.ref))
        .filter(Number.isFinite));
      for (const id of recalledFactIds) recordFactImpression(id);
      const facts = result.hits
        .filter((h) => h.type === 'fact' || h.type === 'policy')
        .map((h) => getFact(Number(h.ref)))
        .filter((fact): fact is ConsolidatedFact => Boolean(fact));
      appendFactRecallTrace({
        surface: 'memory_recall_all',
        query: objective,
        facts: facts.map((fact) => ({ fact, reason: 'agent-tool-unified-recall' })),
      });
      const attribution = result.recallId
        ? `\n[USE FEEDBACK] If a returned memory materially changes your answer, plan, or tool choice, call memory_mark_used once with recall_id ${result.recallId} and only the exact ref(s) you used. Do not credit merely displayed alternatives.`
        : '';
      return textResult(block + attribution);
    },
  );

  server.tool(
    'memory_mark_used',
    'Attribute material use of an exact memory_recall_all result. Call this once after one or more returned refs actually change your answer, plan, scope, or tool choice; never mark every displayed candidate. The recall id and refs must be copied exactly from that recall result. Retries are idempotent.',
    {
      recall_id: z.string().min(1),
      refs: z.array(z.string().min(3)).min(1).max(20),
      outcome: z.enum(['used', 'not_useful']).optional(),
      detail: z.string().max(500).optional(),
    },
    async ({ recall_id, refs, outcome, detail }) => {
      const result = recordRecallUse({ recallId: recall_id, refs, outcome, detail });
      if (!result.ok) {
        const reason = result.reason === 'expired'
          ? 'That recall attribution window has expired.'
          : 'No recall run exists with that id.';
        return textResult(`${reason} No utility was recorded.`);
      }
      const parts = [
        `Recorded ${result.recorded.length} ${outcome === 'not_useful' ? 'not-useful' : 'material-use'} ref${result.recorded.length === 1 ? '' : 's'}.`,
      ];
      if (result.utilityFactIds.length > 0) parts.push(`Credited fact${result.utilityFactIds.length === 1 ? '' : 's'} #${result.utilityFactIds.join(', #')}.`);
      if (result.duplicates.length > 0) parts.push(`${result.duplicates.length} duplicate${result.duplicates.length === 1 ? '' : 's'} ignored.`);
      if (result.rejected.length > 0) parts.push(`${result.rejected.length} ref${result.rejected.length === 1 ? '' : 's'} rejected because it was not returned by that recall.`);
      return textResult(parts.join(' '));
    },
  );

  server.tool(
    'memory_forget',
    'Soft-delete a fact by id (sets active=0). Pass hard=true to drop the row entirely.',
    {
      id: z.number().int().positive(),
      hard: z.boolean().optional(),
    },
    async ({ id, hard }) => {
      const fact = getFact(id);
      if (!fact) return textResult(`No fact found with id ${id}.`);
      const review = reviewForgetRequest(fact, hard === true);
      if (!review.allow) return textResult(`Refused: ${review.reason}`);
      const ok = forgetFact(id, { hard });
      if (ok && fact.kind === 'constraint') notifyStandingRuleChange('forgotten', fact);
      return textResult(ok ? `Forgot fact #${id}${hard ? ' (hard delete)' : ''}.` : `No fact found with id ${id}.`);
    },
  );

  server.tool(
    'memory_restore',
    'Restore (reactivate) a soft-deleted fact by id — the inverse of memory_forget. Use when the user says "restore fact #N" / "bring back that rule". No-op if the fact is already active or was hard-deleted.',
    {
      id: z.number().int().positive(),
    },
    async ({ id }) => {
      const ok = reactivateFact(id);
      const fact = ok ? getFact(id) : null;
      return textResult(
        ok
          ? `Restored fact #${id}${fact ? `: ${fact.content.slice(0, 200)}` : ''}. If it was a pinned standing instruction before, re-pin it with memory_pin.`
          : `Could not restore fact #${id} — it is either already active or was hard-deleted.`,
      );
    },
  );

  server.tool(
    'memory_pin',
    'Pin a fact as a STANDING INSTRUCTION (always injected into context, exempt from the recency/relevance cap so it never ages out) — or unpin it. Use when the user says "always …", "never …", or "from now on …". Pin sparingly: only durable rules that should hold across every session, not one-off facts.',
    {
      id: z.number().int().positive(),
      pinned: z.boolean().optional(),
    },
    async ({ id, pinned }) => {
      const want = pinned !== false;
      const fact = getFact(id);
      if (!fact) return textResult(`No fact found with id ${id}.`);
      const ok = setFactPinned(id, want);
      // Unpinning removes a standing instruction's always-applied protection —
      // surface every such change to the user (pinning a constraint too, so
      // rule lifecycle is fully visible).
      if (ok && !want && fact.pinned) notifyStandingRuleChange('unpinned', fact);
      else if (ok && want && fact.kind === 'constraint' && !fact.pinned) notifyStandingRuleChange('pinned', fact);
      return textResult(
        ok
          ? `${want ? 'Pinned' : 'Unpinned'} fact #${id}${want ? ' — it will always be applied' : ''}: ${fact.content}`
          : `Could not update fact #${id}.`,
      );
    },
  );

  server.tool(
    'memory_review_instructions',
    'Before a batch/irreversible external write, review the standing instructions in play. Pass the objective to sort by relevance (least-relevant first, so a possibly off-objective rule is easy to spot). Returns each as "#id [kind, imp N, rel R] content — sourceHint" so you can show the user what you are following and, if one looks stale or wrong for this objective, ask them and then call memory_forget(id). Relevance is a lexical hint, not a verdict — use your judgment, do not auto-delete.',
    {
      objective: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ objective, limit }) => {
      const items = reviewStandingInstructions(objective, { limit: limit ?? 20 });
      if (items.length === 0) return textResult('No standing instructions recorded.');
      const lines = items.map((i) =>
        `- #${i.id} [${i.kind}, imp ${i.importance.toFixed(0)}, rel ${i.relevance.toFixed(2)}${i.pinned ? ', 📌pinned' : ''}] ${i.content} — ${i.sourceHint}`,
      );
      return textResult(
        `Standing instructions in play${objective ? ` (vs objective: ${objective.slice(0, 80)})` : ''}:\n${lines.join('\n')}\n\n` +
        'If any look unrelated or wrong for this objective, ask the user before applying — and offer to memory_forget(id) the stale one.',
      );
    },
  );

  server.tool(
    'memory_self_heal',
    'Inspect or run the audited long-term-memory self-heal loop. Use list/dry_run first to review proposed reversible fixes. run applies bounded fixes; revert restores a prior memory-heal audit id.',
    {
      action: z.enum(['list', 'dry_run', 'run', 'apply', 'revert']),
      fixId: z.string().optional(),
      auditId: z.string().optional(),
      maxApply: z.number().int().min(0).max(20).optional(),
      maxCandidates: z.number().int().min(1).max(100).optional(),
    },
    async ({ action, fixId, auditId, maxApply, maxCandidates }) => {
      try {
        if (action === 'list') {
          const detected = detectMemoryHealCandidates({ maxCandidates: maxCandidates ?? 20, persistProposals: false });
          const stored = listProposedMemoryFixes();
          const byId = new Map([...detected, ...stored].map((fix) => [fix.id, fix]));
          const fixes = [...byId.values()].slice(-Math.max(1, maxCandidates ?? 20)).reverse();
          if (fixes.length === 0) return textResult('No memory self-heal proposals found.');
          return textResult(`Memory self-heal proposals:\n${fixes.map(formatMemoryFix).join('\n')}`);
        }
        if (action === 'dry_run') {
          const outcome = await runMemorySelfHeal({ dryRun: true, maxApply: maxApply ?? 5, maxCandidates: maxCandidates ?? maxApply ?? 5 });
          return textResult(formatMemorySelfHealOutcome(outcome));
        }
        if (action === 'run') {
          const outcome = await runMemorySelfHeal({ maxApply: maxApply ?? 5, maxCandidates: maxCandidates ?? maxApply ?? 5 });
          return textResult(formatMemorySelfHealOutcome(outcome));
        }
        if (action === 'apply') {
          if (!fixId) return textResult('Missing fixId for memory_self_heal action=apply.');
          const result = await applyMemoryFix(fixId);
          return textResult(`${result.ok ? 'Applied' : 'Skipped'} ${result.kind} ${result.fixId}: ${result.message}${result.auditId ? ` audit=${result.auditId}` : ''}`);
        }
        if (!auditId) return textResult('Missing auditId for memory_self_heal action=revert.');
        const reverted = revertMemoryHeal(auditId);
        return textResult(`${reverted.ok ? 'Reverted' : 'Could not revert'} ${auditId}: ${reverted.message}${reverted.ids.length ? ` ids=${reverted.ids.join(',')}` : ''}`);
      } catch (err) {
        return textResult(`memory_self_heal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'memory_import',
    [
      'Import ANOTHER agent\'s memory files (Claude Code memories, OpenClaw/Fermis stores, bare memory.md / AGENTS.md — any local folder or file) into Clementine\'s own memory: normalized into facts, deduped, embedded, and reachable via semantic recall.',
      'Actions: discover (propose known agent-memory locations on this machine), scan (list importable files under a path with previews — show the user BEFORE ingesting), ingest (import a path; confirm the path with the user first), batches (list past imports), undo (remove every fact a batch added).',
      'Ingest is additive and undoable; it never modifies the source files.',
    ].join(' '),
    {
      action: z.enum(['discover', 'scan', 'ingest', 'batches', 'undo']),
      path: z.string().nullable().optional().describe('Folder or file to scan/ingest (required for scan and ingest). ~ expands.'),
      source_label: z.string().max(60).nullable().optional().describe('Short provenance label, e.g. "openclaw" — facts get sourceApp import:<label>.'),
      batch_id: z.string().nullable().optional().describe('Batch id for undo.'),
      distill: z.boolean().nullable().optional().describe('LLM-distill freeform files into discrete facts (default true). false = deterministic harvest only.'),
    },
    async ({ action, path: targetPath, source_label, batch_id, distill }) => {
      try {
        const { discoverKnownMemorySources, scanMemorySource, ingestMemorySource, listMemoryImportBatches, undoMemoryImportBatch } = await import('../memory/memory-import.js');
        if (action === 'discover') {
          const found = discoverKnownMemorySources();
          if (found.length === 0) return textResult('No known agent-memory locations found on this machine. The user can point me at any folder or file instead.');
          return textResult(['Importable agent-memory sources found (nothing imported yet — ask the user which to bring in):',
            ...found.map((s) => `- ${s.label}: ${s.path} (${s.fileCount} file${s.fileCount === 1 ? '' : 's'})`)].join('\n'));
        }
        if (action === 'scan') {
          if (!targetPath) return textResult('memory_import scan needs a path.');
          const scan = scanMemorySource(targetPath);
          const lines = [`Scan of ${scan.root}: ${scan.files.length} importable file(s), ${scan.skipped.length} skipped.`];
          for (const f of scan.files.slice(0, 30)) lines.push(`- ${f.path} [${f.shape}] ${Math.round(f.bytes / 1024)}KB — ${f.preview.slice(0, 120)}`);
          if (scan.files.length > 30) lines.push(`- … ${scan.files.length - 30} more`);
          return textResult(lines.join('\n'));
        }
        if (action === 'ingest') {
          if (!targetPath) return textResult('memory_import ingest needs a path.');
          const batch = await ingestMemorySource(targetPath, { sourceLabel: source_label ?? undefined, distill: distill ?? true });
          return textResult(
            `Imported ${batch.fileCount} file(s) from ${batch.root} as batch ${batch.id}: `
            + `${batch.newFactIds.length} new fact(s), ${batch.dedupedCount} already known, `
            + `${batch.distilledFiles} distilled, ${batch.fallbackFiles} harvested deterministically, ${batch.errors.length} error(s). `
            + 'Embedding started — the facts are entering semantic recall now. Undo anytime with action=undo batch_id=' + batch.id + '.',
          );
        }
        if (action === 'batches') {
          const batches = listMemoryImportBatches();
          if (batches.length === 0) return textResult('No memory imports yet.');
          return textResult(batches.slice(0, 15).map((b) =>
            `- ${b.id} · ${b.sourceLabel} · ${b.root} · ${b.startedAt} · +${b.newFactIds.length} facts (${b.dedupedCount} deduped)`).join('\n'));
        }
        if (!batch_id) return textResult('memory_import undo needs a batch_id.');
        const undone = undoMemoryImportBatch(batch_id);
        if (!undone.batch) return textResult(`No import batch found with id ${batch_id}.`);
        return textResult(`Undid batch ${batch_id}: removed ${undone.deleted} imported fact(s).`);
      } catch (err) {
        return textResult(`memory_import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
