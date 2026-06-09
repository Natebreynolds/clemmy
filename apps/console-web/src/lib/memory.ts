import { apiGet, apiPost } from './api';

export interface Fact {
  id: number | string;
  kind: 'user' | 'project' | 'feedback' | 'reference';
  content: string;
  importance?: number | null;
  updatedAt?: string;
  pinned?: boolean;
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
];

export const listFacts = (kind?: Fact['kind'], limit = 80) =>
  apiGet<{ facts: Fact[] }>(`/api/console/memory/facts?${kind ? `kind=${kind}&` : ''}limit=${limit}`);

export const forgetFact = (id: Fact['id']) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/forget`);

export const pinFact = (id: Fact['id'], pinned = true) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/pin`, { pinned });

/** Reverse a soft-delete (forget / auto-clean / approved retire/merge). The
 *  undo half of every reversible memory action — 30-day window. */
export const restoreFact = (id: Fact['id']) =>
  apiPost(`/api/console/memory/facts/${encodeURIComponent(String(id))}/restore`);

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

export interface MemoryHit { filePath: string; title: string; snippet: string; score: number }
export const searchMemory = (q: string) =>
  apiGet<{ query: string; hits: MemoryHit[] }>(`/api/console/memory/search?q=${encodeURIComponent(q)}`);

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

export interface Entity { id: number | string; entityType: string; canonicalName: string; aliases?: string[]; mentionCount?: number }
export const listEntities = (limit = 400) => apiGet<{ entities: Entity[]; total: number }>(`/api/console/brain/entities?limit=${limit}`);

export interface SourcePointer { id: number | string; app: string; kind?: string; ref?: string; name?: string; whatsHere?: string }
export const getSourceMap = () => apiGet<{ enabled?: boolean; count?: number; pointers?: SourcePointer[] }>('/api/console/memory/source-map');

export interface GraphNode { id: string; label: string; type: string; data?: Record<string, unknown> }
export interface GraphEdge { id: string; source: string; target: string; type: string; weight?: number }
export interface GraphMeta {
  factCount?: number; fileCount?: number; kindCount?: number; entityCount?: number; edgeCount?: number;
  semantic?: boolean;
  semanticEdges?: { enabled: boolean; requested: number; threshold: number; cap: number; count: number; embeddedFacts: number; skippedNoEmbedding: number };
  clustering?: { mode: string; clusters: number };
}
export interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[]; meta?: GraphMeta }
export interface GraphParams {
  layout?: 'semantic';
  simEdges?: number; simThreshold?: number; simCap?: number;
  facts?: number; files?: number; entities?: number;
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
  const q = qs.toString();
  return apiGet<GraphResponse>(`/api/console/memory/graph${q ? `?${q}` : ''}`);
};
