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
import { useState } from 'preact/hooks';
import { useBackGesture } from '../lib/back-gesture';
import {
  getWorkspace,
  listWorkspaces,
  refreshWorkspace,
  setWorkspaceMobile,
  type WorkspaceBreakdown,
  type WorkspaceRecord,
  type WorkspaceSummary,
} from '../lib/api';
import { haptic } from '../lib/native-bridge';
import { relativeTime } from '../components/Approvals';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';
import { Chat } from './Chat';

export function Workspaces() {
  const [openId, setOpenId] = useState<string | null>(null);
  useBackGesture(openId !== null, () => setOpenId(null));
  const { data, loading, error, offline, refresh } = useScreenData(
    listWorkspaces,
    { intervalMs: 15_000, disabled: openId !== null },
  );
  const spaces = (data?.workspaces ?? []).filter((w) => w.status !== 'archived');

  if (openId) {
    return <WorkspaceDetailView id={openId} onBack={() => { setOpenId(null); void refresh(); }} />;
  }

  if (loading && spaces.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if ((error || offline) && spaces.length === 0) {
    return <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} />;
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

  // The daemon decides what belongs here (content by default, the owner's
  // answer when they gave one) so the phone, the desktop and Clem agree.
  // Everything else folds away: on a laptop a dead draft is easy to scroll
  // past, on a phone it crowds out the two or three that actually matter.
  const live = spaces.filter((s) => s.onPhone ?? (s.rows ?? 0) > 0);
  const empty = spaces.filter((s) => !(s.onPhone ?? (s.rows ?? 0) > 0));

  return (
    <div class="stack">
      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData />
      {live.length === 0 && empty.length > 0 ? (
        <p class="ws-none-yet">
          Nothing here has data yet. Open one below and ask Clem to set it up.
        </p>
      ) : null}
      {renderRows(live, 0)}
      {empty.length > 0 ? (
        <EmptyWorkspaces spaces={empty} onOpen={(id) => setOpenId(id)} startIndex={live.length} />
      ) : null}
    </div>
  );

  function renderRows(rows: WorkspaceSummary[], offset: number) {
    return rows.map((space, i) => (
        <button
          key={space.id}
          class="card card-tap rise"
          style={{ '--i': i + offset }}
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
    ));
  }
}

/** Drafts and abandoned experiments, out of the way but never hidden. */
function EmptyWorkspaces({ spaces, onOpen, startIndex }: {
  spaces: WorkspaceSummary[];
  onOpen: (id: string) => void;
  startIndex: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="ws-empty-group">
      <button class="link-btn" onClick={() => { haptic('light'); setOpen(!open); }}>
        {open ? 'Hide drafts' : `${spaces.length} ${spaces.length === 1 ? 'draft' : 'drafts'}`}
      </button>
      {open ? spaces.map((space, i) => (
        <button
          key={space.id}
          class="card card-tap rise ws-card-empty"
          style={{ '--i': Math.min(i + startIndex, 12) }}
          onClick={() => { haptic('light'); onOpen(space.id); }}
        >
          <div class="min-w-0">
            <div class="card-title-sm truncate">{space.title}</div>
            <div class="card-when">
              {space.presence === 'hidden' ? 'Hidden from your phone' : 'Nothing to show yet'}
            </div>
          </div>
        </button>
      )) : null}
    </div>
  );
}

/**
 * The asks that turn a broken workspace into a working one.
 *
 * A workspace with no registered data source cannot refresh — not "failed",
 * cannot, structurally — and one whose runner never wrote a phone layout can
 * only be guessed at. Both are Clem's work, not the user's, so the app hands
 * her the exact request instead of leaving a button that fails or a screen
 * that looks broken.
 */
const FIX_REFRESH_ASK = 'This workspace has no registered data source, so Refresh does nothing. '
  + 'Please convert its refresh into a proper data-source runner on the workspace '
  + '(so refreshes flow through observations and survive restarts), and have that runner '
  + 'emit a `_mobile` block so the phone view stays current too.';

const PHONE_LAYOUT_ASK = 'Please give this workspace a proper phone layout: have its data-source runner '
  + 'emit a `_mobile` block with the two or three numbers worth seeing at a glance and the rows worth '
  + 'scanning, so my phone stops guessing from the raw JSON.';

function WorkspaceDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<{ kind: 'ok' | 'approval' | 'failed'; text: string } | null>(null);
  const [chatOpen, setChatOpen] = useState<{ draft?: string } | null>(null);
  const [showPref, setShowPref] = useState<boolean | null | undefined>(undefined);
  const [prefBusy, setPrefBusy] = useState(false);
  const { data: detail, error, offline, refresh: load } = useScreenData(
    () => getWorkspace(id),
    { intervalMs: 60_000, disabled: chatOpen !== null },
  );

  async function pullFresh() {
    setRefreshing(true);
    haptic('medium');
    setActionError(null);
    setRefreshNote(null);
    try {
      const outcome = await refreshWorkspace(id);
      if (!outcome.done) {
        // A long runner outlived the wait window — keep polling for the new
        // timestamp, exactly the old behavior.
        setRefreshNote({ kind: 'ok', text: 'Refreshing — this one takes a while, numbers update when it lands.' });
      } else if (outcome.ok) {
        haptic('success');
        setRefreshNote({ kind: 'ok', text: 'Refreshed.' });
        await load();
        setTimeout(() => setRefreshNote(null), 3500);
      } else if ((outcome.pendingApprovalIds?.length ?? 0) > 0) {
        // The previously-invisible case: the refresh is WAITING ON YOU, not
        // slow. Approvals surface on Home under "Needs you".
        haptic('warning');
        setRefreshNote({ kind: 'approval', text: outcome.failureMessage ?? 'Approval needed — check your decisions on Home.' });
      } else {
        haptic('error');
        setRefreshNote({ kind: 'failed', text: outcome.failureMessage ?? 'Refresh failed.' });
      }
    } catch (err) {
      haptic('error');
      setActionError((err as Error).message ?? 'Refresh failed to start');
    } finally {
      setRefreshing(false);
    }
  }

  if (chatOpen) {
    // The SAME continuous thread the desktop's workspace dock uses — the
    // stable space-<slug> session id is the entire binding. A draft can ride
    // along, so "fix this" arrives as a request Clem can act on rather than
    // a blank box the user has to compose in.
    return (
      <Chat
        sessionId={`space-${id}`}
        initialTitle={detail?.title ? `Ask about ${detail.title}` : 'Ask about this workspace'}
        initialDraft={chatOpen.draft}
        onBack={() => { setChatOpen(null); void load(); }}
      />
    );
  }

  if (!detail) {
    return (
      <div>
        <DetailHeader title="Workspace" onBack={onBack} />
        {error || offline
          ? <ScreenNotice error={error} offline={offline} onRetry={() => void load()} />
          : <div class="skeleton-stack" aria-hidden="true"><i /><i /></div>}
      </div>
    );
  }

  const failed = detail.sources.filter((s) => !s.ok);
  const { projection } = detail;
  // 'no_sources' is the daemon's own freshness verdict — the workspace has
  // nothing registered that could ever pull data.
  const canRefresh = detail.freshness !== 'no_sources' && detail.sources.length > 0;
  // Lots of rows and almost no summary means the phone is inferring a layout
  // from raw JSON. That is when a runner-authored one is worth asking for.
  const thinLayout = projection.total >= 8 && projection.headline.length <= 1;
  const preference = showPref === undefined ? (detail.showPreference ?? null) : showPref;

  async function setPresence(next: boolean | null): Promise<void> {
    if (prefBusy) return;
    setPrefBusy(true);
    try {
      const result = await setWorkspaceMobile(id, next);
      setShowPref(result.showPreference);
      haptic('success');
    } catch (err) {
      haptic('error');
      setActionError((err as Error).message ?? 'Could not change this');
    } finally {
      setPrefBusy(false);
    }
  }

  return (
    <div>
      <DetailHeader title={detail.title} onBack={onBack} />

      {detail.objective ? <p class="ws-objective-full">{detail.objective}</p> : null}

      <div class="ws-status">
        <span class="card-when">
          <FreshnessDot state={detail.freshness} />
          {freshnessLabel(detail)}
        </span>
        <button class="btn-quiet" onClick={() => setChatOpen({})}>Ask Clem</button>
        {/* A workspace with no registered data source CANNOT refresh. Showing
            the button anyway is the lie that made this screen feel broken:
            nothing happened and nothing said why. */}
        {canRefresh ? (
          <button class="btn-quiet" disabled={refreshing} onClick={pullFresh}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        ) : null}
      </div>

      {!canRefresh ? (
        <div class="ws-refresh-note">
          <div>This workspace has no data source, so it can’t refresh on its own.</div>
          <button class="link-btn" onClick={() => setChatOpen({ draft: FIX_REFRESH_ASK })}>
            Ask Clem to fix this →
          </button>
        </div>
      ) : null}

      {refreshNote ? (
        <div class={`ws-refresh-note ws-refresh-${refreshNote.kind}`}>{refreshNote.text}</div>
      ) : null}
      {actionError ? <div class="global-error">{actionError}</div> : null}
      <ScreenNotice error={error} offline={offline} onRetry={() => void load()} hasData />

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

      {projection.breakdowns.length > 0 ? <Breakdowns groups={projection.breakdowns} /> : null}

      {projection.records.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">
            {projection.recordLabel ?? 'Records'}
            <span class="section-count">{projection.total}</span>
          </h2>
          <div class="stack">
            {projection.records.map((record, i) => (
              <RecordCard key={record.key} record={record} index={Math.min(i, 12)} />
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

      {thinLayout ? (
        <div class="ws-refresh-note">
          <div>Your phone is guessing this layout from the raw data.</div>
          <button class="link-btn" onClick={() => setChatOpen({ draft: PHONE_LAYOUT_ASK })}>
            Ask Clem for a phone layout →
          </button>
        </div>
      ) : null}

      {/* Phone presence, owned by you. Absent means the app decides by
          content — which is right until it isn't. */}
      <div class="ws-presence">
        <span class="card-when">
          {preference === true ? 'Always on your phone'
            : preference === false ? 'Hidden from your phone'
              : 'Shown when it has something'}
        </span>
        {preference === false ? (
          <button class="btn-quiet" disabled={prefBusy} onClick={() => void setPresence(true)}>Show on phone</button>
        ) : (
          <button class="btn-quiet" disabled={prefBusy} onClick={() => void setPresence(false)}>Hide from phone</button>
        )}
        {preference !== null ? (
          <button class="link-btn" disabled={prefBusy} onClick={() => void setPresence(null)}>Automatic</button>
        ) : null}
      </div>

      {(detail.successCriteria?.length || detail.invariants?.length) ? (
        <section class="home-section">
          <h2 class="section-head">The contract</h2>
          {detail.successCriteria?.length ? (
            <div class="ws-contract">
              <div class="memory-section-head">What good looks like</div>
              {detail.successCriteria.map((line) => <div key={line} class="ws-contract-line">{line}</div>)}
            </div>
          ) : null}
          {detail.invariants?.length ? (
            <div class="ws-contract">
              <div class="memory-section-head">Never</div>
              {detail.invariants.map((line) => <div key={line} class="ws-contract-line">{line}</div>)}
            </div>
          ) : null}
        </section>
      ) : null}

      {detail.linkedWorkflows?.length ? (
        <section class="home-section">
          <h2 class="section-head">Flows that feed this</h2>
          <div class="stack">
            {detail.linkedWorkflows.map((wf) => (
              <div key={wf.name} class="card">
                <div class="min-w-0">
                  <div class="card-title-sm truncate">{wf.name}{wf.enabled ? '' : ' · disabled'}</div>
                  {wf.description ? <div class="card-when">{wf.description}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Four fields on the face of the card, every field one tap away. */
const CARD_FIELDS = 4;

function RecordCard({ record, index }: { record: WorkspaceRecord; index: number }) {
  const [open, setOpen] = useState(false);
  const hidden = record.fields.length - CARD_FIELDS;
  const shown = open ? record.fields : record.fields.slice(0, CARD_FIELDS);
  return (
    <article class="card rise" style={{ '--i': index }}>
      <div class="card-title-sm">{record.primary}</div>
      {shown.length > 0 ? (
        <dl class="ws-fields">
          {shown.map((field) => (
            <div key={field.label} class="ws-field">
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hidden > 0 ? (
        <button class="link-btn" onClick={() => { haptic('light'); setOpen(!open); }}>
          {open ? 'Show less' : `All ${record.fields.length} fields`}
        </button>
      ) : null}
    </article>
  );
}

/** The distribution behind the headline numbers — by stage, by band, by
 *  loss reason. Without these the phone showed a summary of a summary. */
function Breakdowns({ groups }: { groups: WorkspaceBreakdown[] }) {
  return (
    <section class="home-section">
      <h2 class="section-head">Breakdown</h2>
      <div class="stack">
        {groups.map((group, i) => (
          <article key={group.label} class="card rise" style={{ '--i': i }}>
            <div class="card-title-sm">{group.label}</div>
            <div class="ws-bars">
              {group.entries.map((entry) => (
                <div key={entry.label} class="ws-bar-row">
                  <span class="ws-bar-label truncate">{entry.label}</span>
                  <span class="ws-bar-track">
                    <span class="ws-bar-fill" style={{ width: `${Math.round(entry.ratio * 100)}%` }} />
                  </span>
                  <span class="ws-bar-value">{entry.value}</span>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
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
