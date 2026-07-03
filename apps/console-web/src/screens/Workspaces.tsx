import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Clock, Database, Zap, History, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { listSpaces, spaceViewUrl, type SpaceRecord } from '@/lib/spaces';
import { humanizeCron } from '@/lib/cron';
import { CreateWorkspaceModal } from '@/components/workspaces/CreateWorkspaceModal';

function statusTone(status: SpaceRecord['status']): Tone {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function scheduleHint(space: SpaceRecord): string | null {
  const scheduled = space.dataSources.find((d) => d.schedule);
  if (!scheduled?.schedule) return null;
  try { return humanizeCron(scheduled.schedule); } catch { return scheduled.schedule; }
}

function healthLabel(space: SpaceRecord): { tone: Tone; text: string } {
  const health = space.health;
  if (!health) return { tone: 'neutral', text: 'health pending' };
  if (health.issues.length > 0) return { tone: 'warning', text: `${health.issues.length} issue${health.issues.length === 1 ? '' : 's'}` };
  if (health.freshness.state === 'fresh') return { tone: 'success', text: 'fresh' };
  if (health.freshness.state === 'no_sources') return { tone: 'neutral', text: 'static' };
  return { tone: 'warning', text: health.freshness.state.replace('_', ' ') };
}

function WorkspaceCard({ space, onOpen }: { space: SpaceRecord; onOpen: () => void }) {
  const sched = scheduleHint(space);
  const health = space.health;
  const healthStatus = healthLabel(space);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-xs transition-all duration-fast hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md cursor-pointer"
    >
      {/* Live preview — a scaled, non-interactive snapshot of the actual view. */}
      <div className="relative h-40 w-full overflow-hidden border-b border-border bg-subtle">
        <iframe
          title={`${space.title} preview`}
          src={spaceViewUrl(space.id)}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ width: '250%', height: '250%', transform: 'scale(0.4)', border: 0 }}
        />
        {space.status !== 'active' && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/55">
            <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-h3 text-fg">{space.title}</h3>
          <StatusPill tone={healthStatus.tone}>{healthStatus.text}</StatusPill>
        </div>
        <p className="text-caption text-faint">Updated {new Date(space.updatedAt).toLocaleDateString()}</p>
        {health && (
          <div className="mt-2 grid grid-cols-3 gap-2 text-caption text-muted">
            <span className="inline-flex items-center gap-1 truncate">
              <Database className="h-3.5 w-3.5 shrink-0" aria-hidden /> {health.counts.dataSources}
            </span>
            <span className="inline-flex items-center gap-1 truncate">
              <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden /> {health.counts.actions}
            </span>
            <span className="inline-flex items-center gap-1 truncate">
              <History className="h-3.5 w-3.5 shrink-0" aria-hidden /> v{health.version}
            </span>
          </div>
        )}
        {sched && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-small text-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden /> {sched}
          </p>
        )}
        {health && health.issues.length > 0 && (
          <p className="mt-1 inline-flex items-center gap-1.5 truncate text-caption text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {health.issues[0]}
          </p>
        )}
        {health && health.issues.length === 0 && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-caption text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> View, data, and actions indexed
          </p>
        )}
      </div>
    </button>
  );
}

export function Workspaces() {
  const navigate = useNavigate();
  const spaces = usePoll(['spaces'], listSpaces, 8000);
  const [modalOpen, setModalOpen] = useState(false);

  // On create, carry the build request to the view as route state so the dock
  // seeds Clem with it immediately (no cold context-switch to chat).
  const openCreated = (id: string, build?: string) => {
    setModalOpen(false);
    navigate(`/workspaces/${id}`, build ? { state: { build } } : undefined);
  };

  const items = spaces.data ?? [];

  return (
    <Page
      title="Workspaces"
      subtitle="Live, interactive surfaces Clem builds for you — reports, trackers, planners"
      actions={
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New workspace
        </Button>
      }
    >
      {spaces.isLoading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl border border-border bg-subtle" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description={
            <>Ask Clem to build one — “make me a live dashboard for my pipeline” — or start a blank one and tell her what you want.</>
          }
          action={<Button onClick={() => setModalOpen(true)}><Plus className="h-4 w-4" aria-hidden /> New workspace</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((space) => (
            <WorkspaceCard key={space.id} space={space} onOpen={() => navigate(`/workspaces/${space.id}`)} />
          ))}
        </div>
      )}
      <CreateWorkspaceModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={openCreated} />
    </Page>
  );
}
