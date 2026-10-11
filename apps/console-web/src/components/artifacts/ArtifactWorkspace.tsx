/** A shared workspace for finished files and project pages. Open is always deliberate. */
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, Files, FileText, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { projectPagePlace, projectPageTitle, renderMarkdown } from '@clem/chat-engine';
import { ProjectPagePreview } from '@/screens/ProjectPageViewer';
import { pageViewerPath, type ProjectPageView } from '@/lib/projects';
import { fileSizeWords, listSessionFiles, openSessionFile, readSessionFile, readSessionFileBlob, readSessionFileImage, sessionFilePath, type SessionFile, type SessionFileRef } from '@/lib/session-files';
import { withToken } from '@/lib/api';
import { unifiedChatSessionId } from '@/lib/last-session';
import { artifactReadingKey, readArtifactReadingState, rememberArtifactReadingState } from '@/lib/artifact-reading-state';
import { useArtifactScroll } from '@/lib/use-artifact-scroll';
import '../chat/file-dock.css';

const PdfPreview = lazy(() => import('../chat/PdfPreview'));

export type DockedItem = { kind: 'file'; ref: SessionFileRef; conversationSessionId?: string } | { kind: 'page'; projectId: string; page: ProjectPageView };
interface FileDock { item: DockedItem | null; open: (item: DockedItem) => void; close: () => void; showFiles: () => void }
const FileDockContext = createContext<FileDock | null>(null);
export function useFileDock(): FileDock | null { return useContext(FileDockContext); }
interface DockState { visible: boolean; item: DockedItem | null; expanded: boolean }
const remembered = new Map<string, DockState>();
const INITIAL: DockState = { visible: false, item: null, expanded: false };
const ACTION = 'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-sm px-2 text-small font-medium text-muted transition-colors hover:bg-subtle hover:text-fg disabled:opacity-60';

export interface ArtifactWorkspaceProps {
  scopeKey: string;
  children: ReactNode;
  returnLabel?: string;
  scrollContent?: boolean;
  /** Chat adds its existing Files toolbar and session file list. */
  filesSessionId?: string;
  showFilesBar?: boolean;
}

