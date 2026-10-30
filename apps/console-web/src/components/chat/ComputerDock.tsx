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

/** The computer view belongs to this chat. It opens on its own when Clem starts
 *  working on the computer here (`active`), and the owner can open or close it
 *  any time; closed while she works, it stays closed until her next task.
 *  Changing chats closes it. It is a side panel beside the conversation, the
 *  same as the cloud browser, so the chat stays readable while she works. */
export function ComputerWorkspace({ conversationId, active = false, children }: { conversationId?: string; active?: boolean; children: ReactNode }) {
  const status = usePoll(['computer-driver'], getComputerDriver, 20_000);
  const [watching, setWatching] = useState<{ conversationId?: string; open: boolean }>(() => ({ conversationId, open: active }));
  const open = watching.conversationId === conversationId && watching.open;
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cycle = useRef<ComputerScreenCycle | null>(null);
  const closedWhileActive = useRef(false);
  const connected = computerDriverIsConnected(status.data) && status.data?.screenViewAvailable === true;
  useEffect(() => {
    if (!open || !connected || failed) { setSrc(null); return; }
    const running = startComputerScreenCycle({
      source: () => new URL(computerScreenUrl(conversationId), window.location.href).href,
      show: setSrc,
      fail: () => setFailed(true),
      schedule: (run, delayMs) => { const timer = window.setTimeout(run, delayMs); return () => window.clearTimeout(timer); },
    });
    cycle.current = running;
    return () => { running.stop(); if (cycle.current === running) cycle.current = null; };
  }, [open, connected, failed, conversationId, attempt]);
  useEffect(() => { setWatching({ conversationId, open: false }); setFailed(false); setSrc(null); closedWhileActive.current = false; }, [conversationId]);
  useEffect(() => { if (!connected) { setWatching({ conversationId, open: false }); setFailed(false); } }, [connected, conversationId]);
  useEffect(() => {
    if (!active) { closedWhileActive.current = false; return; }
    if (connected && !closedWhileActive.current) { setFailed(false); setWatching({ conversationId, open: true }); }
  }, [active, connected, conversationId]);
  const retry = () => { setFailed(false); setSrc(null); setAttempt(value => value + 1); };
  const close = () => { if (active) closedWhileActive.current = true; setWatching({ conversationId, open: false }); };
  const toggle = () => { setFailed(false); setSrc(null); if (open) close(); else setWatching({ conversationId, open: true }); };
  const control: ComputerControl | null = connected
    ? { open, toggle, close, src, failed, loaded: source => cycle.current?.loaded(source), fail: source => cycle.current?.failed(source), retry }
    : null;
  if (!control) return <ComputerContext.Provider value={null}>{children}</ComputerContext.Provider>;
  return <ComputerContext.Provider value={control}><div className={`cloud-browser-workspace${open ? ' is-open' : ''}`}>
    <div className="cloud-browser-conversation">{children}</div>
    {open ? <ComputerPanel /> : null}
  </div></ComputerContext.Provider>;
}

/** The side panel: what the computer shows, refreshed while it is open. */
function ComputerPanel() {
  const computer = useComputerControl();
  if (!computer?.open) return null;
  return <aside className="cloud-browser-panel computer-panel" aria-label="Your computer" data-computer-dock>
    <header>
      <div className="min-w-0">
        <h2>Your computer</h2>
        <p className="text-small text-muted">Watching only. Clem works in her own window; your mouse stays yours.</p>
      </div>
      <Button size="icon" variant="ghost" onClick={computer.close} aria-label="Close computer view"><X className="h-4 w-4" aria-hidden /></Button>
    </header>
    <div className="computer-panel-view">
      {computer.src && !computer.failed
        ? <img src={computer.src} alt="Screen from your connected computer" onLoad={event => computer.loaded(event.currentTarget.currentSrc || event.currentTarget.src)} onError={event => computer.fail(event.currentTarget.src)} />
        : computer.failed ? <div className="flex flex-wrap items-center gap-3" role="status">
          <p className="min-w-0 flex-1 text-small text-muted">The screen couldn’t be shown. Check the computer connection and permissions in Apps & devices.</p>
          <Button size="sm" variant="secondary" onClick={computer.retry}><RefreshCw className="h-4 w-4" aria-hidden /> Try again</Button>
          <Link to="/connect" className="text-small font-semibold text-primary hover:underline">Apps & devices</Link>
        </div> : <p className="text-small text-muted" role="status">Opening the computer view…</p>}
    </div>
  </aside>;
}

const HIDDEN_KEY = 'clem.computer-button.hidden';
function readHidden(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}
function writeHidden(hidden: boolean): void {
  try { if (hidden) window.localStorage.setItem(HIDDEN_KEY, '1'); else window.localStorage.removeItem(HIDDEN_KEY); } catch { /* a convenience only */ }
}

/** One small button. The owner can hide it; it comes back on its own in a chat
 *  where Clem uses the computer, because that is when there is something to
 *  watch. A full-width "Watch your connected computer" bar sat on every chat. */
function StandaloneDock({ used }: { used: boolean }) {
  const computer = useComputerControl();
  const [hidden, setHidden] = useState(readHidden);
  if (!computer) return null;
  if (hidden && !used && !computer.open) return null;
  return <>
    <div className="cloud-browser-strip">
      <button type="button" onClick={computer.toggle} aria-expanded={computer.open}><Monitor size={16} aria-hidden /> Computer</button>
      {!used && !computer.open
        ? <button type="button" className="cloud-browser-strip-hide" aria-label="Hide the Computer button until Clem uses your computer"
            title="Hide until Clem uses your computer" onClick={() => { writeHidden(true); setHidden(true); }}><X size={14} aria-hidden /></button>
        : null}
    </div>
  </>;
}

/** The chat page's computer control and panel; the conversation is its child. */
export function ComputerDock({ conversationId, used = false, active = false, children }: { conversationId?: string; used?: boolean; active?: boolean; children?: ReactNode } = {}) {
  return <ComputerWorkspace conversationId={conversationId} active={active}><StandaloneDock used={used || active} />{children}</ComputerWorkspace>;
}
