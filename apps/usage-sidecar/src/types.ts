export type Pairing = 'claude' | 'codex';
export type NativeSource = 'claude-code' | 'cowork' | 'codex';
export type Lane = 'native' | 'clementine';
export type CacheDialect = 'inclusive' | 'exclusive' | 'none' | 'unknown';

export interface CanonicalCall {
  id: string;
  at: string;
  lane: Lane;
  source: NativeSource | 'clementine';
  sessionId: string;
  rootSessionId: string;
  model: string;
  kind?: string;
  brain?: string;
  entrypoint?: string;
  promptSource?: string;
  cwd?: string;
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  promptTokens: number;
  uncachedWorkTokens: number;
  hitRate: number;
  certified: boolean;
  promptComponents?: Record<string, number>;
}

export interface SessionCandidate {
  id: string;
  source: NativeSource | 'clementine';
  startedAt: string;
  model?: string;
  title?: string;
  cwd?: string;
  brain?: string;
  path: string;
}

export interface LaneTotals {
  uncachedWork: number;
  promptTokens: number;
  cachedRead: number;
  cacheWrite: number;
  outputTokens: number;
  calls: number;
  hitRate: number;
  firstAt?: string;
  lastAt?: string;
  models: string[];
  warmStart: boolean;
  promptComponents: Record<string, number>;
  sparkline: number[];
}

export type VerdictKind = 'clem-less' | 'clem-more' | 'tie' | 'incomparable' | 'unsealed';

export interface Verdict {
  kind: VerdictKind;
  ratio: number | null;
  sentence: string;
  nativeModel: string | null;
  clementineModel: string | null;
  modelsMatch: boolean;
}

export interface Trial {
  id: string;
  name: string;
  pairing: Pairing;
  nativeSource: NativeSource;
  promptNote?: string;
  createdAt: string;
  armedAt?: string;
  nativeSessionId?: string;
  clementineSessionId?: string;
  nativeSealedAt?: string;
  clementineSealedAt?: string;
}

export interface TrialSnapshot {
  trial: Trial;
  native: LaneTotals;
  clementine: LaneTotals;
  verdict: Verdict;
  nativeCalls: CanonicalCall[];
  clementineCalls: CanonicalCall[];
  candidates: SessionCandidate[];
}
