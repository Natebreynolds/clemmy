/**
 * The pages made in this project: HTML files that work here wrote into its
 * linked local projects, newest first. A row says what the page is called,
 * where it is and when it was made, and opens it to be looked at. It is a
 * list to read; nothing here changes a page.
 *
 * With no linked local project and no page, nothing is drawn: a project
 * that has nowhere to write a page has nothing to say about them.
 */
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import {
  PROJECT_PAGES_EMPTY, PROJECT_PAGES_HINT, PROJECT_PAGES_LABEL,
  projectLinkedLocalProject, projectPagePlace, projectPages, projectPageTitle,
} from '@clem/chat-engine';
import { relativeTime } from '@/lib/inbox';
import { pageViewerPath, type ProjectOverview } from '@/lib/projects';
import { ProjectSection, QuietNote } from './ProjectSection';

export function ProjectPages({ overview }: { overview: ProjectOverview }) {
  const pages = projectPages(overview);
  const linked = overview.resources.some((resource) => projectLinkedLocalProject(resource) !== null);
  if (pages.length === 0 && !linked) return null;

  return (
    <ProjectSection title={PROJECT_PAGES_LABEL} count={pages.length} hint={PROJECT_PAGES_HINT}>
      {pages.length === 0 ? (
        <QuietNote>{PROJECT_PAGES_EMPTY}</QuietNote>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {pages.map((page) => {
            const title = projectPageTitle(page);
            const place = projectPagePlace(page);
            const made = relativeTime(page.madeAt);
            return (
              <li key={page.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-5 py-3 first:border-t-0">
                <FileText className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-fg" title={title}>{title}</div>
                  <p className="truncate text-caption text-muted" title={place}>{place}</p>
                </div>
                {made && (
                  <span className="shrink-0 text-caption text-faint">
                    <span className="sr-only">Made </span>
                    {made === 'now' ? 'just now' : `${made} ago`}
                  </span>
                )}
                <Link
                  to={pageViewerPath(overview.project.id, page.id)}
                  aria-label={`View the page ${title}`}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface px-3 text-small font-semibold text-fg transition-colors duration-fast hover:border-border-strong hover:bg-hover"
                >
                  View
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </ProjectSection>
  );
}
