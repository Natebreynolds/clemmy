/**
 * The one door that changes the active brain. Settings (desktop and phone)
 * and the owner's answer on a brain-outage card both come through here, so a
 * switch validates, persists and resets caches the same way wherever it
 * started.
 */
import { recordBrainChosenForSession } from '../agents/session-agent-model.js';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';
import { getActiveAuthMode, getByoBackendConfig, getModelRoutingMode, getRuntimeEnv, DEFAULT_CODEX_MODEL } from '../config.js';
import { getStoredCodexOAuthTokens } from '../runtime/auth-store.js';
import { getClaudeAuthSnapshot, loadFreshClaudeAccessToken, ClaudeAuthError } from '../runtime/claude-oauth.js';
import { BrainSelectionError, CODEX_BRAIN_SLOTS, codexBrainSlotUpdates, brainSelectionReceipt, type CodexBrainSlot } from '../runtime/harness/brain-selection.js';
import { resetByoModelCache } from '../runtime/harness/byo-model.js';
import { resetClaudeModelCache } from '../runtime/harness/claude-model.js';
import { resetHarnessRuntimeConfig } from '../runtime/harness/codex-client.js';
import { brainOptions, effectiveBrainValue } from '../runtime/harness/model-role-options.js';
import { pinSessionBrain, resolveRoleModel } from '../runtime/harness/model-roles.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { removeEnvKey, updateEnvKey } from '../tools/shared.js';

export type ActiveBrainClass = 'codex_oauth' | 'claude_oauth' | 'api_key';

export type ActiveBrainSwitchResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

export function activeBrainClass(raw: unknown): ActiveBrainClass | null {
  return raw === 'claude_oauth' || raw === 'codex_oauth' || raw === 'api_key' ? raw : null;
}

/** The brain class that serves a connected model id, or null. */
export function activeBrainClassForModel(modelId: string): ActiveBrainClass | null {
  const option = brainOptions().find((o) => o.available && o.modelId === modelId);
  return option ? option.id : null;
}

