import { getRuntimeEnv } from '../../config.js';

export type JudgeFallbackSetting =
  | { mode: 'automatic' | 'off' }
  | { mode: 'model'; modelId: string };

export const JUDGE_FALLBACK_ENV = 'CLEMMY_JUDGE_FALLBACK';

/** A separate policy leaves the primary judge and other role bindings alone. */
export function parseJudgeFallbackSetting(value: unknown): JudgeFallbackSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'mode' && key !== 'modelId')) return null;
  if (input.mode === 'automatic' || input.mode === 'off') {
    return input.modelId === undefined ? { mode: input.mode } : null;
  }
  if (input.mode !== 'model' || typeof input.modelId !== 'string') return null;
  const modelId = input.modelId.trim();
  return modelId && modelId.length <= 1_024 && /^[A-Za-z0-9._:/-]+$/.test(modelId)
    ? { mode: 'model', modelId }
    : null;
}

/** Legacy installations keep their existing chain setting. A choice saved in
 * Settings takes precedence; damaged saved data must not enable surprise work.
 * Kept independent of model catalogs so the judge-family leaf can read it. */
export function readJudgeFallbackSetting(): JudgeFallbackSetting {
  const raw = getRuntimeEnv(JUDGE_FALLBACK_ENV, '').trim();
  if (raw) {
    try { return parseJudgeFallbackSetting(JSON.parse(raw)) ?? { mode: 'off' }; }
    catch { return { mode: 'off' }; }
  }
  return { mode: getRuntimeEnv('CLEMMY_JUDGE_CHAIN', 'on').trim().toLowerCase() === 'off' ? 'off' : 'automatic' };
}
