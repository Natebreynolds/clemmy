/**
 * Workspaces on a phone.
 *
 * The desktop renders a workspace as the little HTML app Clem authored for
 * it. That view is loopback-only on purpose — agent-written JavaScript never
 * leaves the Mac — so this is not, and cannot be, a mirror of that screen.
 *
 * It is the same data asked a different question. On a laptop you want the
 * whole 40-column grid; standing in a parking lot you want: is this fresh,
 * what are the headline numbers, and let me scan the rows. The daemon does
 * the projecting (src/spaces/mobile-projection.ts) so the choices are
 * deterministic and testable rather than guessed in a component.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getWorkspace,
  listWorkspaces,
  refreshWorkspace,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from '../lib/api';
import { REFRESH_EVENT, haptic } from '../lib/native-bridge';
import { relativeTime } from '../components/Approvals';

export function Workspaces() {
  const [spaces, setSpaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listWorkspaces();
      setSpaces(result.workspaces.filter((w) => w.status !== 'archived'));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    const onPull = () => { void refresh(); };
    window.addEventListener(REFRESH_EVENT, onPull);
    return () => { clearInterval(id); window.removeEventListener(REFRESH_EVENT, onPull); };
  }, [refresh]);

  if (openId) {
    return <WorkspaceDetailView id={openId} onBack={() => { setOpenId(null); refresh(); }} />;
  }

  if (loading && spaces.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (error && spaces.length === 0) {
    return (
      <div class="empty">
        <p class="empty-title">Couldn't load workspaces</p>
        <p class="empty-body">{error}</p>
      </div>
    );
  }
  if (spaces.length === 0) {
    return (
      <div class="empty">
        <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
        <p class="empty-title">No workspaces yet</p>
        <p class="empty-body">Ask Clem to build one on your Mac and it shows up here.</p>
      </div>
    );
  }

  return (
    <div class="stack">
      {spaces.map((space, i) => (
        <button
          key={space.id}
          class="card card-tap rise"
          style={{ '--i': i }}
          onClick={() => { haptic('light'); setOpenId(space.id); }}
        >
          <div class="min-w-0">
            <div class="card-title-sm truncate">{space.title}</div>
            {space.objective ? <div class="ws-objective truncate">{space.objective}</div> : null}
            <div class="card-when">
              <FreshnessDot state={space.freshness} />
              {freshnessLabel(space)}
            </div>
          </div>
          <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function WorkspaceDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getWorkspace(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load workspace');
    }
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    const onPull = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, onPull);
    return () => { clearInterval(timer); window.removeEventListener(REFRESH_EVENT, onPull); };
  }, [load]);

  async function pullFresh() {
    setRefreshing(true);
    haptic('medium');
    try {
      // The daemon starts the runners and returns immediately — a refresh can
      // take minutes, and holding a mobile connection open that long fails.
      await refreshWorkspace(id);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError((err as Error).message ?? 'Refresh failed to start');
    } finally {
      // Let the poll above surface the new timestamp rather than pretending
      // the data is already back.
      setTimeout(() => setRefreshing(false), 4000);
    }
  }

  if (!detail) {
    return (
      <div>
        <DetailHeader title="Workspace" onBack={onBack} />
        {error ? <div class="global-error">{error}</div> : <div class="skeleton-stack" aria-hidden="true"><i /><i /></div>}
      </div>
    );
  }

  const failed = detail.sources.filter((s) => !s.ok);
  const { projection } = detail;

  return (
    <div>
      <DetailHeader title={detail.title} onBack={onBack} />

      {detail.objective ? <p class="ws-objective-full">{detail.objective}</p> : null}

      <div class="ws-status">
        <span class="card-when">
          <FreshnessDot state={detail.freshness} />
          {freshnessLabel(detail)}
        </span>
        <button class="btn-quiet" disabled={refreshing} onClick={pullFresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* A failed runner leaves yesterday's numbers looking current — say so
          before showing them, not after. */}
      {failed.length > 0 ? (
        <div class="ws-warn">
          <strong>Last refresh failed</strong>
          <span>
            {failed.map((s) => s.id).join(', ')} couldn't update, so these numbers are older than they look.
          </span>
          {failed[0].error ? <code class="ws-warn-detail">{failed[0].error}</code> : null}
        </div>
      ) : null}

      {/* Diagnostics are for when you go looking, not for the first screenful:
          the headline numbers are why you opened this. */}
      {detail.issues.length > 0 ? <IssueDisclosure issues={detail.issues} /> : null}

      {projection.headline.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">At a glance</h2>
          <div class="ws-tiles">
            {projection.headline.map((tile, i) => (
              <div key={tile.label} class="ws-tile rise" style={{ '--i': i }}>
                <div class="ws-tile-value">{tile.value}</div>
                <div class="ws-tile-label">{tile.label}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {projection.records.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">
            {projection.recordLabel ?? 'Records'}
            <span class="section-count">{projection.total}</span>
          </h2>
          <div class="stack">
            {projection.records.map((record, i) => (
              <article key={record.key} class="card rise" style={{ '--i': Math.min(i, 12) }}>
                <div class="card-title-sm">{record.primary}</div>
                {record.fields.length > 0 ? (
                  <dl class="ws-fields">
                    {record.fields.map((field) => (
                      <div key={field.label} class="ws-field">
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </article>
            ))}
          </div>
          {projection.total > projection.shown ? (
            <p class="ws-more">
              Showing {projection.shown} of {projection.total}. The full workspace lives on your Mac.
            </p>
          ) : null}
        </section>
      ) : (
        <div class="empty">
          <p class="empty-title">Nothing to list</p>
          <p class="empty-body">
            This workspace's data doesn't look like a set of records, so there's nothing to scan here.
            Open it on your Mac for the full view.
          </p>
        </div>
      )}
    </div>
  );
}

function IssueDisclosure({ issues }: { issues: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="ws-issues">
      <button class="link-btn" onClick={() => { haptic('light'); setOpen(!open); }}>
        {open ? 'Hide details' : `${issues.length} issue${issues.length === 1 ? '' : 's'} on this workspace`}
      </button>
      {open ? (
        <ul class="ws-issue-list">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div class="chat-header">
      <button class="chat-back" onClick={() => { haptic('light'); onBack(); }} aria-label="Back">←</button>
      <div class="chat-title">{title}</div>
    </div>
  );
}

function FreshnessDot({ state }: { state: string }) {
  return <span class={`status-dot ws-fresh-${state}`} aria-hidden="true" />;
}

function freshnessLabel(space: { freshness: string; lastRefreshedAt: string | null }): string {
  if (!space.lastRefreshedAt) return 'Never refreshed';
  const when = relativeTime(space.lastRefreshedAt);
  if (space.freshness === 'stale') return `Stale · updated ${when}`;
  return `Updated ${when}`;
}
