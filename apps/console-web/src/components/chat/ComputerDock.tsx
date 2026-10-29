import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Monitor, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { computerDriverIsConnected, computerScreenUrl, getComputerDriver } from '@/lib/computer-driver';
import { startComputerScreenCycle, type ComputerScreenCycle } from '@/lib/computer-screen-cycle';

interface ComputerControl {
  open: boolean;
  toggle: () => void;
  close: () => void;
  src: string | null;
  failed: boolean;
  loaded: (source: string) => void;
  fail: (source: string) => void;
  retry: () => void;
}
const ComputerContext = createContext<ComputerControl | null>(null);
export function useComputerControl(): ComputerControl | null { return useContext(ComputerContext); }

/** Watching is opt-in and belongs to this chat. Changing chats closes the view. */
export function ComputerWorkspace({ conversationId, children }: { conversationId?: string; children: ReactNode }) {
  const status = usePoll(['computer-driver'], getComputerDriver, 20_000);
  const [watching, setWatching] = useState<{ conversationId?: string; open: boolean }>({ conversationId, open: false });
  const open = watching.conversationId === conversationId && watching.open;
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cycle = useRef<ComputerScreenCycle | null>(null);
  const connected = computerDriverIsConnected(status.data) && status.data?.screenViewAvailable === true;
  useEffect(() => {
    if (!open || !connected || failed) { setSrc(null); return; }
    const active = startComputerScreenCycle({
      source: () => new URL(computerScreenUrl(conversationId), window.location.href).href,
      show: setSrc,
      fail: () => setFailed(true),
      schedule: (run, delayMs) => { const timer = window.setTimeout(run, delayMs); return () => window.clearTimeout(timer); },
    });
    cycle.current = active;
    return () => { active.stop(); if (cycle.current === active) cycle.current = null; };
  }, [open, connected, failed, conversationId, attempt]);
  useEffect(() => { setWatching({ conversationId, open: false }); setFailed(false); setSrc(null); }, [conversationId]);
  useEffect(() => { if (!connected) { setWatching({ conversationId, open: false }); setFailed(false); } }, [connected, conversationId]);
  const retry = () => { setFailed(false); setSrc(null); setAttempt(value => value + 1); };
  const toggle = () => { setFailed(false); setSrc(null); setWatching({ conversationId, open: !open }); };
  return <ComputerContext.Provider value={connected ? { open, toggle, close: () => setWatching({ conversationId, open: false }), src, failed, loaded: source => cycle.current?.loaded(source), fail: source => cycle.current?.failed(source), retry } : null}>{children}</ComputerContext.Provider>;
}

/** A compact view below the existing header; capture starts only after opening. */
export function ComputerView() {
  const computer = useComputerControl();
  if (!computer?.open) return null;
  return <section className="shrink-0 border-b border-border bg-subtle px-5 py-3" aria-label="Your computer" data-computer-dock>
    <div className="mb-2 flex items-center gap-3">
      <p className="min-w-0 flex-1 text-small text-muted">A view of your connected computer. Watching only.</p>
      <Button size="icon" variant="ghost" onClick={computer.close} aria-label="Close computer view"><X className="h-4 w-4" aria-hidden /></Button>
    </div>
    {computer.src && !computer.failed
      ? <img src={computer.src} alt="Screen from your connected computer" className="max-h-72 w-full rounded-md border border-border bg-surface object-contain" onLoad={event => computer.loaded(event.currentTarget.currentSrc || event.currentTarget.src)} onError={event => computer.fail(event.currentTarget.src)} />
      : computer.failed ? <div className="flex flex-wrap items-center gap-3" role="status">
        <p className="min-w-0 flex-1 text-small text-muted">The screen couldn’t be shown. Check the computer connection and permissions in Apps & devices.</p>
        <Button size="sm" variant="secondary" onClick={computer.retry}><RefreshCw className="h-4 w-4" aria-hidden /> Try again</Button>
        <Link to="/connect" className="text-small font-semibold text-primary hover:underline">Apps & devices</Link>
      </div> : <p className="text-small text-muted" role="status">Opening the computer view…</p>}
  </section>;
}

function StandaloneDock() {
  const computer = useComputerControl();
  if (!computer) return null;
  return <>
    <div className="cloud-browser-strip">
      <button type="button" onClick={computer.toggle} aria-expanded={computer.open}><Monitor size={16} aria-hidden /> Computer</button>
      <span className="cloud-browser-strip-note">Watch your connected computer</span>
    </div>
    <ComputerView />
  </>;
}

export function ComputerDock({ conversationId }: { conversationId?: string } = {}) {
  return <ComputerWorkspace conversationId={conversationId}><StandaloneDock /></ComputerWorkspace>;
}
