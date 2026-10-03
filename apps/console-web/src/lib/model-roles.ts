/**
 * The ONE model-picking model, shared by Settings › Models and the chat's
 * model chip. Who thinks (brain), who does the legwork (workers), who checks
 * (judge) — read from the settings snapshot, written through the same two
 * doors mobile and Settings already use. A brain switch with a sessionId also
 * re-pins THAT conversation; worker and judge are global today (the daemon has
 * no per-session scope for them), and the UI says so rather than pretending.
 */
import { MEMORY_ROLE_WORDS, modelDisplayName } from '@clem/chat-engine';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePoll } from './poll';
import {
  getSettings,
  patchModelRole,
  patchJudgeFallback,
  setActiveBrain,
  type ActiveBrain,
  type ModelRolesSnapshot,
  type SettingsSnapshot,
  type JudgeFallbackSetting,
  type JudgeFallbackSelection,
} from './settings';

export interface ModelChoice { id: string; label: string; provider: string }
export interface BrainChoice { value: string; label: string; available: boolean; provider: string; note?: string }

export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', byo: 'API key', xai: 'xAI', openai: 'OpenAI',
};

/** One vocabulary for the jobs, the phone's words, on every surface: no
 *  Brain / Workers / Judge on the Mac beside Does the work / Helps in parallel
 *  / Checks the work on the phone. */
export const ROLE_WORDS = {
  brain: { title: 'Does the work', hint: 'Reads your request, plans it and uses your tools.' },
  worker: { title: 'Helps in parallel', hint: 'Side tasks that run at the same time, like looking into several companies at once.' },
  writer: { title: 'Writes the final answer', hint: 'When a request gathers a lot of material, this model writes your reply from it. Short replies come from the model that does the work.' },
  judge: { title: 'Checks the work', hint: 'Reviews finished work before Clem calls it done.' },
  fallback: { title: 'Backup checker', hint: 'Used only when the checker cannot complete a review. A completed verdict is kept.' },
  // The memory words are the shared contract's, so the phone's Models card and
  // the Memory tab say exactly this.
  memory: { title: MEMORY_ROLE_WORDS.title, hint: MEMORY_ROLE_WORDS.explain },
} as const;

const ID_SHAPED = /^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)?$/;

/** A model as a person would say it. A label that is only the provider's id
 *  ("deepseek-ai/DeepSeek-V4.1-Flash", "grok-4.6") becomes its display name;
 *  a label someone wrote stays as written. A "Provider — id" pair keeps the
 *  provider and names the id. */
export function friendlyModelLabel(label: string): string {
  const raw = (label ?? '').trim();
  if (!raw) return raw;
  const dash = raw.indexOf(' — ');
  if (dash > 0) {
    const head = raw.slice(0, dash); const tail = raw.slice(dash + 3).trim();
    return ID_SHAPED.test(tail) ? `${head} — ${modelDisplayName(tail)}` : raw;
  }
  return ID_SHAPED.test(raw) && !/\s/.test(raw) ? modelDisplayName(raw) : raw;
}

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
    return { value: o.value, label: friendlyModelLabel(o.label), available: o.available, provider, ...(note ? { note } : {}) };
  });
}

export function currentBrainValue(mr: ModelRolesSnapshot): string {
  return mr.effectiveBrainValue ?? mr.effectiveBrain ?? (mr.activeBrain === 'claude_oauth' ? 'claude_oauth' : 'codex_oauth');
}

export function flatChoices(groups: ModelRolesSnapshot['available'] | undefined): ModelChoice[] {
  return (groups ?? []).flatMap((p) => p.models.map((m) => ({ id: m.id, label: friendlyModelLabel(m.label), provider: p.provider })));
}

export function judgeFallbackValue(setting: JudgeFallbackSetting): string {
  return setting.mode === 'model' ? `model:${setting.modelId ?? ''}` : setting.mode;
}

export function judgeFallbackSelection(value: string): JudgeFallbackSelection {
  if (value === 'automatic' || value === 'off') return { mode: value };
  if (value.startsWith('model:') && value.slice(6)) return { mode: 'model', modelId: value.slice(6) };
  throw new Error('Choose a fallback judge from the list.');
}

export function judgeFallbackChoices(mr: ModelRolesSnapshot): Array<ModelChoice & { available: boolean }> {
  const setting = mr.judgeFallback;
  const rows = flatChoices(setting?.options ?? mr.roleOptions?.judge).map((model) => ({
    ...model,
    available: !(setting?.mode === 'model' && setting.modelId === model.id && setting.available === false),
  }));
  if (setting?.mode === 'model' && !rows.some((row) => row.id === (setting.modelId ?? ''))) {
    rows.push({ id: setting.modelId ?? '', label: setting.modelId || 'Saved model', provider: '', available: false });
  }
  return rows;
}

