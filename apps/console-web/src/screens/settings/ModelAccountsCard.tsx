import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, ExternalLink, KeyRound, Plus } from 'lucide-react';
import { accountCaption, accountHeadline, creditRefusalSentence, meterTone, resetsInText, type UsageMeter } from '@clem/chat-engine';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';
import { useUsageMeters } from '@/components/ModelStatusChips';
import { useModelRoles } from '@/lib/model-roles';
import { setCredential } from '@/lib/connect';
import type { ModelProvider } from '@/lib/settings';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { CodexLoginForm } from './CodexLoginForm';
import { XaiLoginForm } from './XaiLoginForm';
import { JevConnectForm } from './JevConnectForm';
import { AddModelForm, ProviderManagePanel } from './ModelProviderForms';

/**
 * Settings › Models › Accounts: every model account on one list — what it is
 * doing for Clem, how much of it is left, and the provider's own page for
 * adding credit, one click away. An account turns red only when its provider
 * has actually turned down a request for lack of credit, and the row quotes
 * the provider — it never guesses from a balance. Sign-ins, keys and
 * model lists open inline under their own row, so nothing sends the owner to
 * another screen.
 */

/** Accounts Clem can sign in to or take a key for even when none is
 *  connected yet. API-key providers appear once added. */
const SIGN_IN_ACCOUNTS: Array<{ id: string; label: string; what: string }> = [
  { id: 'claude', label: 'Claude', what: 'Claude Max/Pro subscription' },
  { id: 'codex', label: 'Codex', what: 'ChatGPT/Codex subscription' },
  { id: 'xai', label: 'Grok', what: 'xAI account' },
  { id: 'jev', label: 'Jev', what: 'Fast yes/no checks (TypeSafe key)' },
  { id: 'openai', label: 'OpenAI API', what: 'Memory search and voice (API key)' },
];

const TONE_TEXT = { ok: 'text-muted', warning: 'text-warning', danger: 'text-danger' } as const;
const TONE_BAR = { ok: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } as const;

