/**
 * A file or page Clem made, open beside the conversation. Like the browser,
 * the panel docks at the right and the conversation stays open and usable;
 * a narrow window puts it below the conversation. One item at a time:
 * opening another replaces it, and another conversation starts with none.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Maximize2, X } from 'lucide-react';
import { projectPagePlace, projectPageTitle, renderMarkdown } from '@clem/chat-engine';
import { ProjectPagePreview } from '@/screens/ProjectPageViewer';
import { pageViewerPath, type ProjectPageView } from '@/lib/projects';
import {
  fileSizeWords, openSessionFile, readSessionFile, readSessionFileImage,
  type SessionFile, type SessionFileRef,
} from '@/lib/session-files';
import './file-dock.css';

export type DockedItem =
  | { kind: 'file'; ref: SessionFileRef }
  | { kind: 'page'; projectId: string; page: ProjectPageView };

interface FileDock { item: DockedItem | null; open: (item: DockedItem) => void; close: () => void }

const FileDockContext = createContext<FileDock | null>(null);

/** Null outside a conversation: a card there keeps its own way to open. */
export function useFileDock(): FileDock | null {
  return useContext(FileDockContext);
}

export function FileDockWorkspace({ conversationId, children }: { conversationId?: string; children: ReactNode }) {
  const [item, setItem] = useState<DockedItem | null>(null);
  useEffect(() => { setItem(null); }, [conversationId]);
  const close = useCallback(() => setItem(null), []);
  const dock = useMemo<FileDock>(() => ({ item, open: setItem, close }), [item, close]);
  return (
    <FileDockContext.Provider value={dock}>
      <div className={`file-dock-workspace${item ? ' is-open' : ''}`}>
        <div className="file-dock-conversation">{children}</div>
        {item ? <DockPanel key={dockKey(item)} item={item} onClose={close} /> : null}
      </div>
    </FileDockContext.Provider>
  );
}

function dockKey(item: DockedItem): string {
  return item.kind === 'page' ? `page:${item.projectId}:${item.page.id}` : `file:${item.ref.sessionId}:${item.ref.folder}/${item.ref.name}`;
}

function DockPanel({ item, onClose }: { item: DockedItem; onClose: () => void }) {
  return (
    <aside
      className="file-dock-panel"
      aria-label={item.kind === 'page' ? projectPageTitle(item.page) : item.ref.name}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
    >
      {item.kind === 'page'
        ? <PageBody projectId={item.projectId} page={item.page} onClose={onClose} />
        : <FileBody fileRef={item.ref} onClose={onClose} />}
    </aside>
  );
}

function PanelHeader({ title, place, actions, onClose }: { title: string; place: string; actions?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex min-w-0 items-start gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-body font-semibold text-fg" title={title}>{title}</h2>
        <p className="truncate text-caption text-muted" title={place}>{place}</p>
      </div>
      {actions}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close and keep the conversation"
        title="Close"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-muted transition-colors hover:bg-subtle hover:text-fg"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </header>
  );
}

const ACTION = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-small font-semibold text-muted transition-colors hover:bg-subtle hover:text-fg disabled:opacity-60';

function PageBody({ projectId, page, onClose }: { projectId: string; page: ProjectPageView; onClose: () => void }) {
  return (
    <>
      <PanelHeader
        title={projectPageTitle(page)}
        place={projectPagePlace(page)}
        onClose={onClose}
        actions={(
          <Link to={pageViewerPath(projectId, page.id)} className={ACTION}>
            <Maximize2 className="h-4 w-4" aria-hidden /> Full view
          </Link>
        )}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3">
        <ProjectPagePreview projectId={projectId} page={page} />
      </div>
    </>
  );
}

function FileBody({ fileRef, onClose }: { fileRef: SessionFileRef; onClose: () => void }) {
  const [file, setFile] = useState<SessionFile | null>(null);
  const [image, setImage] = useState('');
  const [problem, setProblem] = useState('');
  const [opening, setOpening] = useState<'idle' | 'working' | 'opened'>('idle');
  useEffect(() => {
    let current = true;
    void readSessionFile(fileRef)
      .then(async (found) => {
        if (!current) return;
        setFile(found);
        if (found.kind === 'image') {
          const src = await readSessionFileImage(fileRef);
          if (current) setImage(src);
        }
      })
      .catch(() => { if (current) setProblem('This file is no longer where it was saved.'); });
    return () => { current = false; };
  }, [fileRef]);
  const openInApp = () => {
    setOpening('working');
    void openSessionFile(fileRef)
      .then(() => setOpening('opened'))
      .catch(() => { setOpening('idle'); setProblem('The computer could not open it in its app.'); });
  };
  const place = file ? `${file.place} · ${fileSizeWords(file.bytes)}` : fileRef.folder;
  return (
    <>
      <PanelHeader
        title={fileRef.name}
        place={place}
        onClose={onClose}
        actions={file?.openable ? (
          <button type="button" onClick={openInApp} disabled={opening === 'working'} className={ACTION}>
            <ExternalLink className="h-4 w-4" aria-hidden /> {opening === 'opened' ? 'Opened' : 'Open in its app'}
          </button>
        ) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {problem ? <p className="text-small text-muted">{problem}</p> : null}
        {!file && !problem ? <p className="text-small text-muted">Opening…</p> : null}
        {file?.truncated ? (
          <p className="mb-3 text-caption text-muted">Showing the start of this file; open it in its app for all {fileSizeWords(file.bytes)}.</p>
        ) : null}
        {file?.kind === 'markdown' && file.text !== undefined ? (
          // renderMarkdown escapes every character before adding markup.
          // eslint-disable-next-line react/no-danger
          <div className="chat-prose min-w-0" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text, { workspaceLinks: false }) }} />
        ) : null}
        {file?.kind === 'text' && file.text !== undefined ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-small text-fg">{file.text}</pre>
        ) : null}
        {file?.kind === 'image' ? (
          image ? <img src={image} alt={file.name} className="h-auto max-w-full rounded-sm" /> : <p className="text-small text-muted">Opening…</p>
        ) : null}
        {file?.kind === 'other' ? (
          <p className="text-small text-muted">
            {file.openable ? 'This kind of file opens in its own app.' : 'This kind of file can’t be shown here.'}
          </p>
        ) : null}
      </div>
    </>
  );
}