export function ArtifactWorkspace(props: ArtifactWorkspaceProps) {
  return <Workspace key={props.scopeKey} {...props} />;
}
function Workspace({ scopeKey, children, returnLabel = 'work', scrollContent = true, filesSessionId, showFilesBar = false }: ArtifactWorkspaceProps) {
  const [state, setState] = useState<DockState>(() => remembered.get(scopeKey) ?? INITIAL);
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [fileSearch, setFileSearch] = useState('');
  const filteredFiles = useMemo(() => {
    const words = fileSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return files.filter(file => words.every(word => `${file.name} ${file.folder}`.toLocaleLowerCase().includes(word)));
  }, [files, fileSearch]);
  const trigger = useRef<HTMLElement | null>(null);
  const filesButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const update = useCallback((next: DockState) => {
    setState(next);
    remembered.delete(scopeKey);
    remembered.set(scopeKey, next);
    if (remembered.size > 100) remembered.delete(remembered.keys().next().value!);
  }, [scopeKey]);
  const close = useCallback(() => {
    update({ ...state, visible: false, expanded: false });
    requestAnimationFrame(() => (trigger.current?.isConnected ? trigger.current : filesButton.current ?? content.current)?.focus({ preventScroll: true }));
  }, [update, state]);
  const open = useCallback((item: DockedItem) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    update({ visible: true, item, expanded: false });
  }, [update]);
  const showFiles = useCallback(() => {
    if (!showFilesBar) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    update({ visible: true, item: null, expanded: false });
    setRefresh(n => n + 1);
  }, [update, showFilesBar]);
  useEffect(() => {
    if (!state.visible || !filesSessionId) return;
    let current = true;
    setLoading(true); setProblem('');
    void listSessionFiles(filesSessionId).then(found => { if (current) setFiles(found); })
      .catch(() => { if (current) setProblem('Files could not be loaded. Try Refresh.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [filesSessionId, state.visible, refresh]);
  useEffect(() => { if (state.visible) panel.current?.focus({ preventScroll: true }); }, [state.visible, state.item]);
  const dock = useMemo<FileDock>(() => ({ item: state.visible ? state.item : null, open, close, showFiles }), [state.visible, state.item, open, close, showFiles]);
  return <FileDockContext.Provider value={dock}>
    <div className="file-dock-root" data-scroll-content={scrollContent}>
      {showFilesBar ? <div className="file-dock-bar">
        <button ref={filesButton} type="button" className={ACTION} onClick={state.visible ? close : showFiles} aria-expanded={state.visible} aria-label={state.visible ? 'Close files panel' : 'Open files from this chat'}>
          <Files className="h-4 w-4" aria-hidden /> Files {files.length > 0 ? <span className="text-faint">{files.length}</span> : null}
        </button>
        {state.visible ? <span className="text-caption text-muted">{state.item ? 'Open beside your conversation' : 'Created in this chat'}</span> : null}
      </div> : null}
      <div className={`file-dock-workspace${state.visible ? ' is-open' : ''}${state.expanded ? ' is-expanded' : ''}`}>
        <div ref={content} tabIndex={-1} className="file-dock-conversation">{children}</div>
        {state.visible ? <aside ref={panel} tabIndex={-1} className="file-dock-panel" aria-label={showFilesBar ? 'Files from this chat' : 'Artifact viewer'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
          <div className="file-dock-controls">
            {showFilesBar && state.item ? <button type="button" className={ACTION} onClick={showFiles}><ArrowLeft className="h-4 w-4" aria-hidden /> All files</button> : <h2 className="px-2 text-body font-semibold">{showFilesBar ? 'Files from this chat' : 'Open artifact'}</h2>}
            <div className="ml-auto flex items-center">
              {showFilesBar && !state.item ? <button type="button" className={ACTION} onClick={() => setRefresh(n => n + 1)} disabled={loading} aria-label="Refresh files"><RefreshCw className="h-4 w-4" aria-hidden /></button> : null}
              <button type="button" className={`${ACTION} file-dock-expand`} onClick={() => update({ ...state, expanded: !state.expanded })} aria-label={state.expanded ? `Show ${returnLabel} beside file` : 'Expand file panel'}>{state.expanded ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}</button>
              <button type="button" className={ACTION} onClick={close} aria-label={`Close and return to ${returnLabel}`}><X className="h-4 w-4" aria-hidden /></button>
            </div>
          </div>
          {state.item ? state.item.kind === 'page' ? <PageBody key={dockKey(state.item)} projectId={state.item.projectId} page={state.item.page} /> : <FileBody key={dockKey(state.item)} fileRef={state.item.ref} conversationSessionId={showFilesBar ? undefined : state.item.conversationSessionId} /> : <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {files.length > 0 ? <input type="search" value={fileSearch} onChange={event => setFileSearch(event.target.value)} aria-label="Search files from this chat" placeholder="Search filenames" className="mb-3 min-h-10 w-full rounded-md border border-border bg-surface px-3 text-body text-fg placeholder:text-muted" /> : null}
            {loading ? <p className="text-small text-muted" role="status">Loading files…</p> : null}
            {problem ? <p className="mb-3 text-small text-muted" role="alert">{problem}</p> : null}
            {!loading && !problem && files.length === 0 ? <div className="py-8"><Files className="mb-3 h-6 w-6 text-muted" aria-hidden /><h3 className="text-body font-semibold">No files saved here yet</h3><p className="mt-2 text-small text-muted">Documents, email drafts, and other files Clem saves in this chat will be available here.</p></div> : null}
            {!loading && files.length > 0 && filteredFiles.length === 0 ? <p className="py-4 text-small text-muted">No files match. Try another filename.</p> : null}
            <div className="flex flex-col gap-1">{filteredFiles.map(file => <button type="button" key={file.fileId ?? `${file.folder}/${file.name}`} className="file-dock-file" onClick={() => open({ kind: 'file', ref: { sessionId: filesSessionId!, name: file.name, folder: file.folder, fileId: file.fileId } })}>
              <FileText className="h-5 w-5 shrink-0 text-muted" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{file.name}</span><span className="block truncate text-caption text-muted" title={file.place}>{file.place} · {fileSizeWords(file.bytes)}</span></span><span className="text-small font-medium text-primary">Open</span>
            </button>)}</div>
          </div>}
        </aside> : null}
      </div>
    </div>
  </FileDockContext.Provider>;
}
function dockKey(item: DockedItem): string { return item.kind === 'page' ? `page:${item.projectId}:${item.page.id}` : `file:${item.ref.sessionId}:${item.ref.fileId ?? `${item.ref.folder}/${item.ref.name}`}`; }
function PanelHeader({ title, place, actions }: { title: string; place: string; actions?: ReactNode }) {
  return <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3"><div className="min-w-0 flex-1"><h2 className="truncate text-body font-semibold text-fg" title={title}>{title}</h2><p className="truncate text-caption text-muted" title={place}>{place}</p></div><div className="flex flex-wrap items-center gap-1">{actions}</div></header>;
}
function PageBody({ projectId, page }: { projectId: string; page: ProjectPageView }) {
  const scroll = useArtifactScroll(`page:${projectId}:${page.id}`, 'page', page);
  return <><PanelHeader title={projectPageTitle(page)} place={projectPagePlace(page)} actions={<Link to={pageViewerPath(projectId, page.id)} className={ACTION}><ExternalLink className="h-4 w-4" aria-hidden /> Open page</Link>} /><div {...scroll} className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-3"><ProjectPagePreview projectId={projectId} page={page} /></div></>;
}
function FileBody({ fileRef, conversationSessionId }: { fileRef: SessionFileRef; conversationSessionId?: string }) {
  const [file, setFile] = useState<SessionFile | null>(null);
  const readingKey = artifactReadingKey({ ...fileRef, fileId: file?.fileId ?? fileRef.fileId });
  const [media, setMedia] = useState('');
  const [imageReady, setImageReady] = useState(false);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [problem, setProblem] = useState('');
  const [action, setAction] = useState<'open' | 'download' | null>(null);
  const [source, setSource] = useState(() => readArtifactReadingState(readingKey).source);
  useEffect(() => { setSource(readArtifactReadingState(readingKey).source); }, [readingKey]);
  const changeSource = (next: boolean) => { setSource(next); rememberArtifactReadingState(readingKey, { source: next }); };
  const scroll = useArtifactScroll(readingKey, source ? 'source' : file?.kind ?? 'file', file?.kind === 'image' ? imageReady : file?.text !== undefined);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFile(null); setMedia(''); setImageReady(false); setPdf(null); setProblem('');
    void readSessionFile(fileRef).then(async found => {
      if (!current) return;
      setFile(found);
      if (found.kind === 'image') { const src = await readSessionFileImage(fileRef); if (current) setMedia(src); }
      if (found.kind === 'pdf') {
        const blob = await readSessionFileBlob(fileRef);
        if (blob.type.split(';')[0] !== 'application/pdf') throw new Error('The PDF could not be previewed. Download it or open it in its app.');
        if (current) setPdf(blob);
      }
    }).catch(error => { if (current) setProblem(error instanceof Error ? error.message : 'This file could not be opened.'); });
    return () => { current = false; };
  }, [fileRef, attempt]);
  const openInApp = async () => {
    setAction('open'); setProblem('');
    try { await openSessionFile(fileRef); } catch { setProblem('The file could not be opened in its app. Try Download.'); } finally { setAction(null); }
  };
  const download = async () => {
    setAction('download'); setProblem('');
    try {
      const url = URL.createObjectURL(await readSessionFileBlob(fileRef, true));
      const link = document.createElement('a'); link.href = url; link.download = fileRef.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Download failed. Try again.'); } finally { setAction(null); }
  };
  return <>
    <PanelHeader title={fileRef.name} place={file ? `${file.place} · ${fileSizeWords(file.bytes)}` : fileRef.folder} actions={<>
      {conversationSessionId ? <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(conversationSessionId))}`} className={ACTION}>Conversation</Link> : null}
      {file?.openable ? <button type="button" onClick={() => void openInApp()} disabled={action !== null} className={ACTION}><ExternalLink className="h-4 w-4" aria-hidden /> Open in app</button> : null}
      {file ? <button type="button" onClick={() => void download()} disabled={action !== null} className={ACTION}><Download className="h-4 w-4" aria-hidden /> {action === 'download' ? 'Downloading…' : 'Download'}</button> : null}
    </>} />
    {file?.kind === 'html' ? <div className="flex gap-1 border-b border-border px-4 py-2" aria-label="HTML view"><button type="button" className={ACTION} aria-pressed={!source} onClick={() => changeSource(false)}>Preview</button><button type="button" className={ACTION} aria-pressed={source} onClick={() => changeSource(true)}>Source</button></div> : null}
    {problem ? <div className="flex flex-wrap items-center gap-2 px-4 py-3" role="alert"><p className="flex-1 text-small text-muted">{problem}</p><button className={ACTION} type="button" onClick={() => setAttempt(n => n + 1)}>Try again</button></div> : null}
    {file?.truncated ? <p className="px-4 py-2 text-caption text-muted">Showing the start of this file. Download for the complete contents.</p> : null}
    {!file && !problem ? <p className="p-5 text-small text-muted" role="status">Opening…</p> : null}
    {file?.kind === 'html' && !source && file.text !== undefined ? <><iframe className="file-dock-document" title={`Preview of ${file.name}`} sandbox="" referrerPolicy="no-referrer" src={withToken(sessionFilePath(fileRef, 'content'))} /><p className="border-t border-border px-4 py-2 text-caption text-muted">Document preview · Scripts and remote images are disabled.</p></> : null}
    {file?.kind === 'pdf' && pdf ? <Suspense fallback={<p className="p-5 text-small text-muted" role="status">Opening PDF…</p>}><PdfPreview blob={pdf} name={file.name} readingKey={readingKey} /></Suspense> : null}
    {file?.kind === 'pdf' && !pdf && !problem ? <p className="p-5 text-small text-muted" role="status">Opening PDF…</p> : null}
    {file && file.kind !== 'pdf' && !(file.kind === 'html' && !source) ? <div {...scroll} tabIndex={0} role="region" aria-label={`Contents of ${file.name}`} className="min-h-0 flex-1 overflow-auto px-5 py-4">
      {file.kind === 'markdown' && file.text !== undefined ? <div className="chat-prose min-w-0" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text, { workspaceLinks: false }) }} /> : null}
      {(file.kind === 'text' || file.kind === 'html') && file.text !== undefined ? <pre className="whitespace-pre-wrap break-words font-mono text-small text-fg">{file.text}</pre> : null}
      {file.kind === 'image' ? media ? <img src={media} alt={file.name} onLoad={() => setImageReady(true)} onError={() => setProblem('This image could not be displayed. Try again or download a copy.')} className="h-auto max-w-full rounded-sm" /> : !problem ? <p className="text-small text-muted">Opening…</p> : null : null}
      {file.kind === 'other' ? <div className="py-8"><FileText className="mb-3 h-7 w-7 text-muted" aria-hidden /><h3 className="text-body font-semibold">Saved and ready to open</h3><p className="mt-2 text-small text-muted">A preview isn’t available for this format. {file.openable ? 'Open it in its app, or download a copy.' : 'Download a copy to use it in a compatible app.'}</p></div> : null}
    </div> : null}
  </>;
}
