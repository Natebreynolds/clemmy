/**
 * Whether a Claude sign-in should make Claude the brain.
 *
 * A home whose brain cannot run (not signed in to Codex, no OpenAI key, not
 * a BYO brain) would leave Clem's own thinking on a Codex model after the
 * owner signed in to Claude, so noticing and the messages she starts herself
 * fail on every tick until a model is picked by hand. Signing in to Claude
 * there makes Claude the brain, on the Claude model already chosen, else the
 * standard tier: a premium model is never chosen for the owner. A working
 * Codex, OpenAI-key or BYO brain is never moved; the owner's own choice in
 * Settings stays theirs.
 */
import { DEFAULT_CLAUDE_ADOPTED_BRAIN_MODEL } from '../../config.js';

export const CLAUDE_ADOPTED_BRAIN_MODEL = DEFAULT_CLAUDE_ADOPTED_BRAIN_MODEL;

export function claudeBrainAdoptionAfterSignIn(state: {
  authMode: 'api_key' | 'codex_oauth' | 'claude_oauth';
  routingMode: string;
  codexSignedIn: boolean;
  openAiKey: boolean;
  claudeModel: string;
}): { claudeModel: string | null } | null {
  if (state.authMode === 'claude_oauth') return null;
  if (state.routingMode === 'all_in') return null;
  if (state.codexSignedIn) return null;
  if (state.authMode === 'api_key' && state.openAiKey) return null;
  return { claudeModel: state.claudeModel.trim() ? null : CLAUDE_ADOPTED_BRAIN_MODEL };
}
