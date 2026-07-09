/**
 * CartridgeInsert — the full-screen "slot a cartridge in" moment.
 *
 * Drop a .clemplug (or paste a URL) and this overlay walks the REAL
 * consent-before-install contract with Game Boy energy:
 *
 *   reading → seated (cartridge slides into the slot, *click*) → consent
 *   (what's inside + what it asks for) → materializing (each asset flies
 *   onto its shelf while the install actually runs) → done
 *
 * The animation is driven client-side from the preview breakdown around
 * two API calls: POST /plugins/preview (stashes the archive under a
 * short-lived token) and POST /plugins/install ({uploadToken}). Nothing
 * materializes before the user consents. Honors prefers-reduced-motion.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, BookOpen, Brain, CheckCircle2, Cog, Package, Plug, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { api, apiPost, type ApiError } from '@/lib/api';

export type CartridgeSource = { file: File } | { url: string } | { catalogId: string };

interface PluginPreview {
  uploadToken: string;
  manifest: { id: string; name: string; version: string; description?: string; publisher?: { name?: string } };
  contents: { skills: string[]; workflows: string[]; mcpServers: string[]; memoryFiles: string[] };
  consent: string[];
  warnings: string[];
}
interface InstallResponse {
  ok: boolean;
  plugin: { artifacts: Array<{ kind: string; name: string }>; memory?: { newFacts: number; deduped: number } };
}

type Stage = 'reading' | 'seated' | 'consent' | 'materializing' | 'done' | 'error';

const previewFromSource = (source: CartridgeSource): Promise<PluginPreview> =>
  'file' in source
    ? api<PluginPreview>(`/api/console/plugins/preview?name=${encodeURIComponent(source.file.name)}`, {
        method: 'POST',
        body: source.file,
        headers: { 'content-type': 'application/octet-stream' },
      })
    : 'url' in source
      ? apiPost<PluginPreview>('/api/console/plugins/preview', { url: source.url })
      : apiPost<PluginPreview>('/api/console/plugins/preview', { catalogId: source.catalogId });

type ShelfKind = 'skill' | 'workflow' | 'mcp' | 'memory';
const SHELVES: Array<{ kind: ShelfKind; label: string; Icon: typeof BookOpen }> = [
  { kind: 'skill', label: 'Skills', Icon: BookOpen },
  { kind: 'workflow', label: 'Workflows', Icon: Cog },
  { kind: 'mcp', label: 'MCP servers', Icon: Plug },
  { kind: 'memory', label: 'Memory', Icon: Brain },
];

function chipsOf(contents: PluginPreview['contents']): Array<{ kind: ShelfKind; name: string }> {
  return [
    ...contents.skills.map((name) => ({ kind: 'skill' as const, name })),
    ...contents.workflows.map((name) => ({ kind: 'workflow' as const, name })),
    ...contents.mcpServers.map((name) => ({ kind: 'mcp' as const, name })),
    ...contents.memoryFiles.map((f) => ({ kind: 'memory' as const, name: f.split('/').pop()?.replace(/\.md$/i, '') ?? f })),
  ];
}

/** The cartridge shell — grip ridges, a label plate, clementine-brand accent. */
function Cartridge({ title, subtitle, glow }: { title: string; subtitle?: string; glow?: boolean }) {
  return (
    <div className={`w-64 rounded-lg border border-border-strong bg-surface p-3 shadow-lg ${glow ? 'shadow-warm-halo' : ''}`}>
      <div className="mb-2 flex justify-center gap-1.5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-1.5 w-6 rounded-full bg-subtle" />)}
      </div>
      <div className="rounded-md bg-primary-tint p-3 text-center">
        <Package className="mx-auto mb-1 h-6 w-6 text-primary" aria-hidden />
        <div className="truncate text-body font-semibold text-fg">{title}</div>
        {subtitle && <div className="truncate text-caption text-muted">{subtitle}</div>}
      </div>
      <div className="mt-2 flex justify-between px-1" aria-hidden>
        <div className="h-2 w-2 rounded-full bg-subtle" />
        <div className="h-2 w-10 rounded-full bg-subtle" />
        <div className="h-2 w-2 rounded-full bg-subtle" />
      </div>
    </div>
  );
}

