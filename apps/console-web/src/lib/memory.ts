import { apiGet, apiPatch, apiPost } from './api';

export interface Fact {
  id: number | string;
  kind: 'user' | 'project' | 'feedback' | 'reference' | 'constraint';
  content: string;
  importance?: number | null;
  updatedAt?: string;
  pinned?: boolean;
  active?: boolean;
  createdAt?: string;
  confidence?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  supersededByFactId?: number | null;
  impressionCount?: number;
  utilityCount?: number;
  evidence?: Array<{ episodeId: string; excerpt: string; sourceUri?: string; occurredAt?: string; status?: string }>;
  validityIntervals?: Array<{ id: number; factId: number; validFrom: string; validTo: string | null; openedReason: string; closedReason: string | null }>;
  policy?: { policy_type: 'hard_constraint' | 'core_profile' | 'standing_preference'; enforcement: 'dispatch' | 'prompt'; applies_to_json?: string; priority: number } | null;
}

export interface Goal {
  id?: string;
  title?: string;
  objective?: string;
  priority?: string;
  description?: string;
  nextActions?: string[];
  status?: string;
}

export interface UserProfile {
  name?: string;
  displayName?: string;
  preferredName?: string;
  role?: string;
  timezone?: string;
  tone?: string;
  communicationTone?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  notes?: string;
  [k: string]: unknown;
}

export const FACT_KINDS: { key: Fact['kind']; label: string }[] = [
  { key: 'user', label: 'About you' },
  { key: 'project', label: 'Projects' },
  { key: 'feedback', label: 'Preferences' },
  { key: 'reference', label: 'Reference' },
  { key: 'constraint', label: 'Constraints' },
];

export const listFacts = (kind?: Fact['kind'], limit = 80, includeInactive = false) =>
  apiGet<{ facts: Fact[]; total: number; visible: number }>(`/api/console/memory/facts?${kind ? `kind=${kind}&` : ''}limit=${limit}${includeInactive ? '&includeInactive=1' : ''}`);

export const forgetFact = (id: Fact['id']) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/forget`);

export const pinFact = (id: Fact['id'], pinned = true) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/pin`, { pinned });

/** Reverse a soft-delete (forget / auto-clean / approved retire/merge). The
 *  undo half of every reversible memory action — 30-day window. */
