import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import { computerScreenUrl, getComputerDriver } from '@/lib/computer-driver';

// Your computer, live, in the conversation: once the driver is on, a strip
// under the header opens a view that refreshes from the driver's own screen
// capture every two seconds. Watching only; Clem's cursor is its own.
export function ComputerDock({ conversationId }: { conversationId?: string } = {}) {
  const status = usePoll(['computer-driver'], getComputerDriver, 20_000);
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const on = Boolean(status.data?.installed && status.data?.connected);
  useEffect(() => {
    if (!open || !on) { setSrc(null); return; }
    let cancelled = false;
    const tick = () => { if (!cancelled) setSrc(computerScreenUrl(conversationId)); };
    tick();
    const timer = setInterval(tick, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, on, conversationId]);
  if (!on) return null;
  return (
    <div className="cloud-browser-strip" data-computer-dock>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}><Monitor size={16} aria-hidden /> Your computer</button>
      <span className="cloud-browser-strip-note">{open ? 'The window Clem is working in, even behind yours. Watching only.' : 'See what Clem sees on this Mac'}</span>
      {open && (
        <div className="mt-2 w-full">
          {src && !failed
            ? <img src={src} alt="Your screen as Clem sees it" className="max-h-72 w-full rounded-md border border-border/60 bg-subtle object-contain" onError={() => setFailed(true)} />
            : <p className="text-small text-muted">{failed ? 'No picture yet. If macOS has not allowed Screen Recording for Clementine, allow it in System Settings, then open this again.' : 'Asking the driver for the screen…'}</p>}
        </div>
      )}
    </div>
  );
}
