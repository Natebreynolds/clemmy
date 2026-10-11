import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, version, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readArtifactReadingState, rememberArtifactReadingState } from '@/lib/artifact-reading-state';
import { useArtifactScroll } from '@/lib/use-artifact-scroll';

// Imported only when a PDF is opened. Both code and resources ship with Clem;
// document bytes have already passed the conversation's authenticated read.
GlobalWorkerOptions.workerSrc = workerUrl;
const resourceRoot = `${import.meta.env.BASE_URL}assets/pdfjs-${version}/`;
const BUTTON = 'inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 text-small text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

export default function PdfPreview({ blob, name, readingKey }: { blob: Blob; name: string; readingKey: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(() => readArtifactReadingState(readingKey).pdfPage);
  const [zoom, setZoom] = useState<number | 'fit'>(() => readArtifactReadingState(readingKey).pdfZoom);
  const [textView, setTextView] = useState(() => readArtifactReadingState(readingKey).pdfTextView);
  const [pageText, setPageText] = useState('');
  const [problem, setProblem] = useState('');
  const [rendering, setRendering] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(600);
  const scroll = useArtifactScroll(readingKey, `pdf:${pageNumber}:${textView ? 'text' : zoom}`, !rendering && !problem);
  const viewportRef = scroll.ref;
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pdf) rememberArtifactReadingState(readingKey, { pdfPage: pageNumber, pdfZoom: zoom, pdfTextView: textView });
  }, [readingKey, pdf, pageNumber, zoom, textView]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(160, entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    let task: ReturnType<typeof getDocument> | undefined;
    setPdf(null); setPageText(''); setProblem(''); setRendering(true);
    void blob.arrayBuffer().then(data => {
      if (!current) return;
      task = getDocument({
        data: new Uint8Array(data),
        cMapUrl: `${resourceRoot}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${resourceRoot}standard_fonts/`,
        wasmUrl: `${resourceRoot}wasm/`, iccUrl: `${resourceRoot}iccs/`,
        // Use the bundled path renderer and JS decoders under the app's CSP.
        // No document scripts, dynamic font URLs, forms, or external links run.
        disableFontFace: true, useWasm: false, enableXfa: false,
        maxImageSize: 40_000_000,
      });
      return task.promise.then(document => {
        if (!current) return;
        setPageNumber(value => Math.min(document.numPages, Math.max(1, value)));
        setPdf(document);
      });
    }).catch(error => {
      if (!current) return;
      setRendering(false);
      setProblem(error?.name === 'PasswordException'
        ? 'This PDF needs a password. Download it or open it in its app.'
        : 'This PDF could not be displayed. Try again, download it, or open it in its app.');
    });
    return () => { current = false; void task?.destroy(); };
  }, [blob, attempt]);

  useEffect(() => {
    if (!pdf) return;
    let current = true;
    let renderTask: RenderTask | undefined;
    setRendering(true); setProblem(''); setPageText('');
    void pdf.getPage(pageNumber).then(async page => {
      if (!current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = zoom === 'fit' ? Math.min(2, width / base.width) : zoom;
      const viewport = page.getViewport({ scale });
      // Bound the backing bitmap even for huge pages or high-density screens.
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.className = 'mx-auto block bg-white shadow-sm';
      canvas.setAttribute('aria-hidden', 'true');
      renderTask = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
      const [, text] = await Promise.all([renderTask.promise, page.getTextContent()]);
      if (!current) return;
      pageRef.current?.replaceChildren(canvas);
      setPageText(text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim());
      setRendering(false);
      page.cleanup();
    }).catch(error => {
      if (!current || error?.name === 'RenderingCancelledException') return;
      setRendering(false);
      setProblem('This page could not be displayed. Try another page, download the PDF, or open it in its app.');
    });
    return () => { current = false; renderTask?.cancel(); };
  }, [pdf, pageNumber, zoom, width]);

  return <section aria-label={`PDF: ${name}`} className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
      <button type="button" className={BUTTON} aria-label="Previous page" disabled={!pdf || pageNumber <= 1} onClick={() => { setRendering(true); setPageNumber(page => page - 1); }}><ChevronLeft className="h-4 w-4" aria-hidden /></button>
      <span aria-live="polite" className="min-w-20 text-center text-caption text-muted">{pdf ? `Page ${pageNumber} of ${pdf.numPages}` : 'Opening PDF…'}</span>
      <button type="button" className={BUTTON} aria-label="Next page" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => { setRendering(true); setPageNumber(page => page + 1); }}><ChevronRight className="h-4 w-4" aria-hidden /></button>
      <select aria-label="PDF zoom" value={zoom} onChange={event => { setRendering(true); setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value)); }} className="ml-auto h-8 rounded-md border border-border bg-surface px-2 text-caption text-fg" disabled={!pdf || textView}>
        <option value="fit">Fit width</option>{[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}
      </select>
      <button type="button" className={BUTTON} aria-pressed={textView} disabled={!pdf} onClick={() => setTextView(value => !value)}>{textView ? 'Show page' : 'Read text'}</button>
    </div>
    {problem ? <div className="flex items-center gap-2 p-4" role="alert"><p className="flex-1 text-small text-muted">{problem}</p><button type="button" className={BUTTON} onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : null}
    <div ref={viewportRef} onScroll={scroll.onScroll} tabIndex={0} role="region" aria-label="PDF page" className="relative min-h-0 flex-1 overflow-auto bg-subtle p-4" aria-busy={rendering}>
      {rendering && !problem ? <p role="status" className="mb-3 text-small text-muted">{pdf ? `Rendering page ${pageNumber}…` : 'Opening PDF…'}</p> : null}
      <div ref={pageRef} className={textView || rendering || Boolean(problem) ? 'hidden' : ''} />
      {!rendering && !problem ? <div role="document" aria-label={`Text of page ${pageNumber}`} className={textView ? 'whitespace-pre-wrap rounded-md bg-surface p-4 text-body leading-relaxed text-fg' : 'sr-only'}>{pageText || 'This page has no extractable text.'}</div> : null}
    </div>
  </section>;
}
