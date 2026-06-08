import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Clock, AlertCircle } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePoll } from '@/lib/poll';
import { listSpaces, createSpace, spaceViewUrl, type SpaceRecord } from '@/lib/spaces';
import { humanizeCron } from '@/lib/cron';

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

function WorkspaceCard({ space, onOpen }: { space: SpaceRecord; onOpen: () => void }) {
  const sched = scheduleHint(space);
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
          <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>
        </div>
        <p className="text-caption text-faint">Updated {new Date(space.updatedAt).toLocaleDateString()}</p>
        {sched && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-small text-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden /> {sched}
          </p>
        )}
      </div>
    </button>
  );
}

export function Workspaces() {
  const navigate = useNavigate();
  const spaces = usePoll(['spaces'], listSpaces, 8000);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const space = await createSpace('New workspace');
      navigate(`/workspaces/${space.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a workspace.');
    } finally {
      setCreating(false);
    }
  };

  const items = spaces.data ?? [];

  return (
    <Page
      title="Workspaces"
      subtitle="Live, interactive surfaces Clem builds for you — reports, trackers, planners"
      actions={
        <Button onClick={handleCreate} disabled={creating}>
          <Plus className="h-4 w-4" aria-hidden /> {creating ? 'Creating…' : 'New workspace'}
        </Button>
      }
    >
      {error && (
        <p className="mb-4 inline-flex items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
        </p>
      )}

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
          action={<Button onClick={handleCreate} disabled={creating}><Plus className="h-4 w-4" aria-hidden /> New workspace</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((space) => (
            <WorkspaceCard key={space.id} space={space} onOpen={() => navigate(`/workspaces/${space.id}`)} />
          ))}
        </div>
      )}
    </Page>
  );
}