function timeOfDay(epochMs: number): string {
  const d = new Date(epochMs);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function accountKind(id: string, providers: ModelProvider[]): string {
  if (id === 'claude' || id === 'codex') return 'Sign-in';
  if (id === 'jev' || id === 'openai') return 'API key';
  if (id === 'xai') return providers.some((p) => p.id === 'xai' && p.hasKey) ? 'API key' : 'Sign-in';
  return 'API key';
}

function dotColor(id: string): string {
  if (id === 'jev') return '#E551BA';
  const provider = id === 'claude' || id === 'codex' || id === 'xai' || id === 'openai' ? id : 'byo';
  return PROVIDER_DOT[provider as keyof typeof PROVIDER_DOT] ?? PROVIDER_DOT.unknown;
}

function BillingLink({ meter, emphasis }: { meter: UsageMeter; emphasis: boolean }) {
  if (!meter.billing) return null;
  return (
    <a href={meter.billing.url} target="_blank" rel="noopener noreferrer"
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 text-small font-semibold',
        emphasis
          ? 'bg-danger text-danger-fg hover:bg-danger-hover'
          : 'border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover',
      )}
      aria-label={`${meter.billing.action} for ${meter.label} (opens the provider's billing page)`}>
      {meter.billing.action} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function MeterDetail({ meter, now }: { meter: UsageMeter; now: number }) {
  const refusal = creditRefusalSentence(meter, timeOfDay);
  if (refusal) {
    return (
      <p className="mt-1 flex items-start gap-1 text-small text-danger">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{refusal}</span>
      </p>
    );
  }
  return (
    <>
      {meter.windows.length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {meter.windows.map((w) => {
            const reset = resetsInText(w.resetAt, now);
            return (
              <div key={w.id}>
                <div className="flex justify-between gap-2 text-caption text-muted">
                  <span>{w.label}</span>
                  <span className={cn('tabular-nums font-semibold', w.tone === 'ok' ? 'text-fg' : TONE_TEXT[w.tone])}>{w.usedPercent}%{reset ? ` · ${reset}` : ''}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={`${meter.label} ${w.label}`}>
                  <div className={cn('h-full rounded-full', TONE_BAR[w.tone])} style={{ width: `${w.usedPercent}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** The grey line under the name: sign-in or key, then the shared grammar's
 *  "what it does · today's spend" (accountCaption), the same words the phone says. */
function captionFor(meter: UsageMeter | undefined, kind: string, notConnectedNote: string | undefined, now: number): string {
  if (!meter) return notConnectedNote ?? '';
  return `${kind} · ${accountCaption(meter, now)}`;
}

function OpenAiKeyForm({ connected, onSaved }: { connected: boolean | undefined; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!value.trim()) return;
    setBusy(true); setError(null); setSaved(false);
    try { await setCredential('openai_api_key', value.trim()); setValue(''); setSaved(true); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <p className="mb-2 text-small text-muted">
        An OpenAI API key powers memory search and live voice. It is billed per use by OpenAI, separately from a Codex subscription.{' '}
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
          Get a key at platform.openai.com <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </p>
      <div className="flex gap-2">
        <Input type="password" value={value} placeholder={connected ? 'paste a new key to replace the saved one' : 'paste your API key (sk-…)'} autoComplete="off"
          aria-label="OpenAI API key" onChange={(e) => setValue(e.target.value)} className="min-w-0 flex-1" />
        <Button size="sm" onClick={() => void save()} disabled={busy || !value.trim()}>{busy ? 'Saving…' : connected ? 'Replace' : 'Save'}</Button>
      </div>
      {saved && <p className="mt-2 inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved.</p>}
      {error && <p className="mt-2 text-small text-danger">{error}</p>}
    </div>
  );
}

function ManagePanel({ id, connected, providers, onChanged }: { id: string; connected: boolean | undefined; providers: ModelProvider[]; onChanged: () => void }) {
  const r = useModelRoles();
  if (id === 'claude') return <ClaudeLoginForm embedded />;
  if (id === 'codex') return <CodexLoginForm embedded />;
  if (id === 'xai') return <XaiLoginForm embedded />;
  if (id === 'jev') return <JevConnectForm status={r.settings?.jev} onDone={onChanged} />;
  if (id === 'openai') return <OpenAiKeyForm connected={connected} onSaved={onChanged} />;
  const provider = providers.find((p) => p.id === id);
  return provider ? <ProviderManagePanel provider={provider} /> : <p className="text-small text-muted">This account has no settings here.</p>;
}

function AccountRow({ id, label, kind, meter, now, open, onToggle, providers, onChanged, notConnectedNote, statusUnknown = false }: {
  id: string;
  label: string;
  kind: string;
  meter?: UsageMeter;
  now: number;
  open: boolean;
  onToggle: () => void;
  providers: ModelProvider[];
  onChanged: () => void;
  notConnectedNote?: string;
  statusUnknown?: boolean;
}) {
  const connected = statusUnknown ? undefined : Boolean(meter);
  const out = Boolean(meter?.outOfCredit);
  const tone = meter ? meterTone(meter) : 'ok';
  const summary = meter ? accountHeadline(meter, now) : null;
  return (
    <li id={`account-${id}`} className="scroll-mt-16 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: dotColor(id), opacity: connected || statusUnknown ? 1 : 0.35 }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn('font-semibold', connected || statusUnknown ? 'text-fg' : 'text-muted')}>{label}</span>
            {summary && <span className={cn('text-small tabular-nums', out || tone !== 'ok' ? TONE_TEXT[tone] : 'text-muted')}>{summary}</span>}
          </div>
          <div className="truncate text-caption text-muted" title={captionFor(meter, kind, notConnectedNote, now)}>{captionFor(meter, kind, notConnectedNote, now)}</div>
        </div>
        {meter && <BillingLink meter={meter} emphasis={out} />}
        <Button size="sm" variant={connected || statusUnknown ? 'ghost' : 'secondary'} onClick={onToggle} aria-expanded={open} aria-controls={`account-${id}-panel`}>
          {statusUnknown ? 'Manage connection' : connected ? 'Manage' : 'Connect'}
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      </div>
      {meter && <MeterDetail meter={meter} now={now} />}
      {open && (
        <div id={`account-${id}-panel`} className="mt-3 border-t border-border pt-3">
          <ManagePanel id={id} connected={connected} providers={providers} onChanged={onChanged} />
        </div>
      )}
    </li>
  );
}

export function ModelAccountsCard() {
  const qc = useQueryClient();
  const { meters: loadedMeters, now, ready, loading, unavailable, refreshing, retry } = useUsageMeters();
  const r = useModelRoles();
  const providers = r.settings?.modelProviders ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const onChanged = () => {
    void qc.invalidateQueries({ queryKey: ['settings'] });
    void qc.invalidateQueries({ queryKey: ['model-status'] });
    void qc.invalidateQueries({ queryKey: ['credentials'] });
  };
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));

  // Usage is a read, not the authority to reach the account's own sign-in or
  // key form. Failed/unfinished reads must never turn absence into disconnected.
  const statusUnknown = !ready || unavailable;
  const meters = statusUnknown ? [] : loadedMeters;
  const byId = new Map(meters.map((m) => [m.id, m]));
  // An API account added without a working key keeps its place here, saying
  // why its models are greyed out in the pickers, instead of vanishing.
  const unusable = (p: ModelProvider) => {
    const models = p.modelIds.length === 1 ? p.modelIds[0] : `its ${p.modelIds.length} models`;
    return p.baseURL ? `Added, but no API key is saved, so ${models} can't be used. Add the key or remove the account.`
      : `Added, but no web address is saved, so ${models} can't be used.`;
  };
  const notConnected = [
    ...SIGN_IN_ACCOUNTS.filter((a) => !byId.has(a.id)).map((a) => {
      if (statusUnknown) return a;
      const added = providers.find((p) => p.id === a.id && !p.configured && p.modelIds.length > 0);
      if (!added) return a;
      const models = added.modelIds.length === 1 ? added.modelIds[0] : `its ${added.modelIds.length} models`;
      return { ...a, what: `${a.what} · added, but not signed in and no key saved, so ${models} can't be used` };
    }),
    ...providers.filter((p) => (statusUnknown || !p.configured) && !byId.has(p.id) && !SIGN_IN_ACCOUNTS.some((a) => a.id === p.id))
      .map((p) => ({ id: p.id, label: p.label || 'API account', what: statusUnknown ? 'Saved API account' : unusable(p) })),
  ];
  // The alarm is for an account doing a job for Clem; an idle one out of
  // credit says so in its own row (2026-10-18: the same rule as the header dot).
  const refusing = meters.filter((m) => m.outOfCredit && (m.uses?.length ?? 0) > 0);
  const outCount = refusing.length;

  return (
    <div>
      {statusUnknown && <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-small text-muted">
        <span className="min-w-0 flex-1">{unavailable
          ? 'Account usage couldn’t be loaded. Your connections have not changed.'
          : loading ? 'Checking account usage. You can still manage connections below.'
            : 'Account status is not confirmed. You can still manage connections below.'}</span>
        {unavailable && <Button size="sm" variant="secondary" disabled={refreshing} onClick={retry}>{refreshing ? 'Retrying…' : 'Retry'}</Button>}
      </div>}
      {/* One alarm for one problem: it names the account and jumps to its
          row; the row itself says "Refusing requests" and offers Add credit. */}
      {outCount > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-danger/40 bg-danger-tint px-3 py-2 text-small text-danger" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            {refusing.map((m, i, all) => (
              <span key={m.id}>
                <a href={`#account-${m.id}`} className="font-semibold underline-offset-2 hover:underline">{m.label}</a>
                {i < all.length - 1 ? (i === all.length - 2 ? ' and ' : ', ') : ''}
              </span>
            ))}
            {outCount === 1 ? ' is refusing requests for lack of credit.' : ' are refusing requests for lack of credit.'}
          </span>
        </p>
      )}
      <ul className="space-y-2" aria-label="Model accounts">
        {meters.map((meter) => (
          <AccountRow key={meter.id} id={meter.id} label={meter.label} kind={accountKind(meter.id, providers)}
            meter={meter} now={now} open={open === meter.id} onToggle={() => toggle(meter.id)}
            providers={providers} onChanged={onChanged} />
        ))}
      </ul>
      <div className="mt-3">
        {adding
          ? <AddModelForm onClose={() => { setAdding(false); onChanged(); }} />
          : (
            <Button variant="secondary" size="sm" onClick={() => { setAdding(true); setOpen(null); }}>
              <Plus className="h-4 w-4" aria-hidden /> Add a model
            </Button>
          )}
        {!adding && <span className="ml-3 text-caption text-muted">Together AI, DeepSeek, GLM, Kimi, MiniMax, or any OpenAI-compatible endpoint.</span>}
      </div>
      {notConnected.length > 0 && (
        <>
          <p className="mb-2 mt-5 inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-widest text-faint">
            <KeyRound className="h-3.5 w-3.5" aria-hidden /> {statusUnknown ? 'Model connections' : 'Not connected'}
          </p>
          <ul className="space-y-2" aria-label={statusUnknown ? 'Model connections with unconfirmed status' : 'Accounts not connected'}>
            {notConnected.map((a) => (
              <AccountRow key={a.id} id={a.id} label={a.label} kind="" now={now} open={open === a.id}
                onToggle={() => toggle(a.id)} providers={providers} onChanged={onChanged} statusUnknown={statusUnknown}
                notConnectedNote={statusUnknown ? `${a.what} · status not confirmed` : a.what} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