export async function switchActiveBrain(input: {
  brain: ActiveBrainClass;
  /** Which specific model orchestrates (empty keeps the class default). */
  modelId?: string;
  /** The conversation the switch was made from, re-pinned to the new brain. */
  sessionId?: string;
}): Promise<ActiveBrainSwitchResult> {
  const brain = input.brain;
  const brainModelId = (input.modelId ?? '').trim();
  const switchSessionId = (input.sessionId ?? '').trim();
  try {
    // Validate the selected model before moving any routing state.
    const codexUpdates = brain === 'codex_oauth' ? codexBrainSlotUpdates(brainModelId,
      Object.fromEntries(CODEX_BRAIN_SLOTS.map((key) => [key, (getRuntimeEnv(key, '') || '').trim()])) as Record<CodexBrainSlot, string>,
      resolveProvider, DEFAULT_CODEX_MODEL) : [];

    // Only a connected model can be the brain: Codex needs its sign-in, checked
    // before any routing state moves, as Claude's is below.
    if (brain === 'codex_oauth') {
      let codexSignedIn = false;
      try { codexSignedIn = Boolean(getStoredCodexOAuthTokens()?.accessToken); } catch { codexSignedIn = false; }
      if (!codexSignedIn) {
        return { ok: false, status: 409, body: { error: 'Codex is not signed in. Sign in with ChatGPT under Settings → Models first.', needsLogin: true } };
      }
    }

    // A BYO brain runs all-in (every role on the BYO backend unless a role is
    // bound elsewhere); a Codex/Claude brain cannot coexist with all-in, so step
    // it down to 'off' (BYO providers stay connected and routable via role pins).
    if (brain === 'api_key') {
      if (!getByoBackendConfig().configured) {
        return { ok: false, status: 409, body: { error: 'No BYO model is configured. Add one under Settings → Models → Connected models first.', needsLogin: true } };
      }
      // Pin the chosen model as the brain. Validate it against the eligible set
      // (every connected, configured BYO model) so a stale/unknown id can't be
      // written. Empty modelId → clear the override (default slot is the brain).
      if (brainModelId) {
        const eligible = brainOptions().some((o) => o.id === 'api_key' && o.modelId === brainModelId);
        if (!eligible) {
          return { ok: false, status: 400, body: { error: `Model "${brainModelId}" is not a connected BYO model. Add it to a provider in Settings → Models first.` } };
        }
        updateEnvKey('BYO_BRAIN_MODEL_ID', brainModelId);
      } else {
        removeEnvKey('BYO_BRAIN_MODEL_ID');
      }
      // Keep the legacy worker slot aligned with the all-in BYO backend,
      // matching the older model-backend route. Durable worker bindings stay
      // untouched: an active BYO binding still wins, while an inactive
      // subscription-family binding continues to be reported as inactive.
      // Without this sync, switching brains through the newer picker could
      // leave gpt-* here and spend a whole failed fan-out wave probing a
      // single-family BYO endpoint before the runtime self-healed.
      updateEnvKey('OPENAI_MODEL_WORKER', getByoBackendConfig().primaryId);
      updateEnvKey('MODEL_ROUTING_MODE', 'all_in');
    } else {
      // Switching to a Codex/Claude brain: drop the BYO brain-model override so a
      // later switch back to a BYO brain doesn't silently reuse a stale model.
      removeEnvKey('BYO_BRAIN_MODEL_ID');
      if (getModelRoutingMode() === 'all_in') updateEnvKey('MODEL_ROUTING_MODE', 'off');
      if (brain === 'codex_oauth') {
        for (const { key, value: next } of codexUpdates) updateEnvKey(key, next);
      }
    }

    if (brain === 'claude_oauth') {
      // A Claude brain orchestrates with a specific Claude model. Honor an
      // explicit pick (value `claude_oauth:<id>` → brainModelId) by persisting
      // CLAUDE_MODEL, which getClaudeBrainModel() reads. Validate it's a real
      // Claude model so a stale/unknown id can't be written; an empty/non-Claude
      // id leaves the current CLAUDE_MODEL untouched.
      if (brainModelId && resolveProvider(brainModelId) === 'claude') {
        const eligible = brainOptions().some((o) => o.id === 'claude_oauth' && o.modelId === brainModelId);
        if (!eligible) {
          return { ok: false, status: 400, body: { error: `Model "${brainModelId}" is not a connected Claude model.` } };
        }
        updateEnvKey('CLAUDE_MODEL', brainModelId);
      }
      // Preflight BEFORE persisting; refresh a near-expiry vault token so the
      // harness' own sync check at configure-time also passes next turn.
      try {
        await loadFreshClaudeAccessToken();
      } catch (err) {
        const kind = err instanceof ClaudeAuthError ? err.kind : 'missing';
        return { ok: false, status: 409, body: {
          error: err instanceof Error ? err.message : 'Claude subscription auth is not ready.',
          kind,
          needsLogin: true,
        } };
      }
    }

    updateEnvKey('AUTH_MODE', brain);

    // Force the next harness turn to re-register the chosen provider, and drop
    // brain-specific caches so a Codex→Claude→Codex round-trip leaves no stale
    // provider/client behind.
    resetHarnessRuntimeConfig();
    resetClaudeModelCache();
    resetByoModelCache();
    clearAutonomyAgentCache();

    // Re-pin the conversation the switch was made from (after the env writes
    // + cache resets above, so the pin stamps the NEW global resolution). No
    // sessionId ⇒ no pin is touched: other live conversations keep theirs.
    let sessionPin = null;
    if (switchSessionId) {
      sessionPin = pinSessionBrain(switchSessionId);
      // The owner chose this conversation's model: it now answers over an
      // agent's pinned model (session-agent-model.ts).
      recordBrainChosenForSession(switchSessionId);
    }

    const resolvedBrain = resolveRoleModel('brain');
    const effectiveValue = effectiveBrainValue();
    const selection = brainSelectionReceipt({
      requestedValue: brainModelId ? `${brain}:${brainModelId}` : brain,
      effectiveValue, brain: resolvedBrain,
      ...(switchSessionId ? { sessionId: switchSessionId, sessionPin } : {}),
    });
    return { ok: true, body: { ok: true, activeBrain: getActiveAuthMode(), claudeAuth: getClaudeAuthSnapshot(),
      brain: resolvedBrain, effectiveValue, selection } };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof BrainSelectionError ? err.status : 500,
      body: {
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof BrainSelectionError ? { code: err.code } : {}),
      },
    };
  }
}
