import { PanelLeftClose, PanelLeft, Search, Mic } from 'lucide-react';
import { Button } from './ui/Button';
import { ThemeToggle } from './ThemeToggle';
import { HealthIndicator } from './HealthIndicator';
import { cn } from '@/lib/cn';

const modKey = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

export function TopBar({
  title,
  onToggleSidebar,
  sidebarCollapsed,
}: {
  title: string;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
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

      <h1 className="truncate text-h3 font-semibold text-fg">{title}</h1>

      <div className="ml-auto flex items-center gap-1.5">
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

        <Button size="sm" onClick={openVoice} className="gap-2">
          <Mic className="h-4 w-4" aria-hidden />
          <span className="hidden md:inline">Talk</span>
        </Button>
      </div>
    </header>
  );
}