/** Short human label for a resolved role: the option label when known, else the id. */
export function roleLabel(mr: ModelRolesSnapshot, role: 'brain' | 'worker' | 'judge'): string {
  if (role === 'brain') {
    const v = currentBrainValue(mr);
    const found = (mr.brainOptions ?? []).find((o) => o.value === v)?.label;
    return found ? friendlyModelLabel(found) : modelDisplayName(mr.roles.brain.modelId);
  }
  const r = mr.roles[role];
  const flat = flatChoices(role === 'worker' ? (mr.roleOptions?.worker ?? mr.available) : (mr.roleOptions?.judge ?? mr.available));
  return flat.find((m) => m.id === r.modelId)?.label ?? modelDisplayName(r.modelId);
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
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(null); setError(null); setSaved(null); setClaudeSignInFor(null);
    return () => { generation.current += 1; };
  }, [opts.sessionId]);

  useEffect(() => {
    if (!mr?.discovery?.refreshing) return;
    const timer = window.setInterval(() => { void qc.invalidateQueries({ queryKey: ['settings'] }); }, 1_000);
    return () => window.clearInterval(timer);
  }, [qc, mr?.discovery?.refreshing]);

  // A pick in a conversation also decides whether an agent's own model still
  // answers it (the model chip reads that).
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['settings'] });
    void qc.invalidateQueries({ queryKey: ['answering-model'] });
  };
  const run = async (key: string, fn: () => Promise<unknown>) => {
    const current = ++generation.current;
    setBusy(key); setError(null); setSaved(null);
    try { await fn(); if (current === generation.current) { setSaved(key); refresh(); } }
    catch (err) {
      if (current !== generation.current) return;
      const e = err as { body?: { error?: string }; message?: string };
      setError(e?.body?.error ?? e?.message ?? String(err));
    } finally { if (current === generation.current) setBusy(null); }
  };

  const onBrain = (value: string, beforeChange?: () => Promise<unknown>) => run('brain', async () => {
    const current = generation.current;
    const wantsClaude = brainProvider(value) === 'claude';
    try {
      await beforeChange?.();
      if (current !== generation.current) return;
      const call = brainCall(value);
      await setActiveBrain(call.brain, call.modelId, opts.sessionId);
      if (current === generation.current) setClaudeSignInFor(null);
    } catch (err) {
      const e = err as { status?: number; body?: { needsLogin?: boolean } };
      if (current === generation.current && wantsClaude && e?.body?.needsLogin) setClaudeSignInFor(value);
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
  const onRole = (role: 'worker' | 'judge' | 'writer' | 'memory', v: string) =>
    run(role, async () => {
      await patchModelRole(v === '__default__' ? { role, clear: true } : { role, modelId: v });
      // The Memory tab names the memory model; let it say the new one now.
      if (role === 'memory') void qc.invalidateQueries({ queryKey: ['memory-work'] });
    });
  const onJudgeFallback = (value: string) =>
    run('judge-fallback', () => patchJudgeFallback(judgeFallbackSelection(value)));

  return {
    settings: settings.data,
    loading: settings.isLoading,
    /** A re-read of the saved settings is in flight (after a change). */
    fetching: settings.isFetching,
    mr,
    claudeAuth,
    busy, saved, error, claudeSignInFor,
    run, refresh, onBrain, onRole, onJudgeFallback,
    brainValue: mr ? currentBrainValue(mr) : '',
    brains: mr ? brainChoices(mr, claudeAuth) : [],
    workers: mr ? flatChoices(mr.roleOptions?.worker ?? mr.available) : [],
    judges: mr ? flatChoices(mr.roleOptions?.judge ?? mr.available) : [],
    writers: mr ? flatChoices(mr.roleOptions?.writer ?? mr.roleOptions?.judge ?? mr.available) : [],
    // Only the daemon's own memory catalog: a daemon without one predates the
    // role, and the row is not shown at all.
    memories: mr ? flatChoices(mr.roleOptions?.memory) : [],
  };
}

/** "Claude — Opus 4.8 (flagship)" → "Opus 4.8": the chip has 150px, the provider is the dot.
 *  What is left can still be a raw id (`namespace/model-v2`, `vendor-model-4-5`);
 *  that is named by the shared rule instead of shown raw. A vendor's own
 *  mixed-case label ("GPT-5.x") is already a name and stays as written. */
export function shortModelLabel(label: string): string {
  const trimmed = label.trim();
  const short = (/^[^\s—–]+$/.test(trimmed)
    ? trimmed
    : label.replace(/^[^—–-]+[—–-]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim()) || label;
  const rawId = !/\s/.test(short) && (short.includes('/') || short === short.toLowerCase());
  return rawId ? (modelDisplayName(short) || short) : short;
}
