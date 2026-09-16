import { Activity, PanelLeftClose, PanelLeft, Search, Mic, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/Button';
import { ThemeToggle } from './ThemeToggle';
import { HealthIndicator } from './HealthIndicator';
import { ModelStatusChips } from './ModelStatusChips';

const modKey = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

export function TopBar({
  title,
  onToggleSidebar,
  sidebarCollapsed,
  runningCount,
  needsYouCount,
  onOpenTasks,
}: {
  title: string;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
  /** Both counts come from the ONE shared presenter (presentWorkingNow) via
   *  AppShell. TopBar renders them verbatim and derives nothing. */
  runningCount: number;
  needsYouCount: number;
  onOpenTasks: () => void;
}) {
  const openPalette = () => window.dispatchEvent(new Event('clem:command-palette'));
  const openVoice = () => window.dispatchEvent(new Event('clem:open-voice'));
  // The customize panel is owned by the Home screen; the bar only rings the
  // bell, on every route, so "shape my window" is always one click away.
  const openCustomize = () => window.dispatchEvent(new Event('clem:customize-home'));

  return (
    <header className="app-drag flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft className="h-5 w-5" aria-hidden /> : <PanelLeftClose className="h-5 w-5" aria-hidden />}
      </Button>

      <h1 className="max-w-[18rem] shrink-0 truncate text-h3 font-semibold text-fg">{title}</h1>

      {/* Usage meters for every connected model account, on every screen. */}
      <ModelStatusChips />

      {/* shrink-0: the controls on the right must never clip, whatever grows on the left */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* One icon, like its neighbors: the palette jumps anywhere and the
            shortcut lives in the tooltip. A labeled search box read as a
            feature of its own and took the room the title needed. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={openPalette}
          aria-label={`Search or jump anywhere (${modKey}K)`}
          title={`Search or jump anywhere · ${modKey}K`}
        >
          <Search className="h-5 w-5" aria-hidden />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenTasks}
          aria-label={[
            'Running',
            runningCount > 0 ? `${runningCount} running` : null,
            needsYouCount > 0 ? `${needsYouCount} waiting on you` : null,
          ].filter(Boolean).join(', ')}
          title="Everything Clementine is working on right now"
          className="relative gap-2"
        >
          <Activity className="h-4 w-4" aria-hidden />
          <span className="hidden lg:inline">Running</span>
          {/* Running and needs-you are two different invitations — never one
              lump sum (the "37 current tasks" pill was dead tasks). */}
          {runningCount > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-caption font-bold text-primary-fg">
              {runningCount > 99 ? '99+' : runningCount}
            </span>
          )}
        </Button>

        <HealthIndicator />
        <ThemeToggle />

        <Button
          variant="ghost"
          size="icon"
          onClick={openCustomize}
          aria-label="Customize home"
          title="Customize home"
        >
          <SlidersHorizontal className="h-5 w-5" aria-hidden />
        </Button>

        {/* Peer weight, deliberately. As a FILLED primary button this was the
            loudest control in the whole shell, which made the console's
            standing call to action "start a conversation" rather than "show me
            the work". The voice overlay is unchanged — only its volume is. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={openVoice}
          aria-label="Talk to Clementine"
          title="Talk to Clementine"
          className="gap-2"
        >
          <Mic className="h-4 w-4" aria-hidden />
          <span className="hidden md:inline">Talk</span>
        </Button>
      </div>
    </header>
  );
}
