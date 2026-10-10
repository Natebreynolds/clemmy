import { useEffect, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '@clem/chat-engine';
import { Sheet } from './Sheet';
import { inNativeShell } from '../lib/native-bridge';
import {
  fileKindWords, filePreviewHtml, fileSizeWords, listSessionFiles,
  readSessionFile, readSessionFileContent, sessionFileProblem, type SessionFile,
} from '../lib/session-files';

const FileIcon = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>;

/** Finished files are read when the owner opens them. The conversation stays
 * mounted underneath, retaining its draft and place; no creation feed or polling. */
export function CompletedFiles({ conversationId }: { conversationId?: string }) {
  return conversationId ? <ConversationFiles key={conversationId} sessionId={conversationId} /> : null;
}

function ConversationFiles({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<SessionFile[] | null>(null);
  const [problem, setProblem] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<SessionFile | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const selectedFileId = useRef('');
  const close = () => { setOpen(false); setSelected(null); };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFiles(null);
    setProblem('');
    void listSessionFiles(sessionId, controller.signal)
      .then(found => { if (!controller.signal.aborted) setFiles(found); })
      .catch((error) => {
        if (!controller.signal.aborted) setProblem(sessionFileProblem(error));
      });
    return () => controller.abort();
  }, [sessionId, open, refresh]);

  const backToFiles = () => {
    setSelected(null);
    window.requestAnimationFrame(() => {
      const row = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-file-id]') ?? [])]
        .find(button => button.dataset.fileId === selectedFileId.current);
      row?.focus();
    });
  };

  return (
    <>
      <div class="chat-files-bar">
        <button class="chat-files-trigger" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <FileIcon /><span>Files</span>
          {files && files.length > 0 ? <span class="chat-files-count">{files.length}</span> : null}
        </button>
      </div>
      <Sheet
        open={open}
        onClose={close}
        title="Files"
        backGesture
        class="chat-files-sheet sheet-tall"
        aside={<button type="button" class="chat-file-action" onClick={close} aria-label="Close files and return to conversation">Done</button>}
      >
        {selected ? (
          <FilePreview key={selected.fileId} sessionId={sessionId} initialFile={selected} onBack={backToFiles} />
        ) : (
          <>
            <div class="chat-files-intro">
              <p>Saved in this conversation.</p>
              <button type="button" class="chat-file-action" onClick={() => setRefresh(value => value + 1)} disabled={files === null && !problem}>Refresh</button>
            </div>
            {problem ? <div class="chat-file-notice" role="alert"><p>{problem}</p><button type="button" class="chat-file-action" onClick={() => setRefresh(value => value + 1)}>Try again</button></div> : null}
            {!files && !problem ? <div role="status" aria-label="Loading files" class="skeleton-stack"><i /><i /><i /></div> : null}
            {files?.length === 0 ? <div class="chat-file-empty"><FileIcon /><p>No files saved here yet.</p><span>Documents, email drafts and other files Clem saves will be available here.</span></div> : null}
            {files && files.length > 0 ? (
              <ul ref={listRef} class="chat-file-list">
                {files.map(file => (
                  <li key={file.fileId}>
                    <button type="button" class="chat-file-row" data-file-id={file.fileId} onClick={() => { selectedFileId.current = file.fileId; setSelected(file); }}>
                      <FileIcon />
                      <span class="chat-file-row-copy"><strong>{file.name}</strong><span>{fileKindWords(file.kind)} · {fileSizeWords(file.bytes)}{file.folder ? ` · ${file.folder}` : ''}</span></span>
                      <span class="chat-file-open">Open</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Sheet>
    </>
  );
}

function FilePreview({ sessionId, initialFile, onBack }: { sessionId: string; initialFile: SessionFile; onBack: () => void }) {
  const nativeArtifactFiles = !inNativeShell() || window.clemArtifactFiles === true;
  const [file, setFile] = useState<SessionFile | null>(null);
  const [objectUrl, setObjectUrl] = useState('');
  const [problem, setProblem] = useState('');
  const [downloadProblem, setDownloadProblem] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const back = useRef<HTMLButtonElement | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadUrls = useRef<string[]>([]);

  useEffect(() => {
    back.current?.focus();
    return () => {
      downloadRequest.current?.abort();
      downloadUrls.current.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    setFile(null);
    setObjectUrl('');
    setProblem('');
    void readSessionFile(sessionId, initialFile, controller.signal)
      .then(async found => {
        if (controller.signal.aborted) return;
        if ((found.kind === 'pdf' && nativeArtifactFiles) || found.kind === 'image') {
          const blob = await readSessionFileContent(sessionId, found, controller.signal);
          if (controller.signal.aborted) return;
          if (found.kind === 'pdf' && blob.type.split(';')[0] !== 'application/pdf') throw new Error('Unexpected PDF content type');
          url = URL.createObjectURL(blob);
          setObjectUrl(url);
        }
        setFile(found);
      })
      .catch(error => { if (!controller.signal.aborted) setProblem(sessionFileProblem(error)); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [sessionId, initialFile, refresh, nativeArtifactFiles]);

  const download = async () => {
    if (downloading) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    setDownloadProblem('');
    try {
      const blob = await readSessionFileContent(sessionId, file ?? initialFile, controller.signal, true);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      downloadUrls.current.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = initialFile.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      if (!controller.signal.aborted) setDownloadProblem(sessionFileProblem(error));
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  };

  return (
    <div class="chat-file-preview">
      <div class="chat-file-toolbar">
        <button ref={back} type="button" class="chat-file-action" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          All files
        </button>
        <button type="button" class="chat-file-action" disabled={downloading || !nativeArtifactFiles} onClick={() => { void download(); }}>{downloading ? 'Downloading…' : 'Download'}</button>
      </div>
      <div class="chat-file-heading"><h3>{initialFile.name}</h3><p>{fileKindWords(initialFile.kind)} · {fileSizeWords(initialFile.bytes)}</p></div>
      {!nativeArtifactFiles ? <p class="chat-file-notice">Update the Clem iPhone app to preview PDFs and HTML files or save files to your phone. You can also open them on your computer.</p> : null}
      {downloadProblem ? <p class="chat-file-notice" role="alert">{downloadProblem}</p> : null}
      {problem ? <div class="chat-file-notice" role="alert"><p>{problem}</p><button type="button" class="chat-file-action" onClick={() => setRefresh(value => value + 1)}>Try again</button></div> : null}
      {!file && !problem ? <div role="status" aria-label="Opening file" class="skeleton-stack"><i /><i /><i /></div> : null}
      {file?.truncated ? <p class="chat-file-notice">This preview shows the beginning. Download the file to read all of it.</p> : null}
      {nativeArtifactFiles && file?.kind === 'html' && file.previewHtml !== undefined ? <iframe class="chat-file-frame" title={`Preview of ${file.name}`} srcDoc={filePreviewHtml(file.previewHtml)} sandbox="" referrerPolicy="no-referrer" /> : null}
      {nativeArtifactFiles && file?.kind === 'html' && file.previewHtml === undefined ? <p class="chat-file-help">Preview is unavailable. Download the file to open it.</p> : null}
      {file?.kind === 'pdf' && objectUrl ? <><iframe class="chat-file-frame" title={`Preview of ${file.name}`} src={objectUrl} referrerPolicy="no-referrer" /><p class="chat-file-help">If your phone cannot show the PDF here, download it to open in your PDF viewer.</p></> : null}
      {file?.kind === 'image' && objectUrl ? <img class="chat-file-image" src={objectUrl} alt={file.name} /> : null}
      {file?.kind === 'markdown' && file.text !== undefined ? <div class="msg-body chat-file-document" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text, { workspaceLinks: false }) }} /> : null}
      {file?.kind === 'text' && file.text !== undefined ? <pre class="chat-file-text">{file.text}</pre> : null}
      {file?.kind === 'other' ? <p class="chat-file-help">Download this file to open it in a compatible app.</p> : null}
    </div>
  );
}