export const restoreFact = (id: Fact['id']) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/restore`);

export const updateFact = (id: Fact['id'], patch: { content?: string; importance?: number }) =>
  apiPatch<{ ok: boolean; fact: Fact; supersededFactId?: number | null }>(`/api/console/memory/facts/${encodeURIComponent(String(id))}`, patch);

export interface MemoryReviewCandidate {
  id: string;
  kind: 'retire_transient_request' | 'merge_duplicate';
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  reversible: true;
  targetIds: number[];
  targetFacts: Fact[];
  payload?: { keepId?: number; dropId?: number; similarity?: number };
}
export const listMemoryReviewCandidates = (limit = 25) =>
  apiGet<{
    candidates: MemoryReviewCandidate[];
    total: number;
    visible: number;
    byKind: { merge_duplicate: number; retire_transient_request: number };
  }>(`/api/console/memory/review-candidates?limit=${limit}`);
export const applyMemoryReviewCandidate = (id: string) =>
  apiPost<{ ok: boolean; auditId?: string; message: string }>(`/api/console/memory/review-candidates/${encodeURIComponent(id)}/apply`);
export const dismissMemoryReviewCandidate = (id: string) =>
  apiPost<{ ok: true; id: string; status: 'skipped' }>(`/api/console/memory/review-candidates/${encodeURIComponent(id)}/dismiss`);

/** A core context file Clementine reads every turn (SOUL/IDENTITY/MEMORY/working). */
export interface ContextFile {
  key: string;
  title: string;
  description?: string;
  content?: string;
  bytes?: number;
  empty?: boolean;
  /** Long-Term Memory (`memory` key) only: count of durable facts backing the
   *  generated projection — rendered as a "View N learned facts" link to Facts. */
  learnedFactCount?: number;
  /** Working Memory (`working_memory` key) only: which session the shown
   *  short-term memory was resolved from. */
  sessionLabel?: string;
}

export const getContext = () =>
  apiGet<{ profile?: UserProfile; goals?: Goal[]; files?: ContextFile[] }>('/api/console/context');

export interface MemoryHit {
  ref: { type: 'fact' | 'entity' | 'resource' | 'episode' | 'note' | 'procedure' | 'policy'; id: string | number };
  title?: string;
  text: string;
  score: number;
  confidence: number;
  evidence: Array<{ episodeId: string; excerpt: string; sourceUri?: string }>;
  whyRecalled: string[];
  validFrom?: string;
  validTo?: string;
}
export const searchMemory = (q: string) =>
  apiGet<{ query: string; hits: MemoryHit[]; answerability: 'supported' | 'partial' | 'insufficient'; diagnostics: { candidates: number; stores: string[]; elapsedMs: number } }>(`/api/console/memory/search-all?q=${encodeURIComponent(q)}`);

export type MemoryEpisodeKind = 'user_turn' | 'tool_result' | 'import' | 'manual' | 'reflection';
export type MemoryEpisodeStatus = 'available' | 'partial' | 'missing' | 'pending' | 'expired';
export interface MemoryEpisodeCandidate {
  id: number;
  kind: string;
  text: string;
  importance: number;
  status: 'pending' | 'promoted' | 'rejected' | 'expired';
  reason: string | null;
  sourceType: string;
  intakeReason: string | null;
  resultingFactId: number | null;
  /** Number of pending source observations with this exact normalized claim.
   * One owner decision resolves the available cluster while preserving every
   * episode as independent evidence. */
  pendingEquivalentCount: number;
}
export interface MemoryEpisode {
  id: string;
  kind: MemoryEpisodeKind;
  subtype: string | null;
  title: string | null;
  sourceApp: string | null;
  sourceUri: string | null;
  occurredAt: string;
  ingestedAt: string;
  status: MemoryEpisodeStatus;
  excerpt: string;
  excerptTruncated: boolean;
  metadata: Record<string, unknown>;
  claimCount: number;
  entityCount: number;
  candidateCount: number;
  pendingCandidateCount: number;
  candidates: MemoryEpisodeCandidate[];
}
export interface MemoryEpisodeList {
  total: number;
  allTotal: number;
  visible: number;
  offset: number;
  hasMore: boolean;
  summary: {
    byKind: Partial<Record<MemoryEpisodeKind, number>>;
    byStatus: Partial<Record<MemoryEpisodeStatus, number>>;
    meetings: number;
    pendingCandidates: number;
    pendingUniqueClaims: number;
    pendingCandidatesBySource: Record<string, number>;
    pendingUniqueClaimsBySource: Record<string, number>;
  };
  episodes: MemoryEpisode[];
}
export const listMemoryEpisodes = (options: {
  kind?: MemoryEpisodeKind | 'meeting' | 'all';
  status?: MemoryEpisodeStatus | 'all';
  review?: 'pending' | 'all';
  candidateSource?: 'tool_reflection' | 'recursive_reflection' | 'auto_capture' | 'meeting_analysis' | 'manual' | 'import' | 'all';
  query?: string;
  limit?: number;
  offset?: number;
} = {}) => {
  const params = new URLSearchParams();
  if (options.kind && options.kind !== 'all') params.set('kind', options.kind);
  if (options.status && options.status !== 'all') params.set('status', options.status);
  if (options.review && options.review !== 'all') params.set('review', options.review);
  if (options.candidateSource && options.candidateSource !== 'all') params.set('candidateSource', options.candidateSource);
  if (options.query?.trim()) params.set('q', options.query.trim());
  params.set('limit', String(options.limit ?? 80));
  if (options.offset) params.set('offset', String(options.offset));
  return apiGet<MemoryEpisodeList>(`/api/console/memory/episodes?${params.toString()}`);
};
export const promoteMemoryEpisodeCandidate = (id: number) =>
  apiPost<{
    ok: true;
    candidateId: number;
    factId: number;
    action: 'reinforce' | 'supersede' | 'add' | 'ignore';
    coalescedCandidateIds: number[];
    evidenceSourcesAdded: number;
  }>(`/api/console/memory/reflection-candidates/${encodeURIComponent(String(id))}/promote`);
export const rejectMemoryEpisodeCandidate = (id: number) =>
  apiPost<{
    ok: true;
    candidateId: number;
    status: 'rejected';
    rejectedCandidateIds: number[];
    rejectedCount: number;
  }>(`/api/console/memory/reflection-candidates/${encodeURIComponent(String(id))}/reject`);

export interface VaultFile { path: string; chunks: number; mtime: number; byteSize: number }
export const getMemoryFiles = () =>
  apiGet<{ files: VaultFile[]; status?: unknown }>('/api/console/memory/files');

export function fileBasename(p: string): string {
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

export const addFact = (content: string, kind: Fact['kind'] = 'user') =>
  apiPost<{
    fact: Fact | null;
    consolidation: { action: 'add' | 'reinforce' | 'supersede' | 'ignore'; supersededFactId: number | null };
    facts: Fact[];
  }>('/api/console/context/facts', { content, kind });

export const addGoal = (title: string, description: string, priority: 'high' | 'medium' | 'low' = 'medium') =>
  apiPost('/api/console/context/goals', { title, description, priority });

export interface BrainHealth {
  activeFacts?: number; derivedFacts?: number; directFacts?: number; avgImportance?: number;
  entitiesTotal?: number; entitiesPerson?: number; entitiesCompany?: number; entitiesProject?: number; entitiesPlace?: number; entitiesThing?: number;
  pointersTotal?: number; pointersRecent?: number; reflections24h?: number;
  memoryEpisodesTotal?: number; memoryEpisodesRecent?: number; recordedMeetingsTotal?: number;
}
export const getBrainHealth = () => apiGet<BrainHealth>('/api/console/brain/health');

/** Rich memory health — embedding coverage + recall hit-rate. Distinct from
 *  BrainHealth: this is the signal that makes silent semantic degradation
 *  (no embedding key / circuit-broken) legible in the Memory screen. */
export interface MemoryHealth {
  facts?: { active?: number; inactive?: number; total?: number; pinned?: number };
  entities?: number;
  episodicPointers?: number;
  focusActive?: number;
  embeddings?: {
    enabled?: boolean;
    breakerOpen?: boolean;
    lastErrorClass?: string | null;
    model?: string | null;
    dim?: number | null;
    factCoverage?: number;
    vaultCoverage?: number;
    factEmbeds?: number;
    chunkEmbeds?: number;
  };
  recall?: { calls?: number; hits?: number; empties?: number; hitRate?: number };
  reliability?: {
    evidenceLinked?: number; evidenceAvailable?: number; evidenceUnavailable?: number;
    unreconciledEvidence?: number; unreconciledDerivedEvidence?: number; unavailableDerivedEvidence?: number;
    evidenceCoverage?: number; brokenEvidence?: number; missingEpisodes?: number;
    pendingReflections?: number; oldestPending?: string | null; unreachableFacts?: number;
    impressions?: number; utility?: number;
    policies?: Record<string, number>;
    policyCoverage?: { compiledHard?: number; promptOnlyConstraintFacts?: number; overstatedDispatch?: number };
    relationships?: Record<string, number>;
    shadow?: {
      samples: number; averageOverlap: number; primaryOnly: number; legacyOnly: number;
      tailHits: number; evidenceBacked: number; primaryFacts: number; evidenceRate: number;
      supported: number; lastAt: string | null; bySurface: Record<string, number>;
    };
    recallUsage?: {
      windowDays: number; runs: number; usedRuns: number; conversionRate: number | null;
      usedRefs: number; notUsefulRefs: number; refUtilityEvents: number;
      refTypeUses: Partial<Record<'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure', number>>;
      topRefShare: number | null;
      topRef: { type: 'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure'; id: string; uses: number } | null;
      factUtilityEvents: number;
      topFactShare: number | null;
      topFact: { id: number; content: string; uses: number } | null;
    };
    reflectionReplay?: {
      total: number; processing: number; buffered: number; completed: number;
      failed: number; retried: number; staleProcessing: number;
    };
    reflectionCandidates?: {
      total: number; pending: number; promoted: number; rejected: number; expired: number;
      pendingUniqueClaims: number; duplicatePendingObservations: number; knownExactPending: number;
      overduePending: number; orphanedPending: number; retrying: number; failedPending: number;
      oldestPending: string | null;
      promotionRate: number | null; rejectionReasons: Record<string, number>;
    };
    promptContext?: {
      windowDays: number; runs: number; injectedRuns: number;
      telemetryCompleteRuns: number; unknownOmissionRuns: number;
      included: number; omitted: number; candidates: number;
      omissionRate: number | null; lastAt: string | null;
      last: {
        included: number; omitted: number | null; candidates: number | null;
        source: string | null; injected: boolean;
      } | null;
      bySource: Record<string, number>;
      standingContext: {
        runs: number; telemetryCompleteRuns: number; unknownOmissionRuns: number;
        included: number; omitted: number; lastAt: string | null;
        last: {
          mode: string | null; included: number; omitted: number | null;
          candidates: number | null; enforcementBacked: number;
        } | null;
      };
    };
  };
}
export const getMemoryHealth = () => apiGet<MemoryHealth>('/api/console/memory/health');

export interface ReflectionCandidateDecision {
  id: number;
  episodeId: string | null;
  sessionId: string;
  callId: string;
  kind: string;
  text: string;
  importance: number;
  status: 'pending' | 'promoted' | 'rejected' | 'expired';
  reason: string | null;
  sourceType: 'tool_reflection' | 'recursive_reflection' | 'auto_capture' | 'meeting_analysis' | 'manual' | 'import';
  intakeReason: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  resultingFactId: number | null;
  resultingFactContent: string | null;
  sourceApp: string | null;
  sourceUri: string | null;
  occurredAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export const listReflectionCandidates = (
  limit = 50,
  status?: ReflectionCandidateDecision['status'],
) => apiGet<{
  candidates: ReflectionCandidateDecision[];
  health: NonNullable<NonNullable<MemoryHealth['reliability']>['reflectionCandidates']>;
}>(`/api/console/memory/reflection-candidates?limit=${limit}${status ? `&status=${status}` : ''}`);

export type MemoryReadinessStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface MemoryReadinessCheck {
  id: string;
  label: string;
  status: MemoryReadinessStatus;
  blocking: boolean;
  summary: string;
  metrics?: Record<string, number | string | null>;
}
export interface MemoryReadinessReport {
  reportVersion: 1;
  generatedAt: string;
  mode: 'read-only';
  expectedSchemaVersion: number;
  observedSchemaVersion: number | null;
  ready: boolean;
  summary: Record<MemoryReadinessStatus, number>;
  checks: MemoryReadinessCheck[];
  inventory?: {
    facts: { active: number; inactive: number; derivedActive: number; neverUsedActive: number };
    policies: { hardConstraints: number; coreProfile: number; standingPreferences: number };
    evidence: {
      derivedWithUsableEvidence: number; unavailableHistoricalDerived: number;
      unreconciledDerived: number; postUpgradeDerivedWithoutUsableEvidence: number;
    };
    graph: {
      factEntityStored: number; factEntityInferred: number;
      factResourceStored: number; factResourceInferred: number;
      entityObservationStored: number; entityObservationBroken: number;
      episodeArtifactStored: number; episodeArtifactBroken: number;
      entityRelationships: number; groundedEntityRelationships: number;
    };
    identity: {
      canonicalEntities: number; redirects: number;
      exactEmailCollisionGroups: number; exactNameReviewSignals: number;
    };
    recall: {
      runs30d: number; usedRuns30d: number; usedRefs30d: number;
      topFactShare30d: number | null;
    };
    reflectionCandidates: {
      total: number; pending: number; promoted: number; rejected: number; expired: number;
      pendingUniqueClaims: number; duplicatePendingObservations: number; knownExactPending: number;
      overduePending: number; orphanedPending: number; retrying: number; failedPending: number;
    };
  } | null;
}
export const getMemoryReadiness = () => apiGet<MemoryReadinessReport>('/api/console/memory/readiness');

export interface EvidenceReconciliationReport {
  backupPath: string | null;
  before: number;
  processed: number;
  available: number;
  unavailable: number;
  remaining: number;
  complete: boolean;
  elapsedMs: number;
}
export const reconcileMemoryEvidence = (maxFacts = 5_000) =>
  apiPost<EvidenceReconciliationReport>('/api/console/memory/reconcile-evidence', { maxFacts, batchSize: 200 });

export interface RelationshipReconciliationReport {
  backupPath: string | null;
  identities: { groupsScanned: number; groupsMerged: number; entitiesRedirected: number };
  factEntityLinks: { factsScanned: number; entitiesConsidered: number; linksWritten: number };
  groundedFactEntityLinks: { factsScanned: number; evidenceScanned: number; candidates: number; promoted: number; ambiguous: number; ignored: number };
  factResourceLinks: { factsScanned: number; entitiesConsidered: number; linksWritten: number };
  groundedFactResourceLinks: { factsScanned: number; evidenceScanned: number; candidates: number; promoted: number; ambiguous: number; ignored: number };
  relationships: { factsScanned: number; evidenceScanned: number; candidates: number; added: number; reinforced: number; ignored: number };
  before: Record<string, number>;
  after: Record<string, number>;
  elapsedMs: number;
}
export const reconcileMemoryRelationships = (maxFacts = 5_000) =>
  apiPost<RelationshipReconciliationReport>('/api/console/memory/reconcile-relationships', { maxFacts });

/** A learned tool-recall (procedural) memo — which tool proved out for an intent. */
export interface ToolRecallRecord {
  procedureId?: string | null;
  intent: string;
  description?: string | null;
  aliases?: Array<{ intent: string; status: 'active' | 'quarantined' | 'superseded'; source: string; firstSeenAt?: string; lastSeenAt?: string }>;
  impressionCount?: number;
  lastImpressedAt?: string | null;
  evidenceCount?: number;
  choice: { kind: string; identifier: string; testedAt?: string; successCount?: number; failureCount?: number; lastSuccessAt?: string | null; lastFailureAt?: string | null; score?: number } | null;
  fallbacks: { kind: string; identifier: string; reason?: string; failedAt?: string }[];
}
export const getToolRecall = () => apiGet<{
  count: number;
  aliasCount?: number;
  collapsedAliases?: number;
  quarantinedAliases?: number;
  records: ToolRecallRecord[];
}>('/api/console/memory/tool-recall');

export interface Entity {
  id: number | string;
  entityType: string;
  canonicalName: string;
  aliases?: string[];
  mentionCount?: number;
  factCount?: number;
  groundedFactCount?: number;
  inferredFactCount?: number;
  identifierCount?: number;
  observationCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}
export interface EntityMemoryDetail {
  entity: {
    id: number; type: string; canonicalName: string; firstSeenAt: string; lastSeenAt: string;
    legacyMentionCount: number;
    aliases: Array<{ value: string; confidence: number; sourceUri: string | null; evidenceEpisodeId: string | null; firstSeenAt: string; lastSeenAt: string }>;
    identifiers: Array<{ scheme: string; value: string; confidence: number; sourceUri: string | null; evidenceEpisodeId: string | null; firstSeenAt: string; lastSeenAt: string }>;
  };
  identity: {
    requestedId: number; canonicalId: number;
    redirectedFrom: Array<{ id: number; canonicalName: string; reason: string; confidence: number; createdAt: string }>;
  };
  claims: Array<{
    factId: number; kind: Fact['kind']; content: string; active: boolean; confidence: number;
    validFrom: string | null; validTo: string | null; supersededByFactId: number | null;
    linkType: 'stored' | 'extracted'; linkConfidence: number;
    quality: 'accepted' | 'needs_review'; reviewReason: string | null;
    evidence: Array<{ episodeId: string; excerpt: string; sourceUri?: string; occurredAt: string; status: string }>;
  }>;
  relationships: Array<{
    direction: 'outgoing' | 'incoming'; predicate: string;
    otherEntity: { id: number; type: string; canonicalName: string };
    current: boolean; confidence: number; recurrenceCount: number;
    validFrom: string | null; validTo: string | null;
    evidence: Array<{ episodeId: string; excerpt: string; sourceUri: string | null; sourceFactId: number | null; confidence: number; observedAt: string; status: string }>;
    validityIntervals: Array<{ validFrom: string; validTo: string | null; openedReason: string; closedReason: string | null }>;
  }>;
  episodes: Array<{
    id: string; kind: string; subtype: string | null; title: string | null;
    sourceApp: string | null; sourceUri: string | null; occurredAt: string; status: string;
    excerpt: string | null; confidence: number; sourceKind: string; sourceFactId: number | null;
  }>;
  stats: {
    groundedClaims: number; currentClaims: number; reviewClaims: number; relationships: number; currentRelationships: number;
    sourceEpisodes: number; aliases: number; identifiers: number; redirectedIdentities: number;
  };
  asOf: string;
}
export interface EntityIdentityConflict {
  scheme: string;
  value: string;
  entities: Array<{ id: number; type: string; name: string }>;
}
export interface EntityDuplicateCandidate {
  id: string;
  entityType: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  suggestedCanonicalId: number;
  entities: Array<{
    id: number; type: string; name: string; aliases: string[];
    identifiers: Array<{ scheme: string; value: string }>;
    groundedClaims: number; inferredLinks: number; observations: number; legacyMentions: number;
    firstSeenAt: string; lastSeenAt: string;
  }>;
  matches: Array<{
    entityIds: [number, number];
    basis: 'shared_identifier' | 'canonical_equivalent' | 'canonical_alias' | 'shared_alias' | 'person_name_variant' | 'person_nickname';
    score: number; detail: string;
  }>;
  reasons: string[];
  cautions: string[];
}
export const listEntities = (limit = 300, type = 'all', query = '') => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (type !== 'all') params.set('type', type);
  if (query.trim()) params.set('q', query.trim());
  return apiGet<{ entities: Entity[]; total: number; allTotal: number; redirectedTotal?: number }>(`/api/console/brain/entities?${params.toString()}`);
};
export const getEntityMemory = (id: Entity['id'], asOf?: string) =>
  apiGet<EntityMemoryDetail>(`/api/console/brain/entities/${encodeURIComponent(String(id))}${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`);
export const listEntityIdentityConflicts = (limit = 100) =>
  apiGet<{ conflicts: EntityIdentityConflict[]; total: number }>(`/api/console/brain/entity-identity/conflicts?limit=${limit}`);
export const listEntityDuplicateCandidates = (limit = 100, type = 'person') =>
  apiGet<{ candidates: EntityDuplicateCandidate[]; total: number; dismissedCount: number; entitiesScanned: number }>(`/api/console/brain/entity-identity/candidates?limit=${limit}&type=${encodeURIComponent(type)}`);
export const dismissEntityDuplicateCandidate = (entityIds: number[]) =>
  apiPost<{ ok: true; pairsDismissed: number }>('/api/console/brain/entity-identity/candidates/dismiss', {
    entityIds,
    reason: 'desktop identity review: distinct people',
  });
export const restoreDismissedEntityDuplicateCandidates = () =>
  apiPost<{ ok: true; restored: number }>('/api/console/brain/entity-identity/candidates/restore-dismissed');
export const mergeEntityIdentity = (sourceEntityId: number, canonicalEntityId: number) =>
  apiPost<{ ok: true; canonicalEntityId: number }>('/api/console/brain/entities/merge', {
    sourceEntityId,
    canonicalEntityId,
    reason: 'desktop identity review',
  });

export interface SourcePointer { id: number | string; app: string; kind?: string; ref?: string; name?: string; whatsHere?: string }
export const getSourceMap = () => apiGet<{ enabled?: boolean; count?: number; pointers?: SourcePointer[] }>('/api/console/memory/source-map');

export interface GraphNode { id: string; label: string; type: string; data?: Record<string, unknown> }
export interface GraphEdge { id: string; source: string; target: string; type: string; weight?: number; inferred?: boolean; label?: string; truth: 'stored' | 'inferred' | 'semantic'; data?: Record<string, unknown> }
export interface GraphMeta {
  factCount?: number; totalFacts?: number; fileCount?: number; kindCount?: number; entityCount?: number; edgeCount?: number;
  semantic?: boolean;
  graphFull?: boolean;
  stores?: { toolRecall?: number; skills?: number; workflows?: number; goals?: number; focus?: number };
  semanticEdges?: { enabled: boolean; requested: number; threshold: number; cap: number; count: number; embeddedFacts: number; skippedNoEmbedding: number };
  clustering?: { mode: string; clusters: number };
  truthMode?: 'stored' | 'augmented';
  coverage?: {
    totals?: Record<string, number>;
    visible?: Record<string, number>;
    edges?: { stored: number; inferred: number; semantic: number };
    edgeTypeTotals?: Record<string, number>;
    visibleEdgeTypes?: Record<string, number>;
  };
}
export interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[]; meta?: GraphMeta }
export interface GraphParams {
  layout?: 'semantic';
  simEdges?: number; simThreshold?: number; simCap?: number;
  facts?: number; files?: number; entities?: number;
  truth?: 'stored' | 'augmented';
}
/**
 * Fetch the memory graph. Called with no args → the bare URL (byte-compatible
 * with the legacy 2D view). Pass params to request 3D semantic layout +
 * fact↔fact similarity edges, e.g. getGraph({ layout: 'semantic', simEdges: 3 }).
 */
export const getGraph = (params?: GraphParams) => {
  const qs = new URLSearchParams();
  if (params?.layout) qs.set('layout', params.layout);
  if (params?.simEdges != null) qs.set('simEdges', String(params.simEdges));
  if (params?.simThreshold != null) qs.set('simThreshold', String(params.simThreshold));
  if (params?.simCap != null) qs.set('simCap', String(params.simCap));
  if (params?.facts != null) qs.set('facts', String(params.facts));
  if (params?.files != null) qs.set('files', String(params.files));
  if (params?.entities != null) qs.set('entities', String(params.entities));
  if (params?.truth) qs.set('truth', params.truth);
  const q = qs.toString();
  return apiGet<GraphResponse>(`/api/console/memory/graph${q ? `?${q}` : ''}`);
};
export const getGraphNeighborhood = (nodeId: string, depth: 1 | 2 = 1) =>
  apiGet<GraphResponse>(`/api/console/memory/neighborhood?nodeId=${encodeURIComponent(nodeId)}&depth=${depth}`);

// ─── Memory import (other agents' memory stores → Clementine facts) ─────────
export interface ImportSource { path: string; label: string; fileCount: number }
export interface ImportFile { path: string; bytes: number; mtime: string; shape: 'structured_md' | 'freeform'; preview: string }
export interface ImportScan { root: string; files: ImportFile[]; skipped: Array<{ path: string; reason: string }> }
export interface ImportBatch {
  id: string; root: string; sourceLabel: string; startedAt: string; finishedAt: string;
  fileCount: number; newFactIds: number[]; dedupedCount: number;
  distilledFiles: number; deterministicFiles: number; fallbackFiles: number;
  errors: Array<{ path: string; error: string }>;
}
export const discoverImportSources = () => apiGet<{ sources: ImportSource[] }>('/api/console/memory/import/discover');
export const scanImportPath = (path: string) => apiGet<ImportScan>(`/api/console/memory/import/scan?path=${encodeURIComponent(path)}`);
export const runMemoryImport = (input: { path: string; files?: string[]; sourceLabel?: string; distill?: boolean }) =>
  apiPost<{ batch: ImportBatch }>('/api/console/memory/import/run', input);
export const listImportBatches = () => apiGet<{ batches: ImportBatch[] }>('/api/console/memory/import/batches');
export const undoImportBatch = (id: string) => apiPost<{ deleted: number }>(`/api/console/memory/import/batches/${encodeURIComponent(id)}/undo`);
