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
  policy?: { policy_type: 'hard_constraint' | 'core_profile' | 'standing_preference'; enforcement: 'dispatch' | 'prompt'; priority: number } | null;
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
  apiGet<{ facts: Fact[] }>(`/api/console/memory/facts?${kind ? `kind=${kind}&` : ''}limit=${limit}${includeInactive ? '&includeInactive=1' : ''}`);

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

/** A core context file Clementine reads every turn (SOUL/IDENTITY/MEMORY/working). */
export interface ContextFile {
  key: string;
  title: string;
  description?: string;
  content?: string;
  bytes?: number;
  empty?: boolean;
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

export interface VaultFile { path: string; chunks: number; mtime: number; byteSize: number }
export const getMemoryFiles = () =>
  apiGet<{ files: VaultFile[]; status?: unknown }>('/api/console/memory/files');

export function fileBasename(p: string): string {
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

export const addFact = (content: string, kind: Fact['kind'] = 'user') =>
  apiPost('/api/console/context/facts', { content, kind });

export const addGoal = (title: string, description: string, priority: 'high' | 'medium' | 'low' = 'medium') =>
  apiPost('/api/console/context/goals', { title, description, priority });

export interface BrainHealth {
  activeFacts?: number; derivedFacts?: number; directFacts?: number; avgImportance?: number;
  entitiesTotal?: number; entitiesPerson?: number; entitiesCompany?: number; entitiesProject?: number; entitiesPlace?: number; entitiesThing?: number;
  pointersTotal?: number; pointersRecent?: number; reflections24h?: number;
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
    relationships?: Record<string, number>;
    shadow?: {
      samples: number; averageOverlap: number; primaryOnly: number; legacyOnly: number;
      tailHits: number; evidenceBacked: number; primaryFacts: number; evidenceRate: number;
      supported: number; lastAt: string | null; bySurface: Record<string, number>;
    };
  };
}
export const getMemoryHealth = () => apiGet<MemoryHealth>('/api/console/memory/health');

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

/** A learned tool-recall (procedural) memo — which tool proved out for an intent. */
export interface ToolRecallRecord {
  intent: string;
  description?: string | null;
  choice: { kind: string; identifier: string; testedAt?: string; successCount?: number; failureCount?: number; lastSuccessAt?: string | null; lastFailureAt?: string | null; score?: number } | null;
  fallbacks: { kind: string; identifier: string; reason?: string; failedAt?: string }[];
}
export const getToolRecall = () => apiGet<{ count: number; records: ToolRecallRecord[] }>('/api/console/memory/tool-recall');

export interface Entity { id: number | string; entityType: string; canonicalName: string; aliases?: string[]; mentionCount?: number }
export const listEntities = (limit = 400) => apiGet<{ entities: Entity[]; total: number }>(`/api/console/brain/entities?limit=${limit}`);

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
  coverage?: { totals?: Record<string, number>; visible?: Record<string, number>; edges?: { stored: number; inferred: number; semantic: number } };
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
