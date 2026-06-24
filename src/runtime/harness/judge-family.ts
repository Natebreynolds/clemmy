/**
 * Cross-family JUDGE primitives — the leaf home for "the judge should be a
 * different LLM family than the brain whenever possible" (never self-grade).
 *
 * Extracted from debate-model.ts so BOTH debate-model (the model-building judge
 * paths) and model-roles (the judge-role DEFAULT) can share one canonical copy
 * WITHOUT a circular import and WITHOUT pulling debate-model's heavy provider /
 * agents-SDK graph into model-roles. This module depends only on config + the
 * OAuth token stores + a type — it builds no models itself.
 *
 * The decision is split from the model BUILD on purpose: `chooseBoundaryJudgeFamily`
 * is a pure function (deterministically testable); debate-model owns the
 * provider-heavy `buildJudgeForRole` / `resolveBoundaryJudge` that turn the
 * decision into a live Model.
 */
import { getRuntimeEnv } from '../../config.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import type { ModelProviderClass } from './model-wire-registry.js';

/** Subscription OAuth access tokens start with this prefix; an api03 API key is
 *  never treated as "available" (preserves the billing guard). */
const CLAUDE_OAT_PREFIX = 'sk-ant-oat01';

/** Is the Claude (Anthropic) subscription brain logged in + usable right now? */
export function claudeAvailable(): boolean {
  try {
    const t = getStoredClaudeTokens();
    if (!t?.accessToken?.startsWith(CLAUDE_OAT_PREFIX)) return false;
    if (t.refreshToken) return true; // refreshable → the request path will renew it
    return !t.expiresAt || t.expiresAt > Date.now() + 60_000; // non-refreshable → must be unexpired
  } catch {
    return false;
  }
}

/** Is the Codex (OpenAI) OAuth brain logged in? */
export function codexAvailable(): boolean {
  try {
    return Boolean(getStoredCodexOAuthTokens()?.accessToken);
  } catch {
    return false;
  }
}

/** Diagnostic: which flagships are logged in. Debate needs BOTH. */
export function debateBrainsAvailable(): { claude: boolean; codex: boolean } {
  return { claude: claudeAvailable(), codex: codexAvailable() };
}

/** off ⇒ boundary judges keep MODELS.fast exactly as before (byte-identical). */
export function judgeCrossFamilyEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_JUDGE_CROSS_FAMILY', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** The cheap Claude id for a cross-family boundary judge — the lightest pass,
 *  since these run on most action turns. Tunable; defaults to Haiku. */
export function boundaryClaudeJudgeModel(): string {
  return (getRuntimeEnv('CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL', '') || '').trim() || 'claude-haiku-4-5';
}

/** The cheap Codex (gpt) id for a cross-family boundary judge. A code-level
 *  family DEFAULT, NOT MODELS.fast — the "fast" tier can be env-overridden to a
 *  BYO/GLM model (e.g. glm-5.2), which would mis-route a "codex" judge onto the
 *  wrong provider. Tunable; defaults to the canonical cheap gpt id. */
export function boundaryCodexJudgeModel(): string {
  return (getRuntimeEnv('CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL', '') || '').trim() || 'gpt-5.4-mini';
}

/** PURE family decision: the cheapest model+provider from a family DIFFERENT than
 *  the brain, or null when none is available (caller fails open same-family).
 *  Separated from the provider-heavy build so it is deterministically testable. */
export function chooseBoundaryJudgeFamily(
  brainFamily: ModelProviderClass,
  haveClaude: boolean,
  haveCodex: boolean,
): { provider: ModelProviderClass; modelId: string } | null {
  if (brainFamily !== 'claude' && haveClaude) return { provider: 'claude', modelId: boundaryClaudeJudgeModel() };
  if (brainFamily !== 'codex' && haveCodex) return { provider: 'codex', modelId: boundaryCodexJudgeModel() };
  return null;
}
