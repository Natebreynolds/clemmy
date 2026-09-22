/**
 * Home command-center mock. Fixture-only. Live Home is unchanged unless
 * `?mock=` is present on /home, or this screen is mounted at /dev/home-mock.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity, Home as HomeIcon, Inbox, LayoutDashboard, MessageCircle,
  PanelLeft, Plug, Search, Settings, SlidersHorizontal, X, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Field';
import { cn } from '@/lib/cn';
import dogMark from '@/assets/dog-mark.png';
import { AGENDA, CATALOG, CAPTURE, MAIL, MOCK_NAME, NEEDS_YOU, TRENDS, type CatalogCard } from '@/components/home/mock/data';
import {
  AgendaTile, CaptureTile, MailTile, MiniAsk, NeedsYouTile, ReportTile, WatchTile,
  type TileMenuHandlers,
} from '@/components/home/mock/tiles';
import { MOCK_SCREENS, isHomeMockScreen, type MockScreen } from '@/components/home/mock/screens';

function greeting(): string {
  const hour = new Date().getHours();
  const base = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `${base}, ${MOCK_NAME}`;
}

const NAV = [
  { path: '/home', label: 'Home', icon: HomeIcon, active: true },
  { path: '/chat', label: 'Chat', icon: MessageCircle },
  { path: '/inbox', label: 'Needs you', icon: Inbox, badge: 2 },
  { path: '/tasks', label: 'Running', icon: Activity },
  { path: '/workspaces', label: 'Spaces', icon: LayoutDashboard },
  { path: '/automate', label: 'Automate', icon: Zap },
  { path: '/connect', label: 'Connect', icon: Plug },
];

function MockSidebar() {
  return (
    <nav aria-label="Primary" className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="sidebar-brand flex items-center gap-2.5 px-4 py-4">
        <img src={dogMark} alt="" width={32} height={32} className="rounded-md" style={{ imageRendering: 'pixelated' }} />
        <span className="text-h3 font-bold text-fg">Clementine</span>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <span
              key={item.path}
              className={cn(
                'relative flex h-10 items-center gap-3 rounded-sm px-3 text-body font-medium',
                item.active ? 'bg-primary-tint text-primary' : 'text-muted',
              )}
            >
              {item.active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" aria-hidden />}
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
              {item.badge ? (
                <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-caption font-bold text-primary-fg">
                  {item.badge}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
      <div className="border-t border-border px-3 py-3">
        <span className="flex h-10 items-center gap-3 rounded-sm px-3 text-body font-medium text-muted">
          <Settings className="h-5 w-5" aria-hidden /> Settings
        </span>
      </div>
    </nav>
  );
}

function MockTopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <span className="inline-flex h-10 w-10 items-center justify-center text-muted" aria-hidden>
        <PanelLeft className="h-5 w-5" />
      </span>
      <h1 className="text-h3 font-semibold text-fg">Home</h1>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="hidden items-center gap-2 rounded-sm border border-border bg-canvas px-3 py-1.5 text-small text-muted sm:inline-flex">
          <Search className="h-4 w-4" aria-hidden /> Search…
        </span>
      </div>
    </header>
  );
}

function ScreenSwitcher({
  current,
  onChange,
}: {
  current: MockScreen;
  onChange: (id: MockScreen) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-2">
      <p className="mr-2 text-caption font-semibold text-muted">Mock screens</p>
      {MOCK_SCREENS.map((screen) => (
        <button
          key={screen.id}
          type="button"
          onClick={() => onChange(screen.id)}
          className={cn(
            'h-8 cursor-pointer rounded-sm px-2.5 text-caption font-semibold transition-colors',
            current === screen.id ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted hover:bg-hover hover:text-fg',
          )}
        >
          {screen.label}
        </button>
      ))}
      <p className="ml-auto text-caption text-faint">Fixture data · not live</p>
    </div>
  );
}

function ZoneLabel({ children }: { children: string }) {
  return <h2 className="text-small font-semibold text-muted">{children}</h2>;
}

function widgetMenu(handlers: TileMenuHandlers): TileMenuHandlers {
  return { ...handlers, onRemove: handlers.onRemove ?? handlers.onReplace };
}

function PopulatedCanvas({
  baseline = false,
  stacked = false,
  highlightTrends = false,
  notice,
  onBuild,
  onTune,
  onAsk,
  onReplace,
  onOpenSpace,
  onDraft,
  onPrep,
  onLookInto,
}: {
  baseline?: boolean;
  stacked?: boolean;
  highlightTrends?: boolean;
  notice?: string | null;
  onBuild: () => void;
  onTune: (target: TuneTarget) => void;
  onAsk: () => void;
  onReplace: (label: string) => void;
  onOpenSpace: () => void;
  onDraft: (title: string) => void;
  onPrep: () => void;
  onLookInto: (title: string) => void;
}) {
  const menuFor = (target: TuneTarget, space = false) =>
    widgetMenu({
      onTune: () => onTune(target),
      onReplace: () => onReplace(TUNE_TITLE[target]),
      onOpenSpace: space ? onOpenSpace : undefined,
    });
  return (
    <div className={cn('mx-auto flex w-full flex-col gap-5 px-5 py-4 sm:px-8', stacked ? 'max-w-[390px] px-4' : 'max-w-[1180px]')}>
      <section className="flex flex-col gap-3" aria-label="Ask Clementine">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-h1 text-fg">{greeting()}</h1>
            <p className="text-body text-muted">2 need you · 14 new in Social capture</p>
          </div>
          {!stacked && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onBuild}>Build home</Button>
              <Button variant="ghost" size="sm" onClick={() => onTune('trends')}>
                <SlidersHorizontal className="h-4 w-4" aria-hidden /> Tune
              </Button>
            </div>
          )}
        </div>
        <MiniAsk compact placeholder="Ask Clementine…" onSend={onAsk} />
        {notice && (
          <p className="rounded-md border border-border bg-subtle px-3 py-2 text-small text-fg" role="status">
            {notice}
          </p>
        )}
      </section>

      <div className="flex flex-col gap-2.5">
        <ZoneLabel>Now</ZoneLabel>
        <div className={cn('grid gap-5', stacked ? 'grid-cols-1' : 'grid-cols-12')}>
          <div className={stacked ? '' : 'col-span-5'}>
            <AgendaTile compact={stacked} menu={menuFor('today')} onPrep={onPrep} />
          </div>
          <div className={stacked ? '' : 'col-span-4'}><NeedsYouTile menu={menuFor('needs_you')} /></div>
          <div className={stacked ? '' : 'col-span-3'}>
            <MailTile menu={menuFor('mail')} onDraft={onDraft} />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <ZoneLabel>Watching</ZoneLabel>
        <div className={cn('grid gap-5', stacked ? 'grid-cols-1' : 'grid-cols-12 items-start')}>
          <div className={stacked ? '' : 'col-span-7'}>
            <ReportTile
              baseline={baseline}
              highlighted={highlightTrends}
              stacked={stacked}
              menu={menuFor('trends', true)}
              onLookInto={onLookInto}
            />
          </div>
          <div className={cn('flex flex-col gap-5', stacked ? '' : 'col-span-5')}>
            <CaptureTile stacked menu={menuFor('capture', true)} />
            {!stacked && <WatchTile menu={menuFor('watch', true)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function BlankCanvas({ onBuild, onAsk }: { onBuild: () => void; onAsk: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-5 py-10 sm:px-8">
      <section className="flex flex-col gap-3.5" aria-label="Ask Clementine">
        <h1 className="text-h1 text-fg">{greeting()}</h1>
        <MiniAsk onSend={onAsk} placeholder="Ask Clementine to build a tile, or just ask…" />
      </section>
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <img
          src={dogMark}
          alt=""
          width={56}
          height={56}
          className="mb-4 rounded-md"
          style={{ imageRendering: 'pixelated' }}
        />
        <h2 className="text-h3 text-fg">Build your command center</h2>
        <p className="reading mt-2 text-muted">
          Place what you want to see every time you sit down. Calendar, mail, a trends report, a social wall — Clem will keep them live. Nothing lives here until you place it.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onBuild}>Build home</Button>
          <Button variant="secondary" onClick={onAsk}>Ask Clem</Button>
        </div>
      </div>
    </div>
  );
}

function CatalogPreview({ card }: { card: CatalogCard }) {
  if (card.id === 'calendar') {
    return (
      <div className="flex h-full flex-col justify-end gap-1 p-3">
        <p className="text-caption text-faint">Next</p>
        <p className="text-small font-semibold text-primary">3:30 · Aldous — intake</p>
      </div>
    );
  }
  if (card.id === 'trends') {
    return (
      <div className="flex h-full flex-col justify-end gap-0.5 p-3">
        <p className="text-caption text-muted">Organic</p>
        <p className="text-h2 tabular-nums text-fg">12,400</p>
        <p className="text-caption font-semibold text-success">+12% vs last refresh</p>
      </div>
    );
  }
  if (card.id === 'capture') {
    return (
      <div className="grid h-full grid-cols-2">
        {CAPTURE.items.slice(0, 2).map((item) => (
          <img key={item.title} src={item.thumb} alt="" className="h-full w-full object-cover" />
        ))}
      </div>
    );
  }
  if (card.id === 'needs_you') {
    return (
      <div className="flex h-full flex-col justify-end gap-1 p-3">
        <p className="text-h2 tabular-nums text-fg">2</p>
        <p className="text-caption text-muted">waiting on you</p>
      </div>
    );
  }
  if (card.id === 'mail') {
    return (
      <div className="flex h-full flex-col justify-end gap-1 p-3">
        <p className="text-small font-semibold text-fg">2 need a reply</p>
        <p className="text-caption text-muted">Not the whole mailbox.</p>
      </div>
    );
  }
  if (card.id === 'rank') {
    return (
      <div className="flex h-full flex-col justify-end gap-1 p-3">
        <p className="text-small font-semibold text-fg">Quiet</p>
        <p className="text-caption text-muted">Nothing crossed the threshold.</p>
      </div>
    );
  }
  if (card.id === 'waiting') {
    return (
      <div className="flex h-full flex-col justify-end gap-1 p-3">
        <p className="text-small font-semibold text-fg">Sent, no reply</p>
        <p className="text-caption text-muted">The other slice of mail.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col justify-end p-3">
      <p className="text-caption text-muted">{card.species}</p>
    </div>
  );
}

function GalleryCard({
  card,
  onAdd,
  onBuildRecipe,
}: {
  card: CatalogCard;
  onAdd: (id: string) => void;
  onBuildRecipe: (id: string) => void;
}) {
  return (
    <li className="flex flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="h-24 overflow-hidden border-b border-border bg-subtle">
        <CatalogPreview card={card} />
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-body font-semibold text-fg">{card.title}</p>
        <p className="text-small text-muted">{card.pitch}</p>
        <div className="mt-auto pt-3">
          {card.ready ? (
            <Button
              size="sm"
              variant={card.group === 'recipes' ? 'primary' : 'secondary'}
              onClick={() => (card.group === 'recipes' ? onBuildRecipe(card.id) : onAdd(card.id))}
            >
              {card.group === 'recipes' ? 'Build with Clem' : 'Add'}
            </Button>
          ) : (
            <p className="text-small text-muted">{card.gate}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function GallerySheet({
  onClose,
  onAdd,
  onBuildRecipe,
  replacing,
}: {
  onClose: () => void;
  onAdd: (id: string) => void;
  onBuildRecipe: (id: string) => void;
  replacing?: string | null;
}) {
  const startHere = CATALOG.filter((card) => card.id === 'needs_you' || card.id === 'calendar' || card.id === 'mail');
  const recipes = CATALOG.filter((card) => card.group === 'recipes');
  const alsoClem = CATALOG.filter((card) => card.group === 'clem' && card.id !== 'needs_you');
  return (
    <div
      className="absolute inset-0 z-20 flex justify-end"
      style={{ backgroundColor: 'color-mix(in srgb, var(--text) 18%, transparent)' }}
      role="dialog"
      aria-labelledby="gallery-title"
    >
      <div className="flex h-full w-full max-w-[640px] flex-col border-l border-border bg-canvas shadow-modal">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-5 py-4">
          <div>
            <h2 id="gallery-title" className="text-h3 text-fg">
              {replacing ? `Replace ${replacing}` : 'Add to home'}
            </h2>
            <p className="text-small text-muted">
              {replacing
                ? 'This slot stays. The widget changes. Same refresh, same actions, new question.'
                : 'Place what you want to see. Clem keeps it live, and can act on it.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="cursor-pointer rounded-md p-2 text-muted hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <section className="mb-8">
            <h3 className="mb-3 text-small font-semibold text-muted">Start here</h3>
            <ul className="grid gap-3 sm:grid-cols-3">
              {startHere.map((card) => (
                <GalleryCard key={card.id} card={card} onAdd={onAdd} onBuildRecipe={onBuildRecipe} />
              ))}
            </ul>
          </section>
          <section className="mb-8">
            <h3 className="mb-1 text-small font-semibold text-muted">Clem can build</h3>
            <p className="mb-3 text-small text-muted">Joined from what’s connected. Reports, captures, watches.</p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {recipes.map((card) => (
                <GalleryCard key={card.id} card={card} onAdd={onAdd} onBuildRecipe={onBuildRecipe} />
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-3 text-small font-semibold text-muted">Also from Clem</h3>
            <ul className="divide-y divide-border rounded-md border border-border bg-surface">
              {alsoClem.map((card) => (
                <li key={card.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-fg">{card.title}</p>
                    <p className="text-small text-muted">{card.pitch}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => onAdd(card.id)}>Add</Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

type TuneTarget = 'today' | 'mail' | 'needs_you' | 'trends' | 'capture' | 'watch';

const TUNE_TITLE: Record<TuneTarget, string> = {
  today: 'Today',
  mail: 'Mail',
  needs_you: 'Needs you',
  trends: 'Content trends',
  capture: 'Social capture',
  watch: 'Rank watch',
};

function TunePanel({ target, onClose }: { target: TuneTarget; onClose: () => void }) {
  const [windowValue, setWindowValue] = useState(target === 'today' ? 'remaining' : '7d');
  const [refresh, setRefresh] = useState(target === 'trends' ? 'daily' : '15m');
  const [hero, setHero] = useState(target === 'trends');
  const [searchOn, setSearchOn] = useState(true);
  const [analyticsOn, setAnalyticsOn] = useState(true);
  const [socialOn, setSocialOn] = useState(true);
  const [linkedinOn, setLinkedinOn] = useState(true);
  const [instagramOn, setInstagramOn] = useState(true);
  const [slice, setSlice] = useState('reply');
  return (
    <aside className="flex h-full w-full max-w-[360px] shrink-0 flex-col border-l border-border bg-surface shadow-popover">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
        <div>
          <h2 className="text-h3 text-fg">Tune · {TUNE_TITLE[target]}</h2>
          <p className="text-small text-muted">This widget, not the whole home.</p>
        </div>
        <button type="button" onClick={onClose} className="cursor-pointer rounded-md p-2 text-muted hover:bg-hover hover:text-fg" aria-label="Close tune">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {target === 'today' && (
          <>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-window">Show</label>
            <Select id="tune-window" value={windowValue} onChange={(e) => setWindowValue(e.target.value)} className="mb-4">
              <option value="remaining">What’s left today</option>
              <option value="today">The whole day</option>
              <option value="week">This week</option>
            </Select>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-refresh">Refresh</label>
            <Select id="tune-refresh" value={refresh} onChange={(e) => setRefresh(e.target.value)} className="mb-4">
              <option value="on_open">On open</option>
              <option value="15m">Every 15 minutes</option>
            </Select>
          </>
        )}
        {target === 'mail' && (
          <>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-slice">Show</label>
            <Select id="tune-slice" value={slice} onChange={(e) => setSlice(e.target.value)} className="mb-4">
              <option value="reply">Needs a reply</option>
              <option value="unread">Unread</option>
              <option value="both">Both</option>
            </Select>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-refresh">Refresh</label>
            <Select id="tune-refresh" value={refresh} onChange={(e) => setRefresh(e.target.value)} className="mb-4">
              <option value="on_open">On open</option>
              <option value="15m">Every 15 minutes</option>
            </Select>
          </>
        )}
        {target === 'needs_you' && (
          <p className="mb-4 text-small text-muted">
            This pin is Clem’s Needs you — the same list as Inbox. Density is the only thing to tune; the items themselves are the live queue.
          </p>
        )}
        {target === 'trends' && (
          <>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-window">Time window</label>
            <Select id="tune-window" value={windowValue} onChange={(e) => setWindowValue(e.target.value)} className="mb-4">
              <option value="today">Today</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="since_last">Since last look</option>
            </Select>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-refresh">Refresh</label>
            <Select id="tune-refresh" value={refresh} onChange={(e) => setRefresh(e.target.value)} className="mb-4">
              <option value="on_open">On open</option>
              <option value="15m">Every 15 minutes</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Each morning</option>
              <option value="manual">Manual</option>
            </Select>
            <p className="mb-2 text-label text-fg">Sources</p>
            <ul className="mb-4 divide-y divide-border rounded-md border border-border">
              {[
                { label: 'Search', on: searchOn, set: setSearchOn },
                { label: 'Analytics', on: analyticsOn, set: setAnalyticsOn },
                { label: 'Social', on: socialOn, set: setSocialOn },
              ].map((source) => (
                <li key={source.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="text-small text-fg">{source.label}</span>
                  <Switch checked={source.on} onChange={source.set} label={source.label} />
                </li>
              ))}
            </ul>
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div>
                <p className="text-small font-semibold text-fg">Hero tile</p>
                <p className="text-caption text-muted">One per home. Makes this the wide brief.</p>
              </div>
              <Switch checked={hero} onChange={setHero} label="Hero tile" />
            </div>
            <p className="mb-1.5 text-label text-fg">Filter</p>
            <p className="mb-4 rounded-sm bg-subtle px-3 py-2 text-small text-muted">keywords that moved</p>
          </>
        )}
        {target === 'capture' && (
          <>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-refresh">Refresh</label>
            <Select id="tune-refresh" value={refresh} onChange={(e) => setRefresh(e.target.value)} className="mb-4">
              <option value="on_open">On open</option>
              <option value="15m">Every 15 minutes</option>
            </Select>
            <p className="mb-2 text-label text-fg">Accounts</p>
            <ul className="mb-4 divide-y divide-border rounded-md border border-border">
              {[
                { label: 'LinkedIn', on: linkedinOn, set: setLinkedinOn },
                { label: 'Instagram', on: instagramOn, set: setInstagramOn },
              ].map((source) => (
                <li key={source.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="text-small text-fg">{source.label}</span>
                  <Switch checked={source.on} onChange={source.set} label={source.label} />
                </li>
              ))}
            </ul>
          </>
        )}
        {target === 'watch' && (
          <>
            <label className="mb-1.5 block text-label text-fg" htmlFor="tune-window">Shout when</label>
            <Select id="tune-window" value={windowValue} onChange={(e) => setWindowValue(e.target.value)} className="mb-4">
              <option value="page">A keyword leaves page one</option>
              <option value="three">A keyword leaves the top 3</option>
            </Select>
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div>
                <p className="text-small font-semibold text-fg">Wake me</p>
                <p className="text-caption text-muted">Needs you, when it fires.</p>
              </div>
              <Switch checked={hero} onChange={setHero} label="Wake me" />
            </div>
          </>
        )}
        <Button className="w-full" onClick={onClose}>Done</Button>
      </div>
    </aside>
  );
}

function PhoneHome({
  notice,
  onAsk,
  onBuild,
  onDraft,
  onPrep,
}: {
  notice?: string | null;
  onAsk: () => void;
  onBuild: () => void;
  onDraft: (title: string) => void;
  onPrep: () => void;
}) {
  const next = AGENDA.find((event) => event.when === 'next');
  const leadMail = MAIL[0];
  return (
    <div className="flex justify-center py-6">
      <div className="flex h-[760px] w-[390px] flex-col overflow-hidden rounded-[28px] border border-border-strong bg-canvas shadow-modal">
        <header className="px-5 pb-3 pt-5">
          <p className="text-caption text-muted">{greeting()}</p>
          <h1 className="text-h1 text-fg">2 things need your answer</h1>
          <p className="mt-1 text-small text-muted">
            {next ? `${next.title} in 40 minutes` : 'Nothing else on the calendar.'}
          </p>
        </header>
        <div className="px-5 pb-3">
          <MiniAsk compact placeholder="Ask Clementine…" onSend={onAsk} />
          {notice && (
            <p className="mt-2 rounded-md border border-border bg-subtle px-3 py-2 text-small text-fg" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <div className="flex flex-col gap-4">
            {next && (
              <section aria-label="Today">
                <h2 className="mb-2 text-small font-semibold text-muted">Today</h2>
                <div className="rounded-md border border-border bg-surface px-4 py-3">
                  <p className="text-small font-semibold text-primary">{next.time}</p>
                  <p className="text-body font-semibold text-fg">{next.title}</p>
                  <Button size="sm" className="mt-2" onClick={onPrep}>Prep me</Button>
                </div>
              </section>
            )}

            <section aria-label="Needs you">
              <h2 className="mb-2 text-small font-semibold text-muted">Needs you</h2>
              <div className="overflow-hidden rounded-md border border-border bg-surface">
                {NEEDS_YOU.slice(0, 2).map((item) => (
                  <div key={item.title} className="border-t border-border px-4 py-3 first:border-t-0">
                    <p className="text-body font-semibold text-fg">{item.title}</p>
                    <p className="text-small text-muted">{item.meta}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm">Approve</Button>
                      <Button size="sm" variant="secondary">Not now</Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {leadMail && (
              <section aria-label="Mail">
                <h2 className="mb-2 text-small font-semibold text-muted">Mail</h2>
                <div className="rounded-md border border-border bg-surface px-4 py-3">
                  <p className="text-body font-semibold text-fg">{leadMail.title}</p>
                  <p className="text-small text-muted">{leadMail.from}</p>
                  <p className="line-clamp-1 text-small text-faint">{leadMail.preview}</p>
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => onDraft(leadMail.title)}>
                    Draft reply
                  </Button>
                </div>
              </section>
            )}

            <section aria-label="Content trends">
              <h2 className="mb-2 text-small font-semibold text-muted">Content trends</h2>
              <div className="rounded-md border border-border bg-surface px-4 py-3">
                <p className="text-small text-muted">{TRENDS.headline.label}</p>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-h1 tabular-nums text-fg">{TRENDS.headline.value}</p>
                  <p className="text-small font-semibold text-success">{TRENDS.delta}</p>
                </div>
                <p className="mt-2 text-small text-fg">{TRENDS.brief}</p>
              </div>
            </section>

            <section aria-label="Social capture">
              <h2 className="mb-2 text-small font-semibold text-muted">Social capture</h2>
              <div className="overflow-hidden rounded-md border border-border bg-surface">
                <div className="grid grid-cols-3">
                  {CAPTURE.items.slice(0, 3).map((item) => (
                    <div key={item.title} className="border-r border-border last:border-r-0">
                      <div className="relative aspect-[5/4] bg-subtle">
                        <img src={item.thumb} alt="" className="h-full w-full object-cover" />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="px-3 py-2 text-caption text-faint">{CAPTURE.newCount} new since {CAPTURE.since}</p>
              </div>
            </section>

            <p className="text-caption text-faint">Rank watch and 1 more on desktop.</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-5 py-3">
          <Button size="sm" variant="secondary" onClick={onBuild}>Build home</Button>
          <p className="text-caption text-faint">Long-press a widget to replace it.</p>
        </div>
      </div>
    </div>
  );
}

function ProposalCanvas({ onAdd, onSpace }: { onAdd: () => void; onSpace: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 py-6 sm:px-8">
      <p className="text-small text-muted">Chat · building a tile</p>
      <div className="self-end max-w-[34rem] rounded-md bg-primary-tint px-4 py-3 text-body text-fg">
        Build me a content trends report from search, analytics, and social.
      </div>
      <div className="flex max-w-[36rem] flex-col gap-3">
        <p className="text-body text-fg">
          I can put that on Home as a report — search, analytics, and social joined, with movement only after the first successful refresh. Here’s the tile. Nothing is placed until you add it.
        </p>
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <p className="text-small font-semibold text-muted">Proposed tile</p>
          </div>
          <div className="p-4">
            <ReportTile preview stacked />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            <Button onClick={onAdd}>Add to Home</Button>
            <Button variant="secondary" onClick={onSpace}>Open as a Space instead</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeMock({
  initialScreen,
  embedded = false,
}: {
  initialScreen?: string;
  embedded?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const fromUrl = isHomeMockScreen(params.get('screen'))
    ? params.get('screen')
    : isHomeMockScreen(params.get('mock'))
      ? params.get('mock')
      : null;
  const current: MockScreen = isHomeMockScreen(fromUrl)
    ? fromUrl
    : isHomeMockScreen(initialScreen ?? null)
      ? (initialScreen as MockScreen)
      : 'populated';

  const [galleryOver, setGalleryOver] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tuneTarget, setTuneTarget] = useState<TuneTarget>('trends');

  const setScreen = (id: MockScreen) => {
    setGalleryOver(false);
    setReplacing(null);
    const next = new URLSearchParams(params);
    next.set('screen', id);
    next.delete('mock');
    setParams(next, { replace: true });
  };
  const openGallery = () => {
    setReplacing(null);
    if (current === 'blank') setScreen('gallery');
    else setGalleryOver(true);
  };
  const canvasHandlers = {
    onBuild: openGallery,
    onTune: (target: TuneTarget) => { setTuneTarget(target); setScreen('tune'); },
    onAsk: () => setScreen('proposal'),
    onReplace: (label: string) => { setReplacing(label); setGalleryOver(true); },
    onDraft: (title: string) => setNotice(`Draft reply to “${title}” staged. Approve it in Needs you — same door as Inbox.`),
    onPrep: () => setNotice('Clem will prep Aldous — intake in Chat, with the notes she already has.'),
    onLookInto: (title: string) => setNotice(`Clem will look into “${title}” from the last successful snapshot.`),
    onOpenSpace: () => setNotice('This widget is a concentrated Space. The room — the full page — opens from here when you outgrow the glance.'),
  };
  const galleryOpen = current === 'gallery' || galleryOver;

  const body = useMemo(() => {
    if (current === 'proposal') {
      return <ProposalCanvas onAdd={() => setScreen('populated')} onSpace={() => setScreen('populated')} />;
    }
    if (current === 'phone') {
      return (
        <PhoneHome
          notice={notice}
          onAsk={canvasHandlers.onAsk}
          onBuild={canvasHandlers.onBuild}
          onDraft={canvasHandlers.onDraft}
          onPrep={canvasHandlers.onPrep}
        />
      );
    }
    if (current === 'blank' || current === 'gallery') {
      return <BlankCanvas onBuild={() => setScreen('gallery')} onAsk={() => setScreen('proposal')} />;
    }
    if (current === 'baseline') {
      return <PopulatedCanvas baseline notice={notice} {...canvasHandlers} />;
    }
    return (
      <PopulatedCanvas
        highlightTrends={current === 'tune' && tuneTarget === 'trends'}
        notice={notice}
        {...canvasHandlers}
      />
    );
  }, [current, notice, tuneTarget]);

  const canvas = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">{body}</div>
      {galleryOpen && (
        <GallerySheet
          replacing={replacing}
          onClose={() => {
            setReplacing(null);
            if (current === 'gallery') setScreen('blank');
            else setGalleryOver(false);
          }}
          onAdd={(id) => {
            if (replacing) {
              setNotice(`${replacing} replaced. The slot stayed; the widget changed.`);
              setReplacing(null);
              setGalleryOver(false);
              return;
            }
            void id;
            setScreen('populated');
          }}
          onBuildRecipe={() => setScreen('proposal')}
        />
      )}
    </div>
  );

  const shell = (
    <div className="flex min-h-0 flex-1">
      {canvas}
      {current === 'tune' && <TunePanel key={tuneTarget} target={tuneTarget} onClose={() => setScreen('populated')} />}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex h-full flex-col">
        {shell}
        <ScreenSwitcher current={current} onChange={setScreen} />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-fg">
      <MockSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MockTopBar />
        {shell}
        <ScreenSwitcher current={current} onChange={setScreen} />
      </div>
    </div>
  );
}
