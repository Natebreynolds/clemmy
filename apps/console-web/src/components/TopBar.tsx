import { Activity, PanelLeftClose, PanelLeft, Search, Mic } from 'lucide-react';
import { Button } from './ui/Button';
import { ThemeToggle } from './ThemeToggle';
import { HealthIndicator } from './HealthIndicator';
import { ModelStatusChips } from './ModelStatusChips';
import { cn } from '@/lib/cn';

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

      <h1 className="shrink truncate text-h3 font-semibold text-fg">{title}</h1>

      <ModelStatusChips />

      {/* shrink-0: the controls on the right must never clip, whatever grows on the left */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={openPalette}
          className={cn(
            'app-no-drag hidden items-center gap-2 rounded-md border border-border bg-canvas px-3 py-1.5 text-small text-muted',
            'transition-colors hover:border-border-strong hover:text-fg cursor-pointer sm:inline-flex',
          )}
          aria-label="Search or jump to"
          title="Search or jump to"
        >
          <Search className="h-4 w-4" aria-hidden />
          <span>Search…</span>
          <kbd className="ml-2 rounded border border-border px-1 font-mono text-caption text-faint">{modKey}K</kbd>
        </button>

        <HealthIndicator />
        <ThemeToggle />

        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenTasks}
          aria-label={[
            'Tasks',
            runningCount > 0 ? `${runningCount} running` : null,
            needsYouCount > 0 ? `${needsYouCount} waiting on you` : null,
          ].filter(Boolean).join(', ')}
          title="Everything Clem is working on right now"
          className="relative gap-2"
        >
          <Activity className="h-4 w-4" aria-hidden />
          <span className="hidden lg:inline">Tasks</span>
          {/* Running and needs-you are two different invitations — never one
              lump sum (the "37 current tasks" pill was dead tasks). */}
          {runningCount > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-caption font-bold text-primary-fg">
              {runningCount > 99 ? '99+' : runningCount}
            </span>
          )}
          {needsYouCount > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-caption font-bold text-primary-fg">
              {needsYouCount > 99 ? '99+' : needsYouCount}
            </span>
          )}
        </Button>

        <Button size="sm" onClick={openVoice} className="gap-2">
          <Mic className="h-4 w-4" aria-hidden />
          <span className="hidden md:inline">Talk</span>
        </Button>
      </div>
    </header>
  );
}
