import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  connectionFormFields, connectionSetupApi, continueVerifiedConnection, matchingConnectionRequest, safeConnectionUrl,
  type ConnectionAuthorization, type ConnectionContinuation, type ConnectionForm, type ConnectionRequest, type SetupField,
} from '../lib/connection-setup';

export interface ConnectionSetupProps {
  sessionId: string;
  options: string[];
  revision?: string;
  onContinue: ConnectionContinuation;
  fallback?: ComponentChildren;
  renderOtherAnswers?: (options: string[]) => ComponentChildren;
}

/** A changed conversation/question discards form secrets and retires its async
 * work before another task can inherit the connection or continuation. */
export function ConnectionSetup(props: ConnectionSetupProps) {
  return <ConnectionSetupSession key={JSON.stringify([props.sessionId, props.options, props.revision])} {...props} />;
}

type Work = 'load' | 'connect' | 'check' | 'submit';

function ConnectionSetupSession({ sessionId, options, onContinue, fallback, renderOtherAnswers }: ConnectionSetupProps) {
  const [request, setRequest] = useState<ConnectionRequest | null>(null);
  const [form, setForm] = useState<ConnectionForm | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<Work | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [verifiedConnection, setVerifiedConnection] = useState(false);
  const [accountLabel, setAccountLabel] = useState<string | null>(null);
  const alive = useRef(true);
  const pending = useRef<ConnectionRequest | null>(null);
  const inFlight = useRef(false);
  const continued = useRef(new Set<string>());
  const continueRef = useRef(onContinue);
  continueRef.current = onContinue;

  function adopt(candidate: ConnectionRequest | null) {
    const next = matchingConnectionRequest(candidate, sessionId, options);
    if (next?.requestId !== pending.current?.requestId) {
      setForm(null);
      setSignInUrl(null);
      setMessage('');
      setVerifiedConnection(false);
      setAccountLabel(null);
    }
    pending.current = next;
    setRequest(next);
    return next;
  }

  async function verify(current: ConnectionRequest) {
    setBusy('check');
    setMessage('');
    setVerifiedConnection(false);
    setAccountLabel(null);
    const result = await connectionSetupApi.verify(current);
    if (!alive.current || pending.current?.requestId !== current.requestId) return;
    const verified = adopt(result.request);
    if (!verified || verified.requestId !== current.requestId) return;
    setVerifiedConnection(result.ready || Boolean(result.connectionVerified));
    setAccountLabel(result.ready || result.connectionVerified ? result.verifiedAccount?.label ?? null : null);
    if (result.ready || result.connectionVerified) { setForm(null); setSignInUrl(null); }
    if (continued.current.has(current.clientRequestId)) return;
    // Reserve the stable host key before handing control to Chat. A failed
    // send remains retryable with this same key, never a fresh user message.
    continued.current.add(current.clientRequestId);
    try {
      const sent = await continueVerifiedConnection(current, result, options, (text, resume) => {
        if (!alive.current || pending.current?.requestId !== current.requestId) return Promise.reject(new Error('This task changed. Return to the current conversation.'));
        setForm(null);
        setSignInUrl(null);
        setMessage('Connection verified. Continuing your task…');
        return continueRef.current(text, resume);
      });
      if (!sent) {
        continued.current.delete(current.clientRequestId);
        setMessage(result.connectionVerified && verified.continuationBlocker
          ? `Connection verified. ${verified.continuationBlocker}`
          : 'The connection is not ready yet. Finish any sign-in steps, then check again.');
      }
    } catch (err) {
      continued.current.delete(current.clientRequestId);
      throw err;
    }
  }

  async function authorized(current: ConnectionRequest, result: ConnectionAuthorization) {
    if (!alive.current || pending.current?.requestId !== current.requestId) return;
    if (result.kind === 'credentials' || result.kind === 'details' || result.kind === 'oauth_app') {
      setForm(result);
      setSignInUrl(null);
      setMessage('');
      return;
    }
    setForm(null);
    if (result.kind === 'no_auth') {
      setSignInUrl(null);
      await verify(current);
      return;
    }
    const url = safeConnectionUrl(result.url || result.redirectUrl);
    if (!url) throw new Error('A usable sign-in link was not returned. Try connecting again.');
    adopt({ ...current, awaitingSignIn: true });
    setSignInUrl(url);
    setMessage(current.continuationBlocker
      ? 'Open the sign-in page, then return here to check the connection. Your reviewed execution stays paused.'
      : 'Open the sign-in page, then return here. Clem will check the connection before continuing.');
  }

  async function run(work: Work, values?: Record<string, string>) {
    if (!alive.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(work);
    setError(null);
    try {
      if (work === 'load') {
        const response = await connectionSetupApi.load(sessionId);
        if (!alive.current) return;
        const current = adopt(response.request);
        if (current?.awaitingSignIn && !form) await verify(current);
        return;
      }
      const current = pending.current;
      if (!current || !matchingConnectionRequest(current, sessionId, options)) return;
      if (work === 'check') {
        await verify(current);
      } else if (work === 'connect') {
        setVerifiedConnection(false); setAccountLabel(null); setMessage('');
        await authorized(current, await connectionSetupApi.authorize(current));
      } else if (form && values) {
        const result = await connectionSetupApi.submit(current, form, values);
        if (!alive.current || pending.current?.requestId !== current.requestId) return;
        if (form.kind === 'credentials') {
          setForm(null);
          adopt({ ...current, awaitingSignIn: true });
          await verify(current);
        } else {
          await authorized(current, result as ConnectionAuthorization);
        }
      }
    } catch (err) {
      if (alive.current) {
        setVerifiedConnection(false);
        setAccountLabel(null);
        setMessage('');
        setError(err instanceof Error ? err.message : 'Could not check this connection. Try again.');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  }

  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    alive.current = true;
    void runRef.current('load');
    const recover = () => {
      if (document.visibilityState === 'visible') void runRef.current('load');
    };
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, []);

  // The host owns whether this is an app-connection question. Ordinary chat
  // options and arbitrary model prose must never create a setup panel.
  if (!request || !matchingConnectionRequest(request, sessionId, options)) return <>{fallback}</>;
  const name = form ? (form.kind === 'oauth_app' ? form.app.name : form.setup.name)
    : request.toolkit.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const done = continued.current.has(request.clientRequestId);
  return (
    <section class="card stack" aria-label={`Connect ${name} for this task`} style={{ overflowWrap: 'anywhere' }}>
      <div>
        <h3 class="card-title">{busy === 'check' ? `Checking ${name}` : verifiedConnection ? `${name} connected` : `Connect ${name}`}</h3>
        {verifiedConnection && <p class="card-note">{accountLabel
          ? <>Verified account: <strong>{accountLabel}</strong></>
          : 'The provider did not return an account name.'}</p>}
        {!verifiedConnection && <p class="card-note">{request.continuationBlocker
          ? 'Connect this app to resolve the missing connection. Your reviewed execution stays paused.'
          : 'Your task is waiting for this app. Once the connection is verified, Clem can continue where she left off.'}</p>}
      </div>
      {error && <div class="screen-notice screen-notice-error" role="alert"><span class="screen-notice-text">{error}</span></div>}
      {message && <p class="card-note" role="status">{message}</p>}
      {busy === 'load' || busy === 'check' ? <p class="card-note" role="status">Checking the connection…</p> : null}
      {busy === 'connect' || busy === 'submit' ? <p class="card-note" role="status">{busy === 'connect' ? 'Preparing sign-in…' : 'Saving connection details…'}</p> : null}
      {form ? (
        <ConnectionSetupForm
          key={`${request.requestId}:${form.kind}`}
          form={form}
          busy={busy !== null}
          onSubmit={(values) => void run('submit', values)}
          onCancel={() => { setForm(null); setError(null); }}
        />
      ) : !done ? (
        <div class="stack">
          {signInUrl ? (
            <a class="btn" style={{ display: 'block', textAlign: 'center' }} href={signInUrl} target="_blank" rel="noopener noreferrer">Open {name} sign-in</a>
          ) : (
            <button class="btn" type="button" disabled={busy !== null} onClick={() => void run(request.awaitingSignIn || verifiedConnection ? 'check' : 'connect')}>
              {busy === 'connect' ? 'Preparing sign-in…' : busy === 'check' ? 'Checking…' : verifiedConnection ? 'Recheck connection' : request.awaitingSignIn ? 'Check connection' : `Connect ${name}`}
            </button>
          )}
          {(signInUrl || (!request.awaitingSignIn && error)) && <button class="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => void run('check')}>Check again</button>}
          {request.awaitingSignIn && !signInUrl && !verifiedConnection && <button class="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => void run('connect')}>Start sign-in again</button>}
        </div>
      ) : null}
      {renderOtherAnswers?.(options.filter((option) => option !== request.continueLabel))}
    </section>
  );
}

export function ConnectionSetupForm({ form, busy, onSubmit, onCancel }: {
  form: ConnectionForm;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const { appFields, accountFields, allFields } = connectionFormFields(form);
  const meta = form.kind === 'oauth_app' ? form.app : form.setup;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(allFields.map((field) => [field.name, field.default ?? ''])));
  const [copyStatus, setCopyStatus] = useState('');
  const help = safeConnectionUrl(meta.authHintUrl || meta.authGuideUrl || meta.appUrl);
  const optionalFields = appFields.filter((field) => field.required === false);
  const missingRequired = allFields.some((field) => field.required !== false && !values[field.name]?.trim());
  function fields(items: SetupField[]) {
    return items.map((field) => (
      <label class="agent-field" key={field.name}>
        <span>{field.label || field.name}{field.required !== false ? ' *' : ' (optional)'}</span>
        <input
          type={field.isSecret || /secret|token|password|api_key/i.test(field.name) ? 'password' : 'text'}
          value={values[field.name] ?? ''}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setValues((previous) => ({ ...previous, [field.name]: value }));
          }}
          required={field.required !== false}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellcheck={false}
        />
        {field.description && <small class="card-note">{field.description}</small>}
      </label>
    ));
  }
  return (
    <form class="stack" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (!busy && !missingRequired) onSubmit(values); }}>
      <p class="card-note">{form.kind === 'credentials'
        ? 'Enter the credentials here. They go directly to the connection service and are not sent in chat.'
        : form.kind === 'details' ? `${meta.name} needs a detail about your account before sign-in.`
          : `This app needs a developer app you own. Create it in ${meta.name}, add the redirect address below, then enter its details here.`}</p>
      {help && <a class="btn btn-ghost" style={{ display: 'block', textAlign: 'center' }} href={help} target="_blank" rel="noopener noreferrer">{form.kind === 'oauth_app' ? `Open ${meta.name} setup guide` : 'Where to find these details'}</a>}
      {form.kind === 'oauth_app' && (
        <>
          <label class="agent-field">
            <span>Redirect address</span>
            <input readOnly value={form.app.callbackUrl} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <button class="btn btn-ghost" type="button" onClick={() => {
            if (!navigator.clipboard) { setCopyStatus('Select the address above to copy it.'); return; }
            void navigator.clipboard.writeText(form.app.callbackUrl).then(() => setCopyStatus('Redirect address copied.'), () => setCopyStatus('Could not copy. Select the address above to copy it.'));
          }}>Copy redirect address</button>
          {copyStatus && <p class="card-note" role="status">{copyStatus}</p>}
          {fields(appFields.filter((field) => field.required !== false))}
          {optionalFields.length > 0 && <details><summary style={{ minHeight: 44, paddingBlock: 12 }}>Optional settings</summary><div class="stack">{fields(optionalFields)}</div></details>}
        </>
      )}
      {fields(accountFields)}
      <button class="btn" type="submit" disabled={busy || missingRequired}>{busy ? 'Connecting…' : form.kind === 'credentials' ? 'Save and check connection' : 'Continue to sign in'}</button>
      <button class="btn btn-ghost" type="button" disabled={busy} onClick={onCancel}>Cancel setup</button>
    </form>
  );
}
