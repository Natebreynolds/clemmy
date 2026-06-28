import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Slack, Copy, Check, ExternalLink, Radio } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  getCredentials, getSlackStatus, setCredential, setSlackOwner,
  normalizeCredentialRows, isConnected,
} from '@/lib/connect';

/**
 * Guided "Connect Slack" panel — two-way chat via a Slack app in Socket Mode.
 * Five steps: create from manifest → install → paste 2 tokens → set member ID
 * → live status. The generic credential cards for slack_bot_token /
 * slack_app_token also auto-render in "Keys & accounts" as a fallback; this
 * panel adds the manifest + ordering + restart guidance that make it easy.
 */
export function SlackConnect() {
  const qc = useQueryClient();
  const status = usePoll(['slack-status'], getSlackStatus, 15000);
  const creds = usePoll(['credentials'], getCredentials, 20000);

  const rows = normalizeCredentialRows(creds.data?.rows);
  const botRow = rows.find((r) => r.name === 'slack_bot_token');
  const appRow = rows.find((r) => r.name === 'slack_app_token');
  const botSet = botRow ? isConnected(botRow) : false;
  const appSet = appRow ? isConnected(appRow) : false;
  const bothSet = botSet && appSet;
  const allowlist = (creds.data?.slackAllowedUsers ?? '').trim();
  const connected = Boolean(status.data?.connected);

  const onSaved = () => {
    qc.invalidateQueries({ queryKey: ['credentials'] });
    qc.invalidateQueries({ queryKey: ['slack-status'] });
  };

  const pill = connected
    ? <StatusPill tone="live" icon={Radio}>Listening{status.data?.teamName ? ` · ${status.data.teamName}` : ''}</StatusPill>
    : bothSet
      ? <StatusPill tone="success">Connected · restart to listen</StatusPill>
      : (botSet || appSet)
        ? <StatusPill tone="warning">Action needed</StatusPill>
        : <StatusPill tone="neutral">Not set up</StatusPill>;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Slack className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Connect Slack</h3>
          <p className="text-small text-muted">Two-way chat in Slack (DMs + @mentions). ~2 minutes, no public URL needed.</p>
        </div>
        {pill}
      </div>

      <Card className="space-y-5 p-4">
        <Step n={1} title="Create the app from our manifest" done={bothSet}>
          <p className="mb-2 text-caption text-faint">
            Open Slack’s app builder, choose <strong>From a manifest</strong>, pick your workspace, and paste this:
          </p>
          <div className="mb-2 rounded-md border border-warning/40 bg-warning-tint px-3 py-2 text-caption text-warning">
            <strong>Select the YAML tab before pasting.</strong> Slack’s manifest editor defaults to <strong>JSON</strong> — pasting this YAML there shows a “Fix errors on line 1” error. (Already have a Slack app? Open it → <strong>App Manifest</strong> → <strong>YAML</strong> tab → replace &amp; Save, then reinstall.)
          </div>
          <ManifestBlock manifest={status.data?.manifest} />
          <div className="mt-2 flex gap-2">
            <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary"><ExternalLink className="h-4 w-4" aria-hidden /> Open api.slack.com</Button>
            </a>
          </div>
        </Step>

        <Step n={2} title="Install to your workspace" done={bothSet}>
          <p className="text-caption text-faint">In the app: <strong>Install App → Allow</strong>. Then generate an app-level token under <strong>Basic Information → App-Level Tokens</strong> with scope <code>connections:write</code>.</p>
        </Step>

        <Step n={3} title="Paste your two tokens" done={bothSet}>
          <TokenInput
            label="Bot token (xoxb-)" name="slack_bot_token" placeholder="xoxb-…"
            set={botSet} onSaved={onSaved}
          />
          <TokenInput
            label="App-level token (xapp-)" name="slack_app_token" placeholder="xapp-…"
            set={appSet} onSaved={onSaved}
          />
        </Step>

        <Step n={4} title="Who can talk to Clementine?" done={allowlist.length > 0}>
          <p className="mb-2 text-caption text-faint">The bot stays mute until your member ID is here. In Slack: <strong>Profile → ⋮ → Copy member ID</strong>.</p>
          <SlackOwnerField initial={allowlist} onSaved={onSaved} />
        </Step>

        <Step n={5} title="Status" done={connected}>
          <p className="text-caption text-faint">
            {connected
              ? `Connected${status.data?.botUserId ? ` as ${status.data.botUserId}` : ''} and listening. DM the bot or @mention it in a channel you’ve invited it to.`
              : bothSet
                ? 'Tokens saved. Restart Clementine to connect, then DM the bot to test.'
                : 'Finish steps 1–3 to connect.'}
          </p>
        </Step>
      </Card>
    </section>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${done ? 'bg-primary text-white' : 'bg-subtle text-muted'}`}>
        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-body font-medium text-fg">{title}</div>
        {children}
      </div>
    </div>
  );
}

function ManifestBlock({ manifest }: { manifest?: string }) {
  const [copied, setCopied] = useState(false);
  if (!manifest) {
    return <p className="text-caption text-faint">Start the Clementine daemon to load the manifest, or run <code>clementine slack scopes</code>.</p>;
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(manifest); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="relative">
      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-subtle p-3 text-caption text-muted"><code>{manifest}</code></pre>
      <Button size="sm" variant="secondary" className="absolute right-2 top-2" onClick={copy}>
        {copied ? <><Check className="h-4 w-4" aria-hidden /> Copied</> : <><Copy className="h-4 w-4" aria-hidden /> Copy manifest</>}
      </Button>
    </div>
  );
}

function TokenInput({ label, name, placeholder, set, onSaved }: {
  label: string; name: string; placeholder: string; set: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!value.trim()) return;
    setSaving(true); setError('');
    try { await setCredential(name, value.trim()); setValue(''); setEditing(false); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-caption text-muted">{label}</span>
        <StatusPill tone={set ? 'success' : 'neutral'}>{set ? 'Saved' : 'Needed'}</StatusPill>
        {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{set ? 'Update' : 'Set'}</Button>}
      </div>
      {editing && (
        <div className="mt-2 flex gap-2">
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={label} className="flex-1" />
          <Button size="sm" onClick={save} disabled={saving || !value.trim()}>{saving ? '…' : <Check className="h-4 w-4" aria-hidden />}</Button>
        </div>
      )}
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  );
}

function SlackOwnerField({ initial, onSaved }: { initial: string; onSaved: () => void }) {
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    setSaving(true); setMsg(''); setError('');
    try { await setSlackOwner(val.trim()); setMsg('Saved — applies on restart'); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div>
      <div className="flex gap-2">
        <Input value={val} onChange={(e) => { setVal(e.target.value); setMsg(''); }} placeholder="e.g. U01ABCDEF (comma-separate for more)" aria-label="Slack member ID" className="flex-1" />
        <Button size="sm" onClick={save} disabled={saving || val.trim() === initial.trim()}>{saving ? '…' : 'Save'}</Button>
      </div>
      {msg && <p className="mt-1 text-caption text-success">{msg}</p>}
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  );
}
