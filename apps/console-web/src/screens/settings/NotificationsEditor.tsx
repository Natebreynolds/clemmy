import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock3, Hash, Loader2, MessageCircle, PencilLine, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import {
  listDestinations, addDestination, testDestination, toggleDestination, deleteDestination, getNotificationDoctor,
  type DeliveryReceipt, type DeliverySurfaceHealth, type DestinationType, type NotificationDestination, type NotificationDoctor,
} from '@/lib/notifications';

const TYPE_LABEL: Record<DestinationType, string> = {
  generic_webhook: 'Generic webhook',
  discord_webhook: 'Discord webhook',
  discord_channel: 'Discord channel',
  discord_user: 'Discord DM',
  slack_webhook: 'Slack webhook',
  slack_channel: 'Slack channel',
  slack_user: 'Slack DM',
};

export function NotificationsEditor() {
  const qc = useQueryClient();
  const dests = usePoll(['notif-destinations'], listDestinations, 0);
  const doctor = usePoll(['notif-doctor'], getNotificationDoctor, 8000);
  const rows = dests.data?.destinations ?? [];

  const [name, setName] = useState('');
  const [type, setType] = useState<DestinationType>('discord_channel');
  const [url, setUrl] = useState('');
  const [channelId, setChannelId] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notif-destinations'] });
    void qc.invalidateQueries({ queryKey: ['notif-doctor'] });
  };

  const isWebhook = type.endsWith('_webhook');
  const isChannel = type.endsWith('_channel');
  const isUser = type.endsWith('_user');

  const add = async () => {
    if (!name.trim()) return;
    setBusy('add'); setError('');
    try {
      await addDestination({
        name: name.trim(), type, enabled: true,
        url: isWebhook ? url.trim() : undefined,
        channel_id: isChannel ? channelId.trim() : undefined,
        user_id: isUser ? userId.trim() : undefined,
      });
      setName(''); setUrl(''); setChannelId(''); setUserId('');
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Connection command center</h3>
      <p className="mb-4 text-small text-muted">Slack, Discord, and result delivery routes.</p>

      <DeliveryDoctor data={doctor.data} loading={doctor.isLoading} onRefresh={refresh} />

      {dests.isLoading ? <Skeleton className="h-20 w-full" /> : rows.length > 0 && (
        <div className="mb-5 mt-5 space-y-4">
          {destinationGroups(rows).map((group) => (
            <div key={group.label}>
              <div className="mb-2 text-small font-semibold text-fg">{group.label}</div>
              <ul className="space-y-2">
                {group.rows.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-medium text-fg">{d.name}</div>
                      <div className="truncate text-caption text-faint">{TYPE_LABEL[d.type] ?? d.type}{destinationDetail(d)}</div>
                    </div>
                    <StatusPill tone={d.enabled ? 'success' : 'neutral'}>{d.enabled ? 'On' : 'Off'}</StatusPill>
                    <Switch checked={!!d.enabled} onChange={async (v) => { setBusy(d.id); try { await toggleDestination(d.id, v); } finally { setBusy(null); refresh(); } }} label={`Toggle ${d.name}`} />
                    <Button variant="ghost" size="icon" aria-label="Test" title="Send a test" disabled={busy === d.id} onClick={async () => { setBusy(d.id); try { await testDestination(d.id); refresh(); } finally { setBusy(null); } }}>
                      {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Delete" title="Delete" onClick={async () => { await deleteDestination(d.id); refresh(); }}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. My Discord)" aria-label="Destination name" />
        <Select value={type} onChange={(e) => setType(e.target.value as DestinationType)} aria-label="Destination type">
          <option value="discord_webhook">Discord webhook</option>
          <option value="discord_channel">Discord channel</option>
          <option value="discord_user">Discord DM</option>
          <option value="slack_webhook">Slack webhook</option>
          <option value="slack_channel">Slack channel</option>
          <option value="slack_user">Slack DM</option>
          <option value="generic_webhook">Generic webhook</option>
        </Select>
        {isWebhook && <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Webhook URL" aria-label="Webhook URL" className="sm:col-span-2" />}
        {isChannel && <Input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder={type.startsWith('slack') ? 'Slack channel ID' : 'Discord channel ID'} aria-label="Channel ID" className="sm:col-span-2" />}
        {isUser && <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder={type.startsWith('slack') ? 'Slack member ID' : 'Discord user ID'} aria-label="User ID" className="sm:col-span-2" />}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={add} disabled={busy === 'add' || !name.trim()}>
          {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add result route
        </Button>
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </Card>
  );
}

function destinationDetail(destination: { channelId?: string; channel_id?: string; userId?: string; user_id?: string; url?: string }) {
  const value = destination.userId ?? destination.user_id ?? destination.channelId ?? destination.channel_id ?? destination.url;
  return value ? ` · ${value}` : '';
}

function destinationGroups(rows: NotificationDestination[]): Array<{ label: string; rows: NotificationDestination[] }> {
  return [
    { label: 'Slack routes', rows: rows.filter((row) => row.type.startsWith('slack_')) },
    { label: 'Discord routes', rows: rows.filter((row) => row.type.startsWith('discord_')) },
    { label: 'Webhook routes', rows: rows.filter((row) => row.type === 'generic_webhook') },
  ].filter((group) => group.rows.length > 0);
}

function surfaceTone(surface: DeliverySurfaceHealth): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!surface.enabled) return 'neutral';
  if (!surface.connected) return 'danger';
  if (!surface.configured || surface.issues.length > 0) return 'warning';
  return 'success';
}

function receiptTone(receipt: DeliveryReceipt): 'success' | 'warning' | 'danger' | 'neutral' {
  if (receipt.status === 'delivered') return 'success';
  if (receipt.status === 'partial') return 'warning';
  if (receipt.status === 'failed') return 'danger';
  if (receipt.deliveryAttempts > 0) return 'warning';
  return 'neutral';
}

function receiptIcon(receipt: DeliveryReceipt) {
  if (receipt.status === 'delivered') return CheckCircle2;
  if (receipt.status === 'failed' || receipt.status === 'partial') return AlertTriangle;
  return Clock3;
}

function formatTime(value?: string) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function DeliveryDoctor({ data, loading, onRefresh }: { data?: NotificationDoctor; loading: boolean; onRefresh: () => void }) {
  if (loading && !data) return <Skeleton className="mb-5 h-44 w-full" />;
  if (!data) return null;

  return (
    <div className="mb-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-small font-semibold text-fg">Live channel health</div>
          <div className="text-caption text-faint">Last checked {formatTime(data.generatedAt)}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {data.surfaces.map((surface) => (
          <div key={surface.id} className="rounded-md border border-border p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-body font-semibold text-fg">{surface.label}</div>
                <div className="text-caption text-faint">{surface.enabledDestinationCount}/{surface.destinationCount} destinations on</div>
              </div>
              <StatusPill tone={surfaceTone(surface)}>{surface.connected ? 'Connected' : surface.enabled ? 'Offline' : 'Off'}</StatusPill>
            </div>
            <div className="grid grid-cols-3 gap-2 text-caption">
              <Capability ok={surface.canDm} icon={MessageCircle} label="DM" />
              <Capability ok={surface.canPostChannel} icon={Hash} label="Channel" />
              <Capability ok={surface.canEdit} icon={PencilLine} label="Edit" />
            </div>
            <div className="mt-3 grid gap-2 text-caption sm:grid-cols-2">
              <SurfaceMetric
                label="Last delivery"
                value={surface.lastDeliveryStatus ? surface.lastDeliveryStatus : 'None'}
                detail={surface.lastDeliveryTitle ? `${surface.lastDeliveryTitle} · ${formatTime(surface.lastDeliveryAt)}` : undefined}
                tone={surface.lastDeliveryStatus ? receiptStatusTone(surface.lastDeliveryStatus) : 'neutral'}
              />
              <SurfaceMetric
                label="Failed delivery"
                value={surface.recentFailureCount > 0 ? `${surface.recentFailureCount}` : 'None'}
                detail={surface.lastFailureTitle ? `${surface.lastFailureTitle} · ${formatTime(surface.lastFailureAt)}` : undefined}
                tone={surface.recentFailureCount > 0 ? 'danger' : 'success'}
              />
            </div>
            {surface.issues.length > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-sm bg-warning-tint px-2.5 py-2 text-caption text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{surface.issues.join(' · ')}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div>
        <div className="mb-2 text-small font-semibold text-fg">Recent delivery receipts</div>
        {data.recentReceipts.length === 0 ? (
          <div className="rounded-md border border-border px-3 py-3 text-small text-muted">No delivery attempts yet.</div>
        ) : (
          <ul className="space-y-2">
            {data.recentReceipts.slice(0, 5).map((receipt) => (
              <li key={receipt.id} className="rounded-md border border-border px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-small font-medium text-fg">{receipt.title}</div>
                    <div className="truncate text-caption text-faint">{receipt.targetSummary} · {formatTime(receipt.deliveredAt ?? receipt.createdAt)}</div>
                  </div>
                  <StatusPill tone={receiptTone(receipt)} icon={receiptIcon(receipt)}>
                    {receipt.status}
                  </StatusPill>
                </div>
                {receipt.deliveryError && <div className="mt-2 truncate text-caption text-danger">{receipt.deliveryError}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function receiptStatusTone(status: DeliveryReceipt['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'delivered') return 'success';
  if (status === 'partial') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function SurfaceMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <div className="min-w-0 rounded-sm bg-subtle px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-faint">{label}</span>
        <StatusPill tone={tone}>{value}</StatusPill>
      </div>
      {detail && <div className="mt-1 truncate text-muted">{detail}</div>}
    </div>
  );
}

function Capability({ ok, icon: Icon, label }: { ok: boolean; icon: typeof MessageCircle; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-sm bg-subtle px-2 py-1 text-muted">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      <span className={ok ? 'text-success' : 'text-faint'}>{ok ? 'on' : 'off'}</span>
    </div>
  );
}
