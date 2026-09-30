import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Loader2, Plug } from 'lucide-react';
import { api } from '@/lib/api';
import { authorizeComposio, type ComposioConnectResult } from '@/lib/connect';
import { AppSetupFormView, type AppSetupForm } from '@/components/connect/AppConnectionSetup';
import { Button } from '@/components/ui/Button';

export interface ConnectionResume { connectionRequestId: string; clientRequestId: string }
interface ConnectionRequest {
  requestId: string; sessionId: string; sourceUserSeq: number;
  toolkit: string; capability: string; continueLabel: string;
  awaitingSignIn: boolean; clientRequestId: string; continuationBlocker?: string;
}

/** Setup is a host-observed dependency of this question, never inferred from
 * model prose. The original answer choices remain usable until proven. */
export function ConnectionSetup({ sessionId, options, revision, onContinue, fallback, renderOtherAnswers }: {
  sessionId: string; options: string[]; revision?: string;
  onContinue: (text: string, resume: ConnectionResume) => Promise<void> | void;
  fallback: ReactNode; renderOtherAnswers: (options: string[]) => ReactNode;
}) {
  const [request, setRequest] = useState<ConnectionRequest | null>(null);
  const [form, setForm] = useState<AppSetupForm | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'check' | null>(null);
  const [verified, setVerified] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const identity = JSON.stringify([sessionId, options]);
  const generation = useRef(0);
  const checking = useRef(false);
  const continuing = useRef(false);
  const current = useRef({ request, options, onContinue });
  current.current = { request, options, onContinue };

  async function verify(pending = current.current.request) {
    if (!pending || checking.current || continuing.current) return;
    const ownGeneration = generation.current;
    checking.current = true;
    setBusy('check'); setError('');
    try {
      const result = await api<{ request: ConnectionRequest | null; ready: boolean; connectionVerified?: true }>(
        `/api/connection-requests/${encodeURIComponent(pending.requestId)}/verify`,
        { method: 'POST', cache: 'no-store', body: JSON.stringify({ sessionId }) },
      );
      if (ownGeneration !== generation.current) return;
      const fresh = result.request;
      if (!fresh || fresh.requestId !== pending.requestId || fresh.sessionId !== pending.sessionId
        || fresh.sourceUserSeq !== pending.sourceUserSeq || fresh.capability !== pending.capability
        || fresh.clientRequestId !== pending.clientRequestId || !current.current.options.includes(fresh.continueLabel)) {
        setRequest(null); setForm(null); setUrl(null); setVerified(false); return;
      }
      setRequest(fresh);
      setVerified(result.ready || Boolean(result.connectionVerified));
      if (result.ready || result.connectionVerified) { setForm(null); setUrl(null); }
      if (result.ready) {
        continuing.current = true;
        setForm(null); setUrl(null); setNote('Connected. Continuing your request…');
        try { await current.current.onContinue(fresh.continueLabel, {
          connectionRequestId: fresh.requestId, clientRequestId: fresh.clientRequestId,
        }); } catch (err) { continuing.current = false; throw err; }
      } else setNote(result.connectionVerified && fresh.continuationBlocker
        ? `Connection verified. ${fresh.continuationBlocker}`
        : 'Sign-in is not finished yet. Your request is saved here.');
    } catch (err) {
      if (ownGeneration === generation.current) {
        setVerified(false); setNote('');
        setError(err instanceof Error ? err.message : 'Could not check this connection. Try again.');
      }
    } finally {
      if (ownGeneration === generation.current) { checking.current = false; setBusy(null); }
    }
  }

  useEffect(() => {
    const ownGeneration = ++generation.current;
    setRequest(null); setForm(null); setUrl(null); setNote(''); setError(''); setBusy(null); setVerified(false);
    checking.current = false; continuing.current = false;
    void api<{ request: ConnectionRequest | null }>(`/api/connection-requests?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      .then(({ request: found }) => {
        if (ownGeneration !== generation.current || !found || found.sessionId !== sessionId || !options.includes(found.continueLabel)) return;
        setRequest(found);
        if (found.awaitingSignIn) void verify(found);
      }).catch(() => { /* A failed lookup does not prove that setup is needed. */ });
    return () => { generation.current++; };
    // A terminal event can park the dependency after its question was streamed.
  }, [identity, revision]);

  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible' && current.current.request?.awaitingSignIn) void verify(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [identity]);

  if (!request) return fallback;
  const context = { connectionRequestId: request.requestId, sessionId };
  const name = request.toolkit.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const formGeneration = generation.current;
  async function authorized(result: ComposioConnectResult) {
    if (formGeneration !== generation.current || current.current.request?.requestId !== request?.requestId) return;
    if (result.kind === 'credentials' || result.kind === 'details') {
      setForm({ kind: result.kind, slug: request!.toolkit, setup: result.setup }); return;
    }
    if (result.kind === 'oauth_app') { setForm({ kind: result.kind, slug: request!.toolkit, app: result.app }); return; }
    if (result.kind === 'no_auth') { setNote('This app needs no sign-in. Checking the connection…'); await verify(); return; }
    const value = result.url || result.redirectUrl;
    let safe: URL;
    try { safe = new URL(value ?? ''); } catch { setError('No sign-in link was returned. Try connecting again.'); return; }
    if (!['https:', 'http:'].includes(safe.protocol) || safe.username || safe.password) { setError('The sign-in link could not be opened. Try again.'); return; }
    setForm(null); setUrl(safe.href);
    setRequest((prior) => prior ? { ...prior, awaitingSignIn: true } : null);
    setNote(request?.continuationBlocker
      ? 'Finish signing in, then return here to check the connection. Your reviewed execution stays paused.'
      : 'Finish signing in, then return here. Clem will check the connection and continue.');
    window.open(safe.href, '_blank', 'noopener,noreferrer');
  }
  async function connect() {
    if (busy || checking.current || continuing.current) return;
    const ownGeneration = generation.current;
    setBusy('connect'); setError(''); setVerified(false); setNote('');
    try {
      const result = await authorizeComposio(request!.toolkit, undefined, context);
      if (ownGeneration === generation.current) await authorized(result);
    } catch (err) { if (ownGeneration === generation.current) setError(err instanceof Error ? err.message : 'Could not start sign-in. Try again.'); }
    finally { if (ownGeneration === generation.current) setBusy(null); }
  }
  return <section className="mt-4 space-y-3" aria-label={`Connect ${name} for this request`}>
    {form ? <AppSetupFormView key={`${request.requestId}:${form.kind}`} form={form} presentation="inline"
      connectionContext={context} onClose={() => setForm(null)} onAuthorized={authorized}
      onSaved={async () => {
        if (formGeneration !== generation.current || current.current.request?.requestId !== request.requestId) return;
        setForm(null); await verify(request);
      }} /> : <>
      <div className="flex items-start gap-3">
        <Plug className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div><p className="text-small font-medium text-fg">{verified ? `${name} connected` : `Connect ${name} to continue`}</p>
          {!verified && <p className="mt-1 text-small text-muted">{request.continuationBlocker
            ? 'Connect this app to resolve the missing connection. Your reviewed execution stays paused.'
            : 'Your request stays here. Clem will continue once this account is verified.'}</p>}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy !== null || continuing.current} onClick={() => { void (request.awaitingSignIn || verified ? verify() : connect()); }}>
          {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {continuing.current ? 'Continuing…' : busy === 'connect' ? 'Preparing sign-in…' : busy === 'check' ? 'Checking…' : verified ? 'Recheck connection' : request.awaitingSignIn ? 'Check connection' : `Connect ${name}`}
        </Button>
        {url && <a className="inline-flex items-center gap-1 text-small text-primary underline underline-offset-4" href={url} target="_blank" rel="noopener noreferrer">Open sign-in<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
        {request.awaitingSignIn && !verified && <Button size="sm" variant="ghost" disabled={busy !== null || continuing.current} onClick={() => { void connect(); }}>Start sign-in again</Button>}
      </div>
    </>}
    {note && <p className="text-caption text-muted" role="status">{note}</p>}
    {error && <p className="text-small text-danger" role="alert">{error}</p>}
    {renderOtherAnswers(options.filter((option) => option !== request.continueLabel))}
  </section>;
}
