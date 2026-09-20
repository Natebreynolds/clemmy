import { modelsComparable, normalizeModel, primaryModel } from './models.js';
import type { ModelSlice } from './types.js';
import { clementineBrainMatches, isClementineChatKind } from './parse-clementine.js';
import type {
  CanonicalCall, Lane, LaneTotals, Pairing, Trial, Verdict,
} from './types.js';

const WARM_HIT = 0.5;
const SPARK_MAX = 48;

export function emptyLane(): LaneTotals {
  return {
    uncachedWork: 0, promptTokens: 0, cachedRead: 0, cacheWrite: 0, outputTokens: 0,
    calls: 0, subagentCalls: 0, hitRate: 0, models: [], byModel: [],
    warmStart: false, promptComponents: {}, sparkline: [],
  };
}

export function createTrial(input: {
  name: string;
  pairing: Pairing;
  nativeSource: Trial['nativeSource'];
  promptNote?: string;
  now?: Date;
}): Trial {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: `trial-${now.replace(/[:.]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || 'untitled task',
    pairing: input.pairing,
    nativeSource: input.nativeSource,
    promptNote: input.promptNote,
    createdAt: now,
  };
}

export function armTrial(trial: Trial, at = new Date().toISOString()): Trial {
  return {
    ...trial,
    armedAt: at,
    nativeSessionId: undefined,
    clementineSessionId: undefined,
    nativeSealedAt: undefined,
    clementineSealedAt: undefined,
  };
}

export function bindLane(trial: Trial, lane: Lane, sessionId: string): Trial {
  if (lane === 'native') return { ...trial, nativeSessionId: sessionId };
  return { ...trial, clementineSessionId: sessionId };
}

export function sealLane(trial: Trial, lane: Lane, at = new Date().toISOString()): Trial {
  if (lane === 'native') return { ...trial, nativeSealedAt: at };
  return { ...trial, clementineSealedAt: at };
}

export function acceptCall(trial: Trial, call: CanonicalCall): boolean {
  if (!trial.armedAt) return false;
  if (call.at < trial.armedAt) return false;
  if (call.lane === 'native') {
    if (!trial.nativeSessionId) return false;
    if (call.rootSessionId !== trial.nativeSessionId && call.sessionId !== trial.nativeSessionId) {
      return false;
    }
    if (trial.nativeSealedAt && call.at > trial.nativeSealedAt) return false;
    if (call.source !== trial.nativeSource) return false;
    return true;
  }
  if (!trial.clementineSessionId) return false;
  if (call.rootSessionId !== trial.clementineSessionId && call.sessionId !== trial.clementineSessionId) {
    return false;
  }
  if (trial.clementineSealedAt && call.at > trial.clementineSealedAt) return false;
  if (!isClementineChatKind(call.kind)) return false;
  if (!clementineBrainMatches(trial.pairing, call.brain)) return false;
  return true;
}

export function dedupeCalls(calls: CanonicalCall[]): CanonicalCall[] {
  const byId = new Map<string, CanonicalCall>();
  for (const call of calls) {
    const prev = byId.get(call.id);
    if (!prev || call.at >= prev.at) byId.set(call.id, call);
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export function rollupLane(calls: CanonicalCall[]): LaneTotals {
  const unique = dedupeCalls(calls);
  let uncachedWork = 0;
  let promptTokens = 0;
  let cachedRead = 0;
  let cacheWrite = 0;
  let outputTokens = 0;
  let subagentCalls = 0;
  const modelMap = new Map<string, ModelSlice>();
  const components: Record<string, number> = {};
  const sparkline: number[] = [];
  for (const call of unique) {
    uncachedWork += call.uncachedWorkTokens;
    promptTokens += call.promptTokens;
    cachedRead += call.cachedReadTokens;
    cacheWrite += call.cacheWriteTokens;
    outputTokens += call.outputTokens;
    if (call.isSubagent) subagentCalls += 1;
    sparkline.push(call.uncachedWorkTokens);
    const modelKey = normalizeModel(call.model) || 'unknown';
    const slice = modelMap.get(modelKey) ?? {
      model: call.model || 'unknown',
      uncachedWork: 0, promptTokens: 0, cachedRead: 0, outputTokens: 0, calls: 0, subagentCalls: 0,
    };
    if (call.model && slice.model === 'unknown') slice.model = call.model;
    slice.uncachedWork += call.uncachedWorkTokens;
    slice.promptTokens += call.promptTokens;
    slice.cachedRead += call.cachedReadTokens;
    slice.outputTokens += call.outputTokens;
    slice.calls += 1;
    if (call.isSubagent) slice.subagentCalls += 1;
    modelMap.set(modelKey, slice);
    if (call.promptComponents) {
      for (const [name, value] of Object.entries(call.promptComponents)) {
        if (Number.isFinite(value) && value > 0) components[name] = (components[name] ?? 0) + value;
      }
    }
  }
  const byModel = [...modelMap.values()].sort((a, b) => b.uncachedWork - a.uncachedWork);
  const first = unique[0];
  const last = unique[unique.length - 1];
  return {
    uncachedWork,
    promptTokens,
    cachedRead,
    cacheWrite,
    outputTokens,
    calls: unique.length,
    subagentCalls,
    hitRate: promptTokens > 0 ? cachedRead / promptTokens : 0,
    firstAt: first?.at,
    lastAt: last?.at,
    models: byModel.map((m) => m.model),
    byModel,
    warmStart: first ? first.hitRate >= WARM_HIT : false,
    promptComponents: components,
    sparkline: sparkline.slice(-SPARK_MAX),
  };
}

export function nativeLabel(trial: Trial): string {
  if (trial.nativeSource === 'claude-code') return 'Claude Code';
  if (trial.nativeSource === 'cowork') return 'Cowork';
  return 'Codex';
}

export function verdictFor(trial: Trial, native: LaneTotals, clementine: LaneTotals): Verdict {
  const nativeModel = primaryModel(native.models);
  const clementineModel = primaryModel(clementine.models);
  const bothSealed = Boolean(trial.nativeSealedAt && trial.clementineSealedAt);
  if (!bothSealed) {
    return {
      kind: 'unsealed',
      ratio: null,
      sentence: 'Seal both lanes to freeze the comparison.',
      nativeModel,
      clementineModel,
      modelsMatch: modelsComparable(nativeModel ?? undefined, clementineModel ?? undefined),
    };
  }
  if (native.calls === 0 || clementine.calls === 0) {
    return {
      kind: 'incomparable',
      ratio: null,
      sentence: native.calls === 0
        ? `${nativeLabel(trial)} has no calls in the bound session.`
        : 'Clementine has no chat calls in the bound session.',
      nativeModel,
      clementineModel,
      modelsMatch: false,
    };
  }
  const match = modelsComparable(nativeModel ?? undefined, clementineModel ?? undefined);
  if (!match) {
    return {
      kind: 'incomparable',
      ratio: null,
      sentence: `Models differ (${nativeModel ?? 'unknown'} vs ${clementineModel ?? 'unknown'}), so this is not an efficiency proof.`,
      nativeModel,
      clementineModel,
      modelsMatch: false,
    };
  }
  const ratio = native.uncachedWork > 0 ? clementine.uncachedWork / native.uncachedWork : null;
  const pct = ratio === null ? null : Math.round(ratio * 100);
  if (ratio === null) {
    return {
      kind: 'incomparable',
      ratio: null,
      sentence: `${nativeLabel(trial)} recorded no uncached work.`,
      nativeModel,
      clementineModel,
      modelsMatch: true,
    };
  }
  if (pct === 100) {
    return {
      kind: 'tie',
      ratio,
      sentence: `Clementine used the same uncached work as ${nativeLabel(trial)} on this task (same model ${clementineModel}).`,
      nativeModel,
      clementineModel,
      modelsMatch: true,
    };
  }
  if (ratio < 1) {
    return {
      kind: 'clem-less',
      ratio,
      sentence: `Clementine used ${pct}% of ${nativeLabel(trial)} uncached work on this task (same model ${clementineModel}).`,
      nativeModel,
      clementineModel,
      modelsMatch: true,
    };
  }
  return {
    kind: 'clem-more',
    ratio,
    sentence: `Clementine used ${pct}% of ${nativeLabel(trial)} uncached work on this task (same model ${clementineModel}).`,
    nativeModel,
    clementineModel,
    modelsMatch: true,
  };
}
