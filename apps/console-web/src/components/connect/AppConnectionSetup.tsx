import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Plug, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import {
  authorizeComposio, setupComposioCredentials, setupComposioOAuthApp,
  type ComposioConnectResult, type ComposioSetupMeta, type ComposioSetupField, type ComposioOAuthAppSetup,
} from '@/lib/connect';

/** The three things Clem can ask for in its own window, so connecting an app
 *  never sends the person to Composio's site. */
export type AppSetupForm =
  | { kind: 'credentials'; slug: string; setup: ComposioSetupMeta }
  | { kind: 'details'; slug: string; setup: ComposioSetupMeta }
  | { kind: 'oauth_app'; slug: string; app: ComposioOAuthAppSetup };

const GENERIC_KEY_FIELD: ComposioSetupField = { name: 'generic_api_key', label: 'API Key', description: null, default: null, isSecret: true, required: true };

function SetupFields({ fields, values, onChange, onEnter, autoFocus }: {
  fields: ComposioSetupField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onEnter: () => void;
  autoFocus: boolean;
}) {
  return (
    <>
      {fields.map((field, index) => (
        <label key={field.name} className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">
            {field.label || field.name}
            {field.required !== false && <span className="text-danger"> *</span>}
          </span>
          <Input
            type={field.isSecret || /secret|token|password|api_key/i.test(field.name) ? 'password' : 'text'}
            value={values[field.name] ?? ''}
            onChange={(event) => onChange(field.name, event.target.value)}
            autoFocus={autoFocus && index === 0}
            autoComplete="off"
            placeholder={field.default ?? ''}
            onKeyDown={(event) => { if (event.key === 'Enter') onEnter(); }}
          />
          {field.description && <span className="text-caption text-faint">{field.description}</span>}
        </label>
      ))}
    </>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-fg">{label}</span>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} aria-label={label} className="flex-1 font-mono text-caption" onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" variant="secondary" onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
        }}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : null}{copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export type AppConnectionSavedResult = Awaited<ReturnType<typeof setupComposioCredentials>>;

export interface AppSetupFormViewProps {
  form: AppSetupForm;
  onClose: () => void;
  /** Credentials saved: the exact account connection returned by the existing API. */
  onSaved: (result: AppConnectionSavedResult) => void | Promise<void>;
  /** A sign-in link is ready: open it. */
  onAuthorized: (res: ComposioConnectResult) => void;
  /** Inline keeps setup inside its calling surface; Connect retains the dialog. */
  presentation?: 'inline' | 'dialog';
  /** Lets the server bind its returned connection to the original task. */
  connectionContext?: { connectionRequestId: string; sessionId: string };
}

export function AppSetupFormView({ form, onClose, onSaved, onAuthorized, presentation = 'dialog', connectionContext }: AppSetupFormViewProps) {
  const isDialog = presentation === 'dialog';
  const name = form.kind === 'oauth_app' ? form.app.name : form.setup.name;
  // Developer-app fields: the redirect address is shown to copy, not typed.
  const appFields = form.kind === 'oauth_app'
    ? form.app.fields.filter((f) => !/redirect/i.test(f.name))
    : [];
  const requiredAppFields = appFields.filter((f) => f.required !== false);
  const optionalAppFields = appFields.filter((f) => f.required === false);
  const accountFields = form.kind === 'oauth_app'
    ? form.app.accountFields
    : form.setup.fields.length > 0 || form.kind === 'details' ? form.setup.fields : [GENERIC_KEY_FIELD];
  const allFields = [...appFields, ...accountFields];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(allFields.map((field) => [field.name, field.default ?? ''])),
  );
  const [showOptional, setShowOptional] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isDialog) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, isDialog, onClose]);

  const pick = (fields: ComposioSetupField[]) =>
    Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? '').trim()]).filter(([, v]) => v));
  const missingRequired = allFields.some((field) => field.required !== false && !(values[field.name] ?? '').trim());
  const submit = async () => {
    if (busy || missingRequired) return;
    setBusy(true);
    setError('');
    try {
      if (form.kind === 'credentials') {
        const result = await setupComposioCredentials(form.slug, values, form.setup.authScheme, connectionContext);
        await onSaved(result);
      } else if (form.kind === 'details') {
        onAuthorized(await authorizeComposio(form.slug, pick(accountFields), connectionContext));
      } else {
        onAuthorized(await setupComposioOAuthApp(form.slug, {
          credentials: pick(appFields),
          details: pick(accountFields),
          authScheme: form.app.authScheme,
        }, connectionContext));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect this app.');
    } finally {
      setBusy(false);
    }
  };
  const setValue = (field: string, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const helpUrl = form.kind === 'oauth_app'
    ? form.app.authHintUrl || form.app.authGuideUrl || form.app.appUrl
    : form.setup.authHintUrl || form.setup.authGuideUrl || form.setup.appUrl;

  const intro = form.kind === 'credentials'
    ? 'Add the credentials here. Clementine sends them directly to Composio and does not save them in her local settings.'
    : form.kind === 'details'
      ? `${name} needs a detail about your account before you sign in.`
      : `${name} doesn’t offer a shared sign-in, so it connects through a developer app you own. You set this up once; after that, connecting more accounts is one click.`;

  return (
    <div
      className={isDialog ? 'fixed inset-0 z-[110] flex items-start justify-center bg-black/30 p-4 pt-[8vh] animate-fade-in' : undefined}
      role={isDialog ? 'dialog' : undefined}
      aria-modal={isDialog ? true : undefined}
      aria-label={`Connect ${name}`}
      onMouseDown={isDialog ? () => { if (!busy) onClose(); } : undefined}
    >
      <div
        className={isDialog
          ? 'w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-modal'
          : 'w-full overflow-hidden rounded-xl border border-border bg-surface'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="h-4 w-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-h3 text-fg">Connect {name}</h2>
            <p className="mt-0.5 text-small text-muted">{intro}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-faint hover:text-fg disabled:opacity-50" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className={isDialog ? 'max-h-[66vh] space-y-4 overflow-y-auto p-5' : 'space-y-4 p-5'}>
          {form.kind === 'oauth_app' ? (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-small text-muted">
                <li>
                  Create an app (sometimes called an OAuth client) in {name}’s developer settings.
                  {helpUrl && <>{' '}<a href={helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">Open {name} <ExternalLink className="h-3 w-3" aria-hidden /></a></>}
                </li>
                <li>Add the redirect address below to that app.</li>
                <li>Paste the app’s details here. Clementine creates the connection and opens {name}’s sign-in.</li>
              </ol>
              <CopyField label="Redirect address" value={form.app.callbackUrl} />
              <SetupFields fields={requiredAppFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus />
              {optionalAppFields.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowOptional((v) => !v)} className="text-caption font-medium text-muted hover:text-fg">
                    {showOptional ? 'Hide' : 'Show'} optional settings ({optionalAppFields.map((f) => f.label || f.name).join(', ')})
                  </button>
                  {showOptional && <div className="mt-3 space-y-4"><SetupFields fields={optionalAppFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus={false} /></div>}
                </div>
              )}
              {accountFields.length > 0 && <SetupFields fields={accountFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus={false} />}
            </>
          ) : (
            <>
              <SetupFields fields={accountFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus />
              {helpUrl && (
                <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-small text-primary hover:underline">
                  Where to find {form.kind === 'details' ? 'this' : 'these credentials'} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              )}
            </>
          )}

          {error && <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || missingRequired}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}
            {busy ? 'Connecting…' : form.kind === 'credentials' ? 'Connect' : form.kind === 'details' ? 'Continue to sign in' : 'Save and sign in'}
          </Button>
        </div>
      </div>
    </div>
  );
}
