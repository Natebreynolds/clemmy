import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Keyboard, RefreshCw } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { getBuildInfo } from '@/lib/advanced';
import { clemmy, isDesktop } from '@/lib/clemmy';

const modKey = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

const SHORTCUTS: [string, string][] = [
  [`${modKey} K`, 'Search or jump anywhere'],
  ['Enter', 'Send a message'],
  ['Shift + Enter', 'New line in the composer'],
];

export function Help() {
  const navigate = useNavigate();
  const build = usePoll(['build-info'], getBuildInfo, 60000);
  const [checking, setChecking] = useState(false);
  // Result of the last manual check. The updater bridge surfaces an
  // actionable update via the global UpdaterBanner, but an "up to date"
  // result had nowhere to land — so a click gave zero feedback. Show it here.
  const [checkNote, setCheckNote] = useState<string | null>(null);

  const checkUpdates = async () => {
    const bridge = clemmy();
    if (!bridge?.updaterCheck) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const result = await bridge.updaterCheck();
      const state = result && typeof result === 'object' && 'state' in result
        ? String((result as { state?: unknown }).state)
        : undefined;
      if (state === 'available' || state === 'downloading' || state === 'ready-to-install') {
        setCheckNote('An update is available — see the prompt at the bottom-left.');
      } else {
        const v = build.data?.version ? ` (v${build.data.version})` : '';
        setCheckNote(`You're on the latest version${v}.`);
      }
    } catch {
      setCheckNote("Couldn't check for updates right now — try again in a moment.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <Page title="Help" subtitle="Guides, shortcuts, and version" width="reading">
      <div className="space-y-4">
        <Card className="flex items-center gap-3 p-5">
          <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Ask Clementine for help</h3>
            <p className="text-small text-muted">The fastest way to get unstuck — just ask.</p>
          </div>
          <Button size="sm" onClick={() => navigate('/chat')}>Open chat</Button>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2"><Keyboard className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Keyboard shortcuts</h3></div>
          <ul className="space-y-2">
            {SHORTCUTS.map(([keys, desc]) => (
              <li key={keys} className="flex items-center justify-between">
                <span className="text-body text-muted">{desc}</span>
                <kbd className="rounded border border-border bg-subtle px-2 py-0.5 font-mono text-caption text-fg">{keys}</kbd>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex flex-wrap items-center gap-3 p-5">
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Version</h3>
            <p className="text-small text-muted">{build.data?.version ? `Clementine ${build.data.version}` : 'Loading…'}</p>
            {checkNote && <p className="mt-1 text-small text-primary" role="status" aria-live="polite">{checkNote}</p>}
          </div>
          {isDesktop() && (
            <Button variant="secondary" size="sm" onClick={checkUpdates} disabled={checking}>
              <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden /> Check for updates
            </Button>
          )}
        </Card>
      </div>
    </Page>
  );
}
