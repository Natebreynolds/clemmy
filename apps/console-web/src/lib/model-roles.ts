/**
 * The ONE model-picking model, shared by Settings › Models and the chat's
 * model chip. Who thinks (brain), who does the legwork (workers), who checks
 * (judge) — read from the settings snapshot, written through the same two
 * doors mobile and Settings already use. A brain switch with a sessionId also
 * re-pins THAT conversation; worker and judge are global today (the daemon has
 * no per-session scope for them), and the UI says so rather than pretending.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePoll } from './poll';
import {
  getSettings,
  patchModelRole,
  setActiveBrain,
  type ActiveBrain,
  type ModelRolesSnapshot,
  type SettingsSnapshot,
} from './settings';

export interface ModelChoice { id: string; label: string; provider: string }
export interface BrainChoice { value: string; label: string; available: boolean; provider: string; note?: string }

export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', byo: 'API key', xai: 'xAI', openai: 'OpenAI',
};

/** Provider of a brain option value (`claude_oauth:…` → claude). */
export function brainProvider(value: string): string {
  if (value.startsWith('claude_oauth')) return 'claude';
  if (value.startsWith('codex_oauth')) return 'codex';
  return 'byo';
}

/** Split a brain option value into the door's arguments. */
export function brainCall(value: string): { brain: ActiveBrain; modelId?: string } {
  for (const prefix of ['api_key', 'codex_oauth', 'claude_oauth'] as const) {
    if (value.startsWith(`${prefix}:`)) return { brain: prefix, modelId: value.slice(prefix.length + 1) };
  }
  return { brain: value as ActiveBrain };
}

/** The brain roster with an honest note per row. */
export function brainChoices(mr: ModelRolesSnapshot, claudeAuth?: SettingsSnapshot['claudeAuth']): BrainChoice[] {
  const rows = mr.brainOptions ?? [];
  return rows.map((o) => {
    const provider = brainProvider(o.value);
    let note: string | undefined;
    if (!o.available) note = provider === 'claude' && /expired/i.test(claudeAuth?.reason ?? '') ? 'sign-in expired' : 'not connected';
    else if (provider === 'claude' && claudeAuth?.degraded) note = 'via Claude Code';
    return { value: o.value, label: o.label, available: o.available, provider, ...(note ? { note } : {}) };
  });
}

export function currentBrainValue(mr: ModelRolesSnapshot): string {
  return mr.effectiveBrainValue ?? mr.effectiveBrain ?? (mr.activeBrain === 'claude_oauth' ? 'claude_oauth' : 'codex_oauth');
}

export function flatChoices(groups: ModelRolesSnapshot['available'] | undefined): ModelChoice[] {
  return (groups ?? []).flatMap((p) => p.models.map((m) => ({ id: m.id, label: m.label, provider: p.provider })));
}

/** Short human label for a resolved role: the option label when known, else the id. */
export function roleLabel(mr: ModelRolesSnapshot, role: 'brain' | 'worker' | 'judge'): string {
  if (role === 'brain') {
    const v = currentBrainValue(mr);
    return (mr.brainOptions ?? []).find((o) => o.value === v)?.label ?? mr.roles.brain.modelId;
  }
  const r = mr.roles[role];
  const flat = flatChoices(role === 'worker' ? (mr.roleOptions?.worker ?? mr.available) : (mr.roleOptions?.judge ?? mr.available));
  return flat.find((m) => m.id === r.modelId)?.label ?? r.modelId;
}

export function useModelRoles(opts: { sessionId?: string } = {}) {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const mr = settings.data?.modelRoles;
  const claudeAuth = settings.data?.claudeAuth;
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claudeSignInFor, setClaudeSignInFor] = useState<string | null>(null);

  useEffect(() => {
    if (!mr?.discovery?.refreshing) return;
    const timer = window.setInterval(() => { void qc.invalidateQueries({ queryKey: ['settings'] }); }, 1_000);
    return () => window.clearInterval(timer);
  }, [qc, mr?.discovery?.refreshing]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['settings'] }); };
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null); setSaved(null);
    try { await fn(); setSaved(key); refresh(); }
    catch (err) {
      const e = err as { status?: number; body?: { needsLogin?: boolean; error?: string }; message?: string };
      setError(e?.body?.needsLogin || e?.status === 409
        ? (e?.body?.error && /expired/i.test(e.body.error)
            ? 'Your Claude sign-in has expired. Sign in again and the switch to Claude completes on its own.'
            : 'Switching to Claude needs a Claude (Max/Pro) sign-in first. Sign in and the switch completes on its own.')
        : (e?.message ?? String(err)));
    } finally { setBusy(null); }
  };

  const onBrain = (value: string) => run('brain', async () => {
    const wantsClaude = brainProvider(value) === 'claude';
    try {
      const call = brainCall(value);
      await setActiveBrain(call.brain, call.modelId, opts.sessionId);
      setClaudeSignInFor(null);
    } catch (err) {
      const e = err as { status?: number; body?: { needsLogin?: boolean } };
      if (wantsClaude && (e?.body?.needsLogin || e?.status === 409)) setClaudeSignInFor(value);
      throw err;
    }
  });
  useEffect(() => {
    if (claudeSignInFor && claudeAuth?.configured && !claudeAuth.degraded) {
      const value = claudeSignInFor;
      setClaudeSignInFor(null);
      void onBrain(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeAuth?.configured, claudeAuth?.degraded]);
  const onRole = (role: 'worker' | 'judge', v: string) =>
    run(role, () => patchModelRole(v === '__default__' ? { role, clear: true } : { role, modelId: v }));

  return {
    settings: settings.data,
    loading: settings.isLoading,
    mr,
    claudeAuth,
    busy, saved, error, claudeSignInFor,
    run, refresh, onBrain, onRole,
    brainValue: mr ? currentBrainValue(mr) : '',
    brains: mr ? brainChoices(mr, claudeAuth) : [],
    workers: mr ? flatChoices(mr.roleOptions?.worker ?? mr.available) : [],
    judges: mr ? flatChoices(mr.roleOptions?.judge ?? mr.available) : [],
  };
}

/** "Claude — Opus 4.8 (flagship)" → "Opus 4.8": the chip has 150px, the provider is the dot. */
export function shortModelLabel(label: string): string {
  return label.replace(/^[^—–-]+[—–-]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim() || label;
}
