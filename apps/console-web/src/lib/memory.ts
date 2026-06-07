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
export interface GraphEdge { id: string; source: string; target: string; type: string }
export const getGraph = () => apiGet<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/console/memory/graph');
