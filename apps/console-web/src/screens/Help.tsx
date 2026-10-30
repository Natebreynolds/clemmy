import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageCircle, Keyboard, RefreshCw, LifeBuoy, Map as MapIcon, Sparkles } from 'lucide-react';
import { APP_PLACES, appGuidanceHref } from '@clem/chat-engine';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { getBuildInfo } from '@/lib/advanced';
import { clemmy, isDesktop } from '@/lib/clemmy';
import { updateCheckFeedback } from '@/lib/update-check-feedback';
import { editableChatDraft } from '@/lib/editable-chat-draft';
import { helpDestinations } from '@/lib/help-destinations';

const modKey = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

/** First things a newcomer can ask (owner 2026-10-18: novice-first). Each
 *  only reads or shows how; nothing here changes anything on its own. */
const TRY_ASKING = [
  'What can you help me with?',
  'What needs my attention today?',
  'Show me how to set up something that runs every Monday morning.',
  'Build me a Space to keep track of my goals this month.',
] as const;

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
  const openHelpDraft = (text: string) => {
    const target = editableChatDraft(text);
    if (target) navigate(target.pathname, { state: target.state });
  };

  const checkUpdates = async () => {
    const bridge = clemmy();
    if (!bridge?.updaterCheck) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const result = await bridge.updaterCheck();
      setCheckNote(updateCheckFeedback(result, build.data?.version));
    } catch {
      setCheckNote("Couldn't check for updates right now — try again in a moment.");
    } finally {
      setChecking(false);
    }
  };

  const [savingDiagnostics, setSavingDiagnostics] = useState(false);
  const [diagnosticsNote, setDiagnosticsNote] = useState<string | null>(null);
  const saveDiagnostics = async () => {
    const bridge = clemmy();
    if (!bridge?.saveDiagnostics) return;
    setSavingDiagnostics(true);
    setDiagnosticsNote(null);
    try {
      const result = await bridge.saveDiagnostics();
      setDiagnosticsNote(result.saved && result.fileName
        ? `Saved ${result.fileName} to your Downloads folder. Send that file to support.`
        : "Couldn't save the diagnostics file. Use the tray menu's Open Log File instead.");
    } catch {
      setDiagnosticsNote("Couldn't save the diagnostics file. Use the tray menu's Open Log File instead.");
    } finally {
      setSavingDiagnostics(false);
    }
  };

  return (
    <Page title="Help" subtitle="How to get started, where things are, and how to reach support" width="reading">
      <div className="space-y-4">
        <Card className="flex items-center gap-3 p-5">
          <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
          <div className="flex-1">
            <h3 className="text-h3 text-fg">Ask Clementine for help</h3>
            <p className="text-small text-muted">The fastest way to get unstuck — just ask.</p>
          </div>
          <Button size="sm" onClick={() => openHelpDraft('Help me find my way around Clem.')}>Ask for help</Button>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Things you can ask Clem</h3></div>
          <p className="mb-2 text-small text-muted">Opens an editable draft. You choose when to send.</p>
          <ul className="space-y-1">
            {TRY_ASKING.map((ask) => (
              <li key={ask}>
                <button type="button" onClick={() => openHelpDraft(ask)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-body text-fg hover:bg-subtle">
                  <span>“{ask}”</span>
                  <span className="shrink-0 text-small font-semibold text-primary-ink">Draft</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2"><MapIcon className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Where things are</h3></div>
          <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {helpDestinations(APP_PLACES).map((place) => (
              <li key={place.id} className="flex items-start gap-2">
                <Link to={place.desktop} className="group block min-w-0 flex-1 rounded-md px-2 py-1.5 hover:bg-subtle">
                  <span className="block text-body font-semibold text-fg group-hover:text-primary-ink">{place.name}</span>
                  <span className="block text-small text-muted">{place.purpose}</span>
                </Link>
                {appGuidanceHref(place.id, 'desktop') ? <Link to={appGuidanceHref(place.id, 'desktop')!} state={{ clemGuidanceOrigin: '/help' }}
                  className="inline-flex min-h-11 shrink-0 items-center rounded-md px-2 text-small font-semibold text-primary hover:underline"
                  aria-label={`Show me ${place.name}`}>Show me</Link> : null}
              </li>
            ))}
          </ul>
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
            <p className="text-small text-muted">{build.data?.version ? `${build.isError ? 'Last loaded: ' : ''}Clementine ${build.data.version}` : build.isError ? 'Version information unavailable.' : 'Loading…'}</p>
            {build.isError && <Button variant="link" size="sm" onClick={() => void build.refetch()}>Retry version</Button>}
            {checkNote && <p className="mt-1 text-small text-primary" role="status" aria-live="polite">{checkNote}</p>}
          </div>
          {isDesktop() && (
            <Button variant="secondary" size="sm" onClick={checkUpdates} disabled={checking}>
              <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden /> Check for updates
            </Button>
          )}
        </Card>

        {clemmy()?.saveDiagnostics && (
          <Card className="flex flex-wrap items-center gap-3 p-5">
            <div className="flex-1">
              <h3 className="text-h3 text-fg">Something not working?</h3>
              <p className="text-small text-muted">
                Save a diagnostics file and send it to support. Secrets, email addresses, your user folder and this computer’s name are removed first.
              </p>
              {diagnosticsNote && <p className="mt-1 text-small text-primary" role="status" aria-live="polite">{diagnosticsNote}</p>}
            </div>
            <Button variant="secondary" size="sm" onClick={saveDiagnostics} disabled={savingDiagnostics}>
              <LifeBuoy className="h-4 w-4" aria-hidden /> Save diagnostics
            </Button>
          </Card>
        )}
      </div>
    </Page>
  );
}
