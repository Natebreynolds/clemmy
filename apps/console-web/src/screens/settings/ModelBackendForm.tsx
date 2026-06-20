import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Cpu, Layers, Zap, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, patchModelBackend, type ModelBackend, type ModelRoutingMode } from '@/lib/settings';

type FormState = {
  mode: ModelRoutingMode;
  baseURL: string;
  apiKey: string;
  modelId: string;
  judgeId: string;
  workerModel: string;
  providerLabel: string;
};

// Pre-filled provider endpoints + sensible default models. Pick one and you
// only need to paste an API key. Values verified 2026-06 — editable in case a
// provider changes an endpoint or model id.
export const PROVIDER_PRESETS: { id: string; label: string; baseURL: string; workerModel: string; modelHint: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', workerModel: 'deepseek-chat', modelHint: 'deepseek-chat (fast, non-thinking) is best for worker grunt work. deepseek-reasoner for hard reasoning. (New aliases: deepseek-v4-flash / deepseek-v4-pro.)' },
  { id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimax.io/v1', workerModel: 'MiniMax-M3', modelHint: 'MiniMax-M3 — current flagship (1M context, multimodal, agentic). Alternatives: MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.' },
  { id: 'glm', label: 'GLM (Z.ai)', baseURL: 'https://api.z.ai/api/paas/v4', workerModel: 'glm-5.2', modelHint: 'glm-5.2 — Z.ai flagship (1M context, strong coding & agentic). Lighter alternatives: glm-4.6, glm-4.5-air. (GLM Coding Plan users: swap the base URL to https://api.z.ai/api/coding/paas/v4.)' },
  { id: 'custom', label: 'Custom (any OpenAI-compatible)', baseURL: '', workerModel: '', modelHint: 'Any OpenAI-compatible Chat Completions endpoint.' },
];

const MODES: { id: ModelRoutingMode; label: string; icon: typeof Cpu; blurb: string }[] = [
  { id: 'off', label: 'Codex only', icon: Cpu, blurb: 'Everything runs on Codex. The default — nothing changes.' },
  { id: 'worker', label: 'Codex + cheap workers', icon: Layers, blurb: 'Codex stays the brain & judge. A cheap model does the grunt work (scraping, enrichment, drafting). Codex validates every result.' },
  { id: 'all_in', label: 'All-in — no Codex', icon: Zap, blurb: 'Every role runs on your cheap model, including the judge. No ChatGPT/Codex subscription needed. Cheapest, but no frontier safety net unless you set a separate judge model.' },
];

function fromSnapshot(b: ModelBackend | undefined): FormState {
  return {
    mode: b?.mode ?? 'off',
    baseURL: b?.baseURL ?? '',
    apiKey: '',
    modelId: b?.modelId ?? '',
    judgeId: b?.judgeId ?? '',
    workerModel: b?.workerModel ?? '',
    providerLabel: b?.providerLabel ?? '',
  };
}

export function ModelBackendForm({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const snap = settings.data?.modelBackend;
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (snap && !form) setForm(fromSnapshot(snap)); }, [snap, form]);

  if (settings.isLoading || !form) {
    const sk = <Skeleton className="h-40 w-full" />;
    return embedded ? sk : <Card className="p-5">{sk}</Card>;
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); setError(null); };

  // Which provider preset matches the current base URL (for the selector).
  const currentProviderId = PROVIDER_PRESETS.find((p) => p.baseURL && p.baseURL === form.baseURL.trim())?.id ?? 'custom';
  const currentPreset = PROVIDER_PRESETS.find((p) => p.id === currentProviderId)!;
  const applyProvider = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => (f ? {
      ...f,
      providerLabel: p.id === 'custom' ? '' : p.label,
      baseURL: p.id === 'custom' ? f.baseURL : p.baseURL,
      modelId: p.workerModel || f.modelId,
    } : f));
    setSaved(false); setError(null);
  };
  const hasKey = Boolean(snap?.hasKey) || form.apiKey.trim().length > 0;
  const needsBackend = form.mode !== 'off';
  const incomplete = needsBackend && (!form.baseURL.trim() || !form.modelId.trim() || !hasKey);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await patchModelBackend({
        mode: form.mode,
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey.trim() || undefined,
        modelId: form.modelId.trim(),
        judgeId: form.judgeId.trim(),
        workerModel: form.workerModel.trim(),
        providerLabel: form.providerLabel.trim(),
      });
      setSaved(true);
      setForm((f) => (f ? { ...f, apiKey: '' } : f));
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const activeMode = MODES.find((m) => m.id === form.mode)!;

  const body = (
    <>
      <h3 className="mb-1 text-h3 text-fg">Model backend</h3>
      <p className="mb-4 text-small text-muted">
        Run the grunt work on a cheaper, large-context model (MiniMax, DeepSeek, or any OpenAI-compatible endpoint) while Codex stays the brain. Additive and reversible — “Codex only” is exactly today’s behavior.
      </p>

      {/* Mode picker */}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = form.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => set('mode', m.id)}
              className={
                'flex items-start gap-2 rounded-lg border p-3 text-left transition-colors cursor-pointer ' +
                (active ? 'border-primary bg-primary-tint' : 'border-border hover:border-primary')
              }
            >
              <Icon className={'mt-0.5 h-4 w-4 shrink-0 ' + (active ? 'text-primary' : 'text-muted')} aria-hidden />
              <span className={'text-label ' + (active ? 'text-fg' : 'text-muted')}>{m.label}</span>
            </button>
          );
        })}
      </div>

      {/* How it works, for the active mode */}
      <div className="mb-4 rounded-lg border border-border bg-canvas p-3">
        <p className="text-small text-muted"><span className="text-fg">How this works:</span> {activeMode.blurb}</p>
        {form.mode !== 'off' && (
          <ul className="mt-2 space-y-0.5 text-caption text-muted">
            <li>🧠 Brain &amp; Judge → {form.mode === 'all_in' ? (form.judgeId.trim() || form.modelId.trim() || 'your model') : 'Codex (GPT-5.x)'}</li>
            <li>🛠 Workers / grunt work → {form.workerModel.trim() || form.modelId.trim() || 'your model'}</li>
          </ul>
        )}
      </div>

      {form.mode === 'all_in' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning bg-warning-tint p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-muted">
            With Codex gone, the cheap model judges its own work — and a model often can’t catch its own mistakes. For safety, set a <span className="text-fg">Judge model</span> below to a <em>different</em> cheap model so the validator doesn’t share the worker’s blind spots. Don’t delegate irreversible actions (sends, payments) without a real validator.
          </p>
        </div>
      )}

      {needsBackend && (
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Provider" hint="Pick one to pre-fill its endpoint + model — then you only add a key.">{(id) => (
            <Select id={id} value={currentProviderId} onChange={(e) => applyProvider(e.target.value)}>
              {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          )}</Field>
          <Field label="Base URL" hint="Auto-filled from the provider. Editable if the endpoint ever changes.">{(id) => (
            <Input id={id} value={form.baseURL} placeholder="https://api.deepseek.com" onChange={(e) => set('baseURL', e.target.value)} />
          )}</Field>
          <Field label="API key" hint={snap?.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Your provider API key. Stored locally on this machine.'}>{(id) => (
            <Input id={id} type="password" value={form.apiKey} placeholder={snap?.hasKey ? '•••••••••• (saved)' : 'paste your API key'} onChange={(e) => set('apiKey', e.target.value)} />
          )}</Field>
          <Field label={form.mode === 'all_in' ? 'Model (brain + workers)' : 'Worker model'} hint={currentPreset.modelHint}>{(id) => (
            <Input id={id} value={form.modelId} placeholder={currentPreset.workerModel || 'deepseek-chat'} onChange={(e) => set('modelId', e.target.value)} />
          )}</Field>
          {form.mode === 'all_in' && (
            <Field label="Judge model (recommended)" hint="A DIFFERENT cheap model to validate output. Leave blank to let the model judge itself (not recommended).">{(id) => (
              <Input id={id} value={form.judgeId} placeholder="deepseek-chat" onChange={(e) => set('judgeId', e.target.value)} />
            )}</Field>
          )}
          {form.mode === 'worker' && (
            <Field label="Worker model override (optional)" hint="Defaults to the model above. Set only to use a different id for workers.">{(id) => (
              <Input id={id} value={form.workerModel} placeholder="(uses the model above)" onChange={(e) => set('workerModel', e.target.value)} />
            )}</Field>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        <Button onClick={save} disabled={saving || incomplete}>{saving ? 'Saving…' : 'Save backend'}</Button>
        {incomplete && <span className="text-caption text-muted">Add a base URL, API key, and model id to enable.</span>}
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies to new runs</span>}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </>
  );
  return embedded ? body : <Card className="p-5">{body}</Card>;
}
