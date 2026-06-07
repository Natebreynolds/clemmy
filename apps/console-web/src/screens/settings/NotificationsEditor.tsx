import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trash2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import {
  listDestinations, addDestination, testDestination, toggleDestination, deleteDestination,
  type DestinationType,
} from '@/lib/notifications';

const TYPE_LABEL: Record<DestinationType, string> = {
  discord_webhook: 'Discord webhook',
  discord_channel: 'Discord channel',
  discord_user: 'Discord DM',
};

export function NotificationsEditor() {
  const qc = useQueryClient();
  const dests = usePoll(['notif-destinations'], listDestinations, 0);
  const rows = dests.data?.destinations ?? [];

  const [name, setName] = useState('');
  const [type, setType] = useState<DestinationType>('discord_webhook');
  const [url, setUrl] = useState('');
  const [channelId, setChannelId] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['notif-destinations'] });

  const add = async () => {
    if (!name.trim()) return;
    setBusy('add'); setError('');
    try {
      await addDestination({
        name: name.trim(), type, enabled: true,
        url: type === 'discord_webhook' ? url.trim() : undefined,
        channel_id: type === 'discord_channel' ? channelId.trim() : undefined,
        user_id: type === 'discord_user' ? userId.trim() : undefined,
      });
      setName(''); setUrl(''); setChannelId(''); setUserId('');
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Notifications</h3>
      <p className="mb-4 text-small text-muted">Where Clementine sends updates and reports.</p>

      {dests.isLoading ? <Skeleton className="h-20 w-full" /> : rows.length > 0 && (
        <ul className="mb-5 space-y-2">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium text-fg">{d.name}</div>
                <div className="text-caption text-faint">{TYPE_LABEL[d.type] ?? d.type}</div>
              </div>
              <StatusPill tone={d.enabled ? 'success' : 'neutral'}>{d.enabled ? 'On' : 'Off'}</StatusPill>
              <Switch checked={!!d.enabled} onChange={async (v) => { setBusy(d.id); try { await toggleDestination(d.id, v); } finally { setBusy(null); refresh(); } }} label={`Toggle ${d.name}`} />
              <Button variant="ghost" size="icon" aria-label="Test" title="Send a test" disabled={busy === d.id} onClick={async () => { setBusy(d.id); try { await testDestination(d.id); } finally { setBusy(null); } }}>
                {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
              </Button>
              <Button variant="ghost" size="icon" aria-label="Delete" title="Delete" onClick={async () => { await deleteDestination(d.id); refresh(); }}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. My Discord)" aria-label="Destination name" />
        <Select value={type} onChange={(e) => setType(e.target.value as DestinationType)} aria-label="Destination type">
          <option value="discord_webhook">Discord webhook</option>
          <option value="discord_channel">Discord channel</option>
          <option value="discord_user">Discord DM</option>
        </Select>
        {type === 'discord_webhook' && <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Webhook URL" aria-label="Webhook URL" className="sm:col-span-2" />}
        {type === 'discord_channel' && <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="Channel ID" aria-label="Channel ID" className="sm:col-span-2" />}
        {type === 'discord_user' && <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Your Discord user ID" aria-label="User ID" className="sm:col-span-2" />}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={add} disabled={busy === 'add' || !name.trim()}>
          {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add destination
        </Button>
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </Card>
  );
}
