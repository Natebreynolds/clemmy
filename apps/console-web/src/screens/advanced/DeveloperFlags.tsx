import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw, X, FlaskConical, AlertTriangle } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Select, Input } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getDeveloperFlags, patchDeveloperFlags, type DevFlag } from '@/lib/settings';

function FlagRow({
  flag, busy, onSet, onClear,
}: {
  flag: DevFlag;
  busy: boolean;
  onSet: (value: string) => void;
  onClear: () => void;
}) {
  const isBool = flag.type === 'boolean';
  const on = flag.value.trim().toLowerCase() === 'on';
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-fg">{flag.label}</span>
          {flag.overridden ? (
            <span className="rounded bg-primary-tint px-1.5 py-0.5 text-caption font-semibold text-primary">overridden</span>
          ) : (
            <span className="rounded bg-canvas px-1.5 py-0.5 text-caption text-muted">default · {flag.default || '—'}</span>
          )}
        </div>
        <p className="mt-0.5 text-small text-muted">{flag.description}</p>
        <code className="mt-0.5 block font-mono text-caption text-faint">{flag.key}</code>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {flag.overridden && (
          <button type="button" onClick={onClear} disabled={busy} title="Reset to default"
            className="text-faint hover:text-fg disabled:opacity-50 cursor-pointer">
            <RotateCcw className="h-4 w-4" aria-hidden />
          </button>
        )}
        {isBool ? (
          <Switch checked={on} disabled={busy} label={flag.label} onChange={(v) => onSet(v ? 'on' : 'off')} />
        ) : (
          <Select value={flag.value} disabled={busy} onChange={(e) => onSet(e.target.value)} className="w-36">
            {(flag.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            {!(flag.options ?? []).includes(flag.value) && <option value={flag.value}>{flag.value}</option>}
          </Select>
        )}
      </div>
    </div>
  );
}

export function DeveloperFlags() {
  const qc = useQueryClient();
  const q = usePoll(['developer-flags'], getDeveloperFlags, 0);
  const snap = q.data?.developerFlags;
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advKey, setAdvKey] = useState('');
  const [advVal, setAdvVal] = useState('');

  if (q.isLoading || !snap) {
    return <Page title="Developer · Feature flags" subtitle="Runtime CLEMMY_* kill-switches"><Skeleton className="h-64 w-full" /></Page>;
  }

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['developer-flags'] }); void qc.invalidateQueries({ queryKey: ['settings'] }); };
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null); setSaved(false);
    try { await fn(); setSaved(true); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const categories = [...new Set(snap.flags.map((f) => f.category))];

  return (
    <Page title="Developer · Feature flags" subtitle="Flip CLEMMY_* kill-switches at runtime — live + persisted, no restart">
      <div className="space-y-4">
        <Card className="flex items-start gap-3 border-warning/40 bg-warning/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
          <p className="text-small text-muted">
            These toggle real behavior immediately and persist across restarts. Turning a <strong>default-on</strong> gate
            off disables a guardrail. “Reset” reverts a flag to its code default. When unsure, leave it.
          </p>
        </Card>

        {(saved || error) && (
          <div className="flex items-center gap-2 text-small">
            {saved && <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies immediately</span>}
            {error && <span className="text-danger">{error}</span>}
          </div>
        )}

        {categories.map((cat) => (
          <Card key={cat} className="p-5">
            <h3 className="mb-1 text-h3 text-fg">{cat}</h3>
            <div className="mt-2">
              {snap.flags.filter((f) => f.category === cat).map((f) => (
                <FlagRow key={f.key} flag={f} busy={busy === f.key}
                  onSet={(value) => run(f.key, () => patchDeveloperFlags({ key: f.key, value }))}
                  onClear={() => run(f.key, () => patchDeveloperFlags({ key: f.key, clear: true }))} />
              ))}
            </div>
          </Card>
        ))}

        <Card className="p-5">
          <h3 className="mb-1 text-h3 text-fg">Advanced — any CLEMMY_ key</h3>
          <p className="mb-3 text-small text-muted">Set an override for any flag not listed above (thresholds, model names, etc.). Only CLEMMY_* keys are accepted.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Input value={advKey} onChange={(e) => setAdvKey(e.target.value)} placeholder="CLEMMY_SOME_FLAG"
              className="min-w-[16rem] flex-1 font-mono" aria-label="Flag key" />
            <Input value={advVal} onChange={(e) => setAdvVal(e.target.value)} placeholder="value (e.g. on / off / 3000)"
              className="min-w-[12rem] flex-1" aria-label="Flag value" />
            <Button variant="secondary" size="sm" disabled={busy === advKey || !advKey.trim() || !advVal.trim()}
              onClick={() => run(advKey.trim().toUpperCase(), async () => {
                await patchDeveloperFlags({ key: advKey.trim().toUpperCase(), value: advVal.trim() });
                setAdvKey(''); setAdvVal('');
              })}>Set</Button>
          </div>

          {snap.custom.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-label text-faint">Custom overrides set here</p>
              <ul className="space-y-1.5">
                {snap.custom.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <code className="min-w-0 truncate font-mono text-small text-fg">{c.key}={c.value}</code>
                    <button type="button" onClick={() => run(c.key, () => patchDeveloperFlags({ key: c.key, clear: true }))}
                      disabled={busy === c.key} title="Clear override"
                      className="shrink-0 text-faint hover:text-danger disabled:opacity-50 cursor-pointer">
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <p className="flex items-center gap-1.5 text-caption text-faint">
          <FlaskConical className="h-3.5 w-3.5" aria-hidden />
          Hide this panel anytime: Settings → Developer mode.
        </p>
      </div>
    </Page>
  );
}
