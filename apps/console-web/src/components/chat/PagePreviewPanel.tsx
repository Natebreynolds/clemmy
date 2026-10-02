/**
 * A page Clem made, looked at beside the conversation. Opening it from a
 * reply used to replace the chat with the project's page viewer; the panel
 * shows the same page over the right side of the window and closes back to
 * the conversation where it was. Open in browser still gives the page its own
 * window, and the full viewer stays one click away.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { projectPagePlace, projectPageTitle } from '@clem/chat-engine';
import { ProjectPagePreview } from '@/screens/ProjectPageViewer';
import { pageViewerPath, type ProjectPageView } from '@/lib/projects';

export function PagePreviewPanel({ projectId, page, onClose }: {
  projectId: string;
  page: ProjectPageView;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const title = projectPageTitle(page);
  const place = projectPagePlace(page);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="page-preview-title">
      <button type="button" aria-label="Close the page and return to the conversation" className="absolute inset-0 bg-black/25" onClick={close} />
      <section
        ref={panelRef}
        className="relative flex h-full w-full flex-col border-l border-border bg-surface shadow-lg sm:max-w-[min(1100px,72vw)]"
      >
        <header className="flex min-w-0 items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="page-preview-title" className="truncate text-body font-semibold text-fg" title={title}>{title}</h2>
            <p className="truncate text-caption text-muted" title={place}>{place}</p>
          </div>
          <Link
            to={pageViewerPath(projectId, page.id)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-small font-semibold text-muted transition-colors hover:bg-subtle hover:text-fg"
          >
            <Maximize2 className="h-4 w-4" aria-hidden /> Full view
          </Link>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-muted transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3">
          <ProjectPagePreview projectId={projectId} page={page} />
        </div>
      </section>
    </div>
  );
}
