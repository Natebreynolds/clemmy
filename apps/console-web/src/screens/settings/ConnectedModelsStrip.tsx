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
  // Filter the live catalog — Together AI etc. return hundreds of models.
  const [catalogQuery, setCatalogQuery] = useState('');

  if (settings.isLoading) return <Skeleton className="h-28 w-full" />;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['settings'] });

  const resetCatalog = () => { setCatalog(null); setPicked(new Set()); setCatalogError(null); setCatalogQuery(''); };

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

  // The catalog checklist, shared by the add form and the edit panel. Searchable
  // because providers like Together AI return hundreds of models.
  const catalogChecklist = () => {
    if (!catalog || catalog.length === 0) {
      return (
        <>
          {fetchingModels && <p className="mt-1 text-caption text-muted">Loading catalog…</p>}
          {catalogError && <p className="mt-1 text-small text-warning">{catalogError}</p>}
        </>
      );
    }
    const q = catalogQuery.trim().toLowerCase();
    const filtered = q ? catalog.filter((m) => `${m.id} ${m.label ?? ''}`.toLowerCase().includes(q)) : catalog;
    return (
      <div className="mt-2">
        <div className="mb-1 flex items-center gap-2">
          <Input value={catalogQuery} onChange={(e) => setCatalogQuery(e.target.value)}
            placeholder={`Search ${catalog.length} models…`} aria-label="Search models" className="flex-1" />
          <span className="shrink-0 text-caption text-muted">{picked.size} selected</span>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-caption text-muted">No models match “{catalogQuery}”.</div>
          ) : filtered.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-small hover:bg-surface">
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggleModel(m.id)} />
              <span className="truncate text-fg" title={m.id}>{m.label ?? m.id}</span>
            </label>
          ))}
        </div>
        {q && <div className="mt-1 text-caption text-muted">{filtered.length} of {catalog.length} shown</div>}
        {catalogError && <p className="mt-1 text-small text-warning">{catalogError}</p>}
      </div>
    );
  };

  const onAdd = async () => {
    const modelIds = models.split(',').map((s) => s.trim()).filter(Boolean);
    if (!baseURL.trim() || modelIds.length === 0 || !apiKey.trim()) {
      setError('Add a base URL, an API key, and at least one model id.');
      return;
    }
    setBusy(true); setError(null);
    try {
      // No `mode`: a connected model is eligible for ANY role (it appears in the
      // brain/worker/judge pickers above). The route keeps current routing and
      // only bumps a first provider off 'off' — it never force-reassigns the
      // brain. Pick which model is the brain/worker/judge in the pickers above.
      await addModelProvider({ label: label.trim(), baseURL: baseURL.trim(), apiKey: apiKey.trim(), modelIds });
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
          <p className="mt-2 text-caption text-muted">Once connected, this model is selectable for any role (brain, workers, or judge) in the pickers above.</p>
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
