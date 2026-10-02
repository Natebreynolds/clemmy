/**
 * One page made in a project, shown as the document it is: framed in a
 * sandbox at the width the owner chooses, with a way to open it in their own
 * browser. Looking at a page changes nothing.
 *
 * The page is found again in the project before anything is framed, and the
 * document is asked for once ahead of the frame, because a sandboxed frame
 * cannot say why it is empty. A page that is gone, or too large, is said in
 * words and no frame is drawn.
 *
 * The frame is given the shared sandbox and nothing wider: the page runs its
 * own scripts, and has no origin, no forms, no popups and no say over the
 * window it is shown in.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Monitor, RotateCw, Smartphone, Tablet, type LucideIcon } from 'lucide-react';
import {
  PROJECT_PAGE_FRAME_NOTE, PROJECT_PAGE_FRAME_SANDBOX,
  projectPagePlace, projectPageRefusal, projectPages, projectPageTitle,
} from '@clem/chat-engine';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import {
  apiErrorCode, checkPageDocument, getProjectOverview, openPageInBrowser, pageDocumentUrl, pageRefusalText, projectKeys,
  type ProjectPageView,
} from '@/lib/projects';

type WidthChoice = 'desktop' | 'tablet' | 'phone';

/** The widths a page is looked at in. Desktop is as wide as the window allows. */
const WIDTHS: ReadonlyArray<{ id: WidthChoice; label: string; width: number | null; Icon: LucideIcon }> = [
  { id: 'desktop', label: 'Desktop', width: null, Icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: 768, Icon: Tablet },
  { id: 'phone', label: 'Phone', width: 390, Icon: Smartphone },
];

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export function ProjectPageViewer() {
  const { id = '', pageId = '' } = useParams();
  return <Viewer key={`${id}/${pageId}`} projectId={id} pageId={pageId} />;
}

function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="mb-3 inline-flex max-w-full items-center gap-1 text-small font-semibold text-muted hover:text-fg">
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden /> <span className="truncate">{children}</span>
    </Link>
  );
}

/** Said in place of a page that is not there, with the way back. */
function PageGone({ to, back }: { to: string; back: string }) {
  return (
    <Page width="reading">
      <BackLink to={to}>{back}</BackLink>
      <div className="rounded-lg border border-border bg-surface px-5 py-4">
        <p role="alert" className="text-body text-fg">{projectPageRefusal('PAGE_NOT_FOUND')}</p>
        <Link to={to} className="mt-2 inline-flex text-small font-semibold text-primary hover:underline">Back to {back}</Link>
      </div>
    </Page>
  );
}

function Viewer({ projectId, pageId }: { projectId: string; pageId: string }) {
  // Read each time the viewer opens; the project page keeps the same record.
  const overviewQ = usePoll(projectKeys.overview(projectId), () => getProjectOverview(projectId), 0, { enabled: Boolean(projectId) });
  const overview = overviewQ.data;

  if (overviewQ.isLoading && !overview) {
    return (
      <Page className="max-w-none">
        <div role="status">
          <span className="sr-only">Loading this page</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-4 h-8 w-72 max-w-full" />
          <Skeleton className="mt-6 h-10 w-full" />
          <Skeleton className="mt-4 h-[480px] w-full" />
        </div>
      </Page>
    );
  }
  if (!overview) {
    // A project that is gone has no page to go back to; its list does.
    if (apiErrorCode(overviewQ.error) === 'PROJECT_NOT_FOUND') return <PageGone to="/projects" back="Projects" />;
    return (
      <Page width="reading">
        <BackLink to={projectPath(projectId)}>Project</BackLink>
        <QueryUnavailable
          title="This page could not be opened"
          description="Clementine couldn’t reach the project just now. Nothing has been changed."
          onRetry={() => { void overviewQ.refetch(); }}
        />
      </Page>
    );
  }

  const page = projectPages(overview).find((row) => row.id === pageId);
  if (!page) return <PageGone to={projectPath(overview.project.id)} back={overview.project.name} />;
  return <PageFrame projectId={overview.project.id} projectName={overview.project.name} page={page} />;
}

