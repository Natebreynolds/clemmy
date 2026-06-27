import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2, KeyRound, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import type { ModelProvider } from '@/lib/settings';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, addModelProvider, removeModelProvider, listProviderModels, type DiscoveredModel } from '@/lib/settings';
import { PROVIDER_PRESETS } from './ModelBackendForm';

type RunAs = 'worker' | 'all_in';

/**
 * The connected API-key models, as a flat strip — add GLM/Z.ai, DeepSeek,
 * MiniMax, or any OpenAI-compatible endpoint and it instantly shows here with a
 * status pill AND appears in the brain/worker/judge pickers above. This is the
 * "source of truth" surface: each provider routes its own model ids to its own
 * key. (Codex/Claude subscription sign-in lives separately — those are OAuth.)
 */
export function ConnectedModelsStrip() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const providers = settings.data?.modelProviders ?? [];

  const [adding, setAdding] = useState(false);
  const [presetId, setPresetId] = useState(PROVIDER_PRESETS[0].id);
  const [label, setLabel] = useState(PROVIDER_PRESETS[0].label);
  const [baseURL, setBaseURL] = useState(PROVIDER_PRESETS[0].baseURL);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(PROVIDER_PRESETS[0].workerModel);
  const [runAs, setRunAs] = useState<RunAs>('worker');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Model-catalog picker (generic — works for any OpenAI-compatible provider).
  // Shared by the add form and the per-provider "edit models" panel; only one is
  // ever open at a time, so they reuse `models`/`picked`/`catalog` safely.
  const [catalog, setCatalog] = useState<DiscoveredModel[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [catalogError, setCatalogError] = useState<string | null>(null);

  if (settings.isLoading) return <Skeleton className="h-28 w-full" />;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['settings'] });

  const resetCatalog = () => { setCatalog(null); setPicked(new Set()); setCatalogError(null); };

  const applyPreset = (id: string) => {
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    setPresetId(id);
    if (p && p.id !== 'custom') { setLabel(p.label); setBaseURL(p.baseURL); setModels(p.workerModel); }
    else { setLabel(''); setBaseURL(''); setModels(''); }
    setError(null);
    resetCatalog();
  };

  const openAdd = () => { setAdding(true); setEditingId(null); setJustConnected(false); applyPreset(PROVIDER_PRESETS[0].id); setApiKey(''); };

  const parseIds = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  // Pull a provider's live model catalog so the user can pick instead of typing.
  // The manual input stays the source of truth (toggling a row just rewrites it),
  // so it remains the fallback if the fetch fails. Already-selected ids that the
  // catalog omits are kept visible+checkable. Pass a saved provider's `providerId`
  // (key read from the vault) OR an unsaved baseURL+apiKey from the add form.
  const loadCatalog = async (req: { baseURL?: string; apiKey?: string; providerId?: string }, currentIds: string[]) => {
    setPicked(new Set(currentIds));
    setFetchingModels(true); setCatalogError(null);
    try {
      const { models: found } = await listProviderModels(req);
      const ids = new Set(found.map((m) => m.id));
      const extra = currentIds.filter((id) => !ids.has(id)).map((id) => ({ id } as DiscoveredModel));
      setCatalog([...extra, ...found]);
      if (found.length === 0 && extra.length === 0) setCatalogError('No models returned — enter ids manually.');
    } catch (err) {
      setCatalog(null);
      setCatalogError(err instanceof Error ? err.message : String(err));
    } finally { setFetchingModels(false); }
  };

  const onBrowse = () => {
    if (!baseURL.trim() || !apiKey.trim()) { setCatalogError('Add a base URL and API key first.'); return; }
    void loadCatalog({ baseURL: baseURL.trim(), apiKey: apiKey.trim() }, parseIds(models));
  };

  // Edit a CONNECTED provider's model list. Reuses the saved key (providerId →
  // vault), so the browser never resends it. Reuses the same picker as add.
  const openEdit = (p: ModelProvider) => {
    setAdding(false); setEditingId(p.id); setError(null);
    setModels(p.modelIds.join(', '));
    void loadCatalog({ providerId: p.id }, p.modelIds);
  };
  const closeEdit = () => { setEditingId(null); resetCatalog(); };
  const onSaveEdit = async (p: ModelProvider) => {
    const modelIds = parseIds(models);
    if (modelIds.length === 0) { setError('Pick at least one model, or remove the provider.'); return; }
    setBusy(true); setError(null);
    try {
      // No apiKey → the route keeps the saved key. id matches → replaces this
      // provider's model list (default provider updates its legacy slot).
      await addModelProvider({ id: p.id, label: p.label, baseURL: p.baseURL, modelIds });
      closeEdit();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const toggleModel = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
    setModels(Array.from(next).join(', '));
    setError(null);
  };

  // The catalog checklist, shared by the add form and the edit panel.
  const catalogChecklist = () => (
    <>
      {catalog && catalog.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-caption text-muted">{picked.size} selected · click to toggle</div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
            {catalog.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-small hover:bg-surface">
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggleModel(m.id)} />
                <span className="truncate text-fg" title={m.id}>{m.label ?? m.id}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {fetchingModels && <p className="mt-1 text-caption text-muted">Loading catalog…</p>}
      {catalogError && <p className="mt-1 text-small text-warning">{catalogError}</p>}
    </>
  );

  const onAdd = async () => {
    const modelIds = models.split(',').map((s) => s.trim()).filter(Boolean);
    if (!baseURL.trim() || modelIds.length === 0 || !apiKey.trim()) {
      setError('Add a base URL, an API key, and at least one model id.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await addModelProvider({ label: label.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim(), modelIds, mode: runAs });
      setApiKey(''); setAdding(false); setJustConnected(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const onRemove = async (id: string) => {
    setBusy(true); setError(null); setJustConnected(false);
    try { await removeModelProvider(id); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const currentHint = PROVIDER_PRESETS.find((p) => p.id === presetId)?.modelHint ?? '';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-label text-fg">Connected models (API key)</span>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={openAdd}>
            <Plus className="h-4 w-4" aria-hidden /> Add a model
          </Button>
        )}
      </div>

      {providers.length === 0 && !adding && (
        <p className="text-small text-muted">
          None yet. Add GLM (Z.ai), DeepSeek, MiniMax, or any OpenAI-compatible endpoint — it shows up in the pickers above instantly.
        </p>
      )}

      {providers.length > 0 && (
        <ul className="space-y-1.5">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2">
              <KeyRound className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-small">
                  <span className="truncate text-fg">{p.label || p.id}</span>
                  {p.isDefault && <span className="shrink-0 rounded bg-surface px-1 text-caption text-muted">default</span>}
                </div>
                <div className="truncate text-caption text-muted" title={p.modelIds.join(', ')}>{p.modelIds.join(' · ') || 'no models'}</div>
              </div>
              <span className={'inline-flex shrink-0 items-center gap-1 text-caption ' + (p.configured ? 'text-success' : 'text-warning')}>
                {p.configured
                  ? <><Check className="h-3.5 w-3.5" aria-hidden /> key saved</>
                  : <><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> no key</>}
              </span>
              <button type="button"
                className="shrink-0 rounded p-1 text-muted hover:text-fg disabled:opacity-50"
                disabled={busy} onClick={() => (editingId === p.id ? closeEdit() : openEdit(p))}
                aria-label={`Edit ${p.label || p.id} models`}>
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
              </button>
              <button type="button"
                className="shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-50"
                disabled={busy} onClick={() => onRemove(p.id)} aria-label={`Remove ${p.label || p.id}`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editingId && (() => {
        const p = providers.find((x) => x.id === editingId);
        if (!p) return null;
        return (
          <div className="mt-2 rounded-lg border border-border bg-canvas p-3">
            <div className="mb-2 text-label text-fg">Edit models — {p.label || p.id}</div>
            <Field label="Models" hint="Check models from the catalog, or edit the list directly. First model is this provider's primary.">{(id) => (
              <div className="flex gap-2">
                <Input id={id} className="flex-1 min-w-0" value={models} placeholder="model-id, another-id" onChange={(e) => setModels(e.target.value)} />
                <Button className="shrink-0 self-center" variant="secondary" size="sm"
                  onClick={() => void loadCatalog({ providerId: p.id }, parseIds(models))} disabled={fetchingModels}>
                  {fetchingModels ? 'Loading…' : 'Reload catalog'}
                </Button>
              </div>
            )}</Field>
            {catalogChecklist()}
            <div className="mt-2 flex items-center gap-2">
              <Button onClick={() => onSaveEdit(p)} disabled={busy}>{busy ? 'Saving…' : 'Save models'}</Button>
              <Button variant="secondary" size="sm" onClick={closeEdit}>Cancel</Button>
            </div>
          </div>
        );
      })()}

      {adding && (
        <div className="mt-3 rounded-lg border border-border bg-canvas p-3">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Provider" hint="Pre-fills the endpoint + a default model.">{(id) => (
              <Select id={id} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            )}</Field>
            <Field label="Base URL">{(id) => (
              <Input id={id} value={baseURL} placeholder="https://api.z.ai/api/paas/v4" onChange={(e) => setBaseURL(e.target.value)} />
            )}</Field>
            <Field label="API key" hint="Stored locally on this machine.">{(id) => (
              <Input id={id} type="password" value={apiKey} placeholder="paste your API key" onChange={(e) => setApiKey(e.target.value)} />
            )}</Field>
            <Field label="Models" hint={currentHint || 'Comma-separated model ids this provider serves.'}>{(id) => (
              <div className="flex gap-2">
                <Input id={id} className="flex-1 min-w-0" value={models} placeholder="glm-5.2" onChange={(e) => setModels(e.target.value)} />
                <Button className="shrink-0 self-center" variant="secondary" size="sm" onClick={onBrowse}
                  disabled={fetchingModels || !baseURL.trim() || !apiKey.trim()}>
                  {fetchingModels ? 'Loading…' : 'Browse models'}
                </Button>
              </div>
            )}</Field>
          </div>
          {catalogChecklist()}
          <div className="mt-1 sm:max-w-[18rem]">
            <Field label="Run it as">{(id) => (
              <Select id={id} value={runAs} onChange={(e) => setRunAs(e.target.value as RunAs)}>
                <option value="worker">Workers (Codex stays the brain)</option>
                <option value="all_in">Everything (brain + judge too)</option>
              </Select>
            )}</Field>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={onAdd} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
            <Button variant="secondary" size="sm" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        {justConnected && (
          <span className="inline-flex items-center gap-1 text-small text-success">
            <Check className="h-4 w-4" aria-hidden /> Connected — now selectable in the pickers above
          </span>
        )}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </div>
  );
}