function Slot({ engaged }: { engaged: boolean }) {
  return (
    <motion.div
      className="mx-auto h-4 w-72 rounded-full border border-border-strong bg-subtle"
      animate={engaged ? { scale: [1, 0.96, 1] } : {}}
      transition={{ duration: 0.25 }}
      aria-hidden
    >
      <div className="mx-auto mt-1 h-2 w-64 rounded-full bg-canvas" />
    </motion.div>
  );
}

export function CartridgeInsert({ source, onClose }: { source: CartridgeSource; onClose: (installed: boolean) => void }) {
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<Stage>('reading');
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [result, setResult] = useState<InstallResponse['plugin'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorExpired, setErrorExpired] = useState(false);
  const closedRef = useRef(false);

  const chips = useMemo(() => (preview ? chipsOf(preview.contents) : []), [preview]);
  const shelves = useMemo(
    () => SHELVES.filter((s) => chips.some((c) => c.kind === s.kind)),
    [chips],
  );

  const runPreview = useCallback(() => {
    setStage('reading');
    setError(null);
    previewFromSource(source)
      .then((p) => {
        if (closedRef.current) return;
        setPreview(p);
        setStage('seated');
      })
      .catch((err: ApiError) => {
        if (closedRef.current) return;
        setError(err.message || 'Could not read the cartridge');
        setErrorExpired(false);
        setStage('error');
      });
  }, [source]);

  useEffect(() => {
    runPreview();
    return () => { closedRef.current = true; };
  }, [runPreview]);

  // seated → consent after the click beat.
  useEffect(() => {
    if (stage !== 'seated') return;
    const t = setTimeout(() => setStage('consent'), reduced ? 150 : 900);
    return () => clearTimeout(t);
  }, [stage, reduced]);

  const install = useCallback(() => {
    if (!preview) return;
    setStage('materializing');
    const minShow = reduced ? 0 : Math.max(1800, chips.length * 120 + 1000);
    const animDone = new Promise<void>((r) => setTimeout(r, minShow));
    const req = apiPost<InstallResponse>('/api/console/plugins/install', { uploadToken: preview.uploadToken });
    Promise.all([req, animDone])
      .then(([res]) => {
        if (closedRef.current) return;
        setResult(res.plugin);
        setStage('done');
      })
      .catch((err: ApiError) => {
        if (closedRef.current) return;
        setError(err.message || 'Install failed');
        setErrorExpired(err.status === 404);
        setStage('error');
      });
  }, [preview, chips.length, reduced]);

  const close = useCallback((installed: boolean) => {
    closedRef.current = true;
    onClose(installed);
  }, [onClose]);

  // Esc cancels anywhere except mid-install (the request is already in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'materializing') close(stage === 'done');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, close]);

  const drop = reduced ? {} : { initial: { y: -140, opacity: 0 }, animate: { y: 0, opacity: 1 } };
  const statusLine =
    stage === 'reading' ? 'Reading plugin…'
    : stage === 'seated' ? 'Plugin ready.'
    : stage === 'materializing' ? 'Installing…'
    : stage === 'done' ? 'Plugin installed.'
    : '';

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/90 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      role="dialog" aria-modal="true" aria-label="Install plugin"
    >
      <div className="w-full max-w-lg">
        <p aria-live="polite" className="sr-only">{statusLine}</p>
        {stage !== 'materializing' && (
          <button
            className="absolute right-4 top-4 rounded-md p-2 text-muted hover:bg-hover hover:text-fg"
            onClick={() => close(stage === 'done')} aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        <AnimatePresence mode="wait">
          {(stage === 'reading' || stage === 'seated') && (
            <motion.div key="insert" className="text-center" exit={{ opacity: 0 }}>
              <motion.div
                className="mb-3 inline-block"
                {...drop}
                transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              >
                <motion.div
                  animate={stage === 'seated' && !reduced ? { y: [0, 26, 22], rotate: [0, 0, 0.6] } : {}}
                  transition={{ duration: 0.45, ease: 'easeIn' }}
                >
                  <Cartridge
                    title={preview?.manifest.name ?? 'Reading plugin…'}
                    subtitle={preview ? `v${preview.manifest.version}${preview.manifest.publisher?.name ? ` · ${preview.manifest.publisher.name}` : ''}` : undefined}
                    glow={stage === 'seated'}
                  />
                </motion.div>
              </motion.div>
              <Slot engaged={stage === 'seated'} />
              <p className="mt-4 text-body text-muted">{stage === 'seated' ? 'Plugin ready.' : 'Reading plugin…'}</p>
            </motion.div>
          )}

          {stage === 'consent' && preview && (
            <motion.div
              key="consent"
              className="rounded-lg border border-border bg-surface p-5 shadow-lg"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            >
              <div className="mb-1 flex items-center gap-2">
                <Package className="h-5 w-5 text-primary" aria-hidden />
                <h3 className="text-h3 text-fg">{preview.manifest.name} <span className="font-normal text-faint">v{preview.manifest.version}</span></h3>
              </div>
              {preview.manifest.description && <p className="mb-3 text-body text-muted">{preview.manifest.description}</p>}

              <div className="mb-3 grid grid-cols-2 gap-2">
                {shelves.map(({ kind, label, Icon }) => (
                  <div key={kind} className="flex items-center gap-2 rounded-md bg-subtle px-3 py-2">
                    <Icon className="h-4 w-4 text-primary" aria-hidden />
                    <span className="text-body text-fg">{chips.filter((c) => c.kind === kind).length} {label.toLowerCase()}</span>
                  </div>
                ))}
              </div>

              <div className="mb-3 rounded-md border border-border bg-canvas p-3">
                {preview.consent.map((line, i) => (
                  <p key={i} className={`text-caption ${i === 0 ? 'font-semibold text-fg' : 'text-muted'}`}>{line}</p>
                ))}
                {preview.warnings.map((w, i) => (
                  <p key={`w${i}`} className="mt-1 flex items-center gap-1 text-caption text-danger">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />{w}
                  </p>
                ))}
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
                <Button autoFocus onClick={install}>Install plugin</Button>
              </div>
            </motion.div>
          )}

          {stage === 'materializing' && preview && (
            <motion.div key="materialize" className="text-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="mb-6 opacity-70"><div className="inline-block"><Slot engaged /></div></div>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(shelves.length, 4)}, minmax(0, 1fr))` }}>
                {shelves.map(({ kind, label, Icon }) => {
                  const mine = chips.filter((c) => c.kind === kind);
                  return (
                    <div key={kind} className="rounded-lg border border-border bg-surface p-3">
                      <div className="mb-2 flex items-center justify-center gap-1.5 text-caption font-semibold text-muted">
                        <Icon className="h-4 w-4 text-primary" aria-hidden />{label}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {mine.map((chip) => (
                          <motion.div
                            key={chip.name}
                            className="truncate rounded-md bg-primary-tint px-2 py-1 text-caption text-fg"
                            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -120, scale: 0.7 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{
                              delay: reduced ? 0 : (chips.indexOf(chip)) * 0.12 + 0.3,
                              type: 'spring', stiffness: 210, damping: 20,
                            }}
                          >
                            {chip.name}
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-body text-muted">Installing {preview.manifest.name}…</p>
            </motion.div>
          )}

          {stage === 'done' && preview && (
            <motion.div
              key="done"
              className="rounded-lg border border-border bg-surface p-6 text-center shadow-warm-halo"
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-success" aria-hidden />
              <h3 className="text-h3 text-fg">Plugin installed</h3>
              <p className="mt-1 text-body text-muted">
                {preview.manifest.name} unlocked {result?.artifacts.length ?? chips.length} new capabilit{(result?.artifacts.length ?? chips.length) === 1 ? 'y' : 'ies'} for your agent.
                {result?.memory ? ` ${result.memory.newFacts} memory fact${result.memory.newFacts === 1 ? '' : 's'} learned${result.memory.deduped ? ` (${result.memory.deduped} already known)` : ''}.` : ''}
              </p>
              <Button className="mt-4" autoFocus onClick={() => close(true)}>Done</Button>
            </motion.div>
          )}

          {stage === 'error' && (
            <motion.div
              key="error"
              className="rounded-lg border border-danger/40 bg-surface p-6 text-center shadow-lg"
              initial={{ opacity: 0 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, x: [0, -8, 8, -4, 4, 0] }}
              transition={{ duration: 0.4 }}
            >
              <AlertTriangle className="mx-auto mb-2 h-7 w-7 text-danger" aria-hidden />
              <h3 className="text-h3 text-fg">Install failed</h3>
              <p className="mt-1 text-body text-danger">{error}</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="secondary" onClick={() => close(false)}>Close</Button>
                <Button onClick={() => { if (errorExpired || !preview) runPreview(); else install(); }}>
                  {errorExpired || !preview ? 'Read plugin again' : 'Retry'}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
