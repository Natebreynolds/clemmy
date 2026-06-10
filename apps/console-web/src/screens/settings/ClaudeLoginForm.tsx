import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { usePoll } from '@/lib/poll';
import { getSettings, beginClaudeLogin, completeClaudeLogin } from '@/lib/settings';

/**
 * In-app Claude (Anthropic) subscription login — PKCE paste-the-code.
 * "Sign in to Claude" → opens the authorize page → user approves + pastes the
 * code → we exchange it for an oat01 subscription token (stored in our vault,
 * decoupled from Claude Code). Billed to the Claude plan, never an API key.
 */
export function ClaudeLoginForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const claude = settings.data?.claudeAuth;
  const [flowId, setFlowId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = async () => {
    setBusy(true); setError(null); setDone(false);
    try {
      const r = await beginClaudeLogin();
      setFlowId(r.flowId); setAuthorizeUrl(r.authorizeUrl);
      window.open(r.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const complete = async () => {
    if (!flowId) return;
    setBusy(true); setError(null);
    try {
      await completeClaudeLogin(flowId, code.trim());
      setDone(true); setFlowId(null); setAuthorizeUrl(null); setCode('');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const cancel = () => { setFlowId(null); setAuthorizeUrl(null); setCode(''); setError(null); };

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Claude (Anthropic) brain</h3>
      <p className="mb-4 text-small text-muted">
        Sign in with your Claude Max/Pro subscription to run Clementine on Claude — billed to your Claude plan’s agent usage, never a pay-per-token API key.
      </p>

      <div className="mb-4 rounded-lg border border-border bg-canvas p-3 text-small">
        {claude?.configured
          ? <span className="inline-flex items-center gap-1 text-success">
              <Check className="h-4 w-4" aria-hidden /> Signed in{claude.plan ? ` (${claude.plan})` : ''} · subscription billing ✓{claude.expiresAt ? ` · valid until ${new Date(claude.expiresAt).toLocaleString()}` : ''}
            </span>
          : <span className="text-muted">Not signed in. {claude?.reason || 'Connect your Claude subscription below.'}</span>}
      </div>

      {!flowId ? (
        <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : (claude?.configured ? 'Re-sign in to Claude' : 'Sign in to Claude')}</Button>
      ) : (
        <div>
          <p className="mb-2 text-small text-muted">
            A Claude authorize page opened in a new tab — approve, copy the code it shows, and paste it here.
            {authorizeUrl ? <> (<a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">reopen <ExternalLink className="inline h-3 w-3" aria-hidden /></a>)</> : null}
          </p>
          <Field label="Authorization code" hint="From the Claude page — the format may be code#state; paste the whole thing.">{(id) => (
            <Input id={id} value={code} placeholder="paste the code" onChange={(e) => setCode(e.target.value)} />
          )}</Field>
          <div className="flex items-center gap-3">
            <Button onClick={complete} disabled={busy || !code.trim()}>{busy ? 'Verifying…' : 'Complete sign-in'}</Button>
            <Button variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-1">
        {done && <p className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Signed in. Set the brain to Claude (AUTH_MODE=claude_oauth) to run on it.</p>}
        {error && <p className="inline-flex items-center gap-1 text-small text-danger"><AlertTriangle className="h-4 w-4" aria-hidden /> {error}</p>}
      </div>
    </Card>
  );
}