function PageFrame({ projectId, projectName, page }: { projectId: string; projectName: string; page: ProjectPageView }) {
  const title = projectPageTitle(page);
  const place = projectPagePlace(page);
  return (
    <Page className="flex min-h-full max-w-none flex-col">
      <div><BackLink to={projectPath(projectId)}>{projectName}</BackLink></div>
      <header className="mb-4 min-w-0">
        <h2 className="break-words text-h2 text-fg">{title}</h2>
        <p className="truncate text-small text-muted" title={place}>{place}</p>
      </header>
      <ProjectPagePreview projectId={projectId} page={page} />
    </Page>
  );
}

/** The page itself with its width choices, reload and Open in browser. The
 *  viewer route and the chat's side panel show the same thing, so a page is
 *  looked at the same way wherever it is opened. */
export function ProjectPagePreview({ projectId, page }: { projectId: string; page: ProjectPageView }) {
  const [choice, setChoice] = useState<WidthChoice>('desktop');
  const [reload, setReload] = useState(0);
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState('');

  const title = projectPageTitle(page);
  const width = WIDTHS.find((row) => row.id === choice)?.width ?? null;
  // Asked again on every reload, so the frame is only drawn over a document that is there.
  const check = usePoll(projectKeys.pageDocument(projectId, page.id, reload), () => checkPageDocument(projectId, page.id), 0);

  const open = async () => {
    setOpening(true);
    setOpened(false);
    setOpenError('');
    try {
      await openPageInBrowser(projectId, page.id);
      setOpened(true);
    } catch (failure) {
      setOpenError(pageRefusalText(failure, 'The page could not be opened in your browser. Try again.'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Width the page is shown at" className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border bg-subtle p-0.5">
          {WIDTHS.map(({ id, label, width: px, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={choice === id}
              onClick={() => setChoice(id)}
              title={px ? `${px} px wide` : 'As wide as the window allows'}
              className={`inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-small font-semibold transition-colors duration-fast cursor-pointer ${
                choice === id ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
              <span className="sr-only">{px ? `, ${px} px wide` : ', as wide as the window allows'}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={opening} onClick={() => { void open(); }}>
            <ExternalLink className="h-4 w-4" aria-hidden /> {opening ? 'Opening…' : 'Open in browser'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setReload((value) => value + 1); }}>
            <RotateCw className="h-4 w-4" aria-hidden /> Reload
          </Button>
        </div>
      </div>
      {openError && <p role="alert" className="mb-3 text-small text-danger">{openError}</p>}
      {opened && !openError && <p role="status" className="mb-3 text-small text-muted">Opened in your browser.</p>}

      <div className="flex min-h-[480px] flex-1 justify-center">
        {check.isSuccess ? (
          <div
            className="relative w-full overflow-hidden rounded-lg border border-border bg-white"
            style={width ? { maxWidth: width } : undefined}
          >
            <iframe
              key={reload}
              src={pageDocumentUrl(projectId, page.id, reload)}
              sandbox={PROJECT_PAGE_FRAME_SANDBOX}
              title={`Page: ${title}`}
              referrerPolicy="no-referrer"
              loading="eager"
              className="absolute inset-0 h-full w-full border-0 bg-white"
            />
          </div>
        ) : check.isError ? (
          <div className="w-full self-start rounded-lg border border-border bg-surface px-5 py-4">
            <p role="alert" className="text-body text-fg">{pageRefusalText(check.error, projectPageRefusal(null))}</p>
          </div>
        ) : (
          <div role="status" className="w-full">
            <span className="sr-only">Loading the page</span>
            <Skeleton className="h-full min-h-[480px] w-full" />
          </div>
        )}
      </div>
      <p className="mt-2 text-caption text-muted">{PROJECT_PAGE_FRAME_NOTE}</p>
    </div>
  );
}
