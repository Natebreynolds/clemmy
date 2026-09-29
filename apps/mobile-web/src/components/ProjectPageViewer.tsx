/**
 * One page made in a project, looked at on the phone.
 *
 * Nothing the page contains is run here. The Mac renders the page at this
 * sheet's width and sends it as pictures, one part at a time, so the viewer
 * is a column of pictures with what comes next said below the last one.
 *
 * The Mac renders one part at a time and each takes it a few seconds, so
 * there is never more than one request under way, and the next part is asked
 * for only as the reader nears the end of what is drawn. Closing the sheet
 * drops the pictures: they are large, and a page is rendered again the next
 * time it is opened.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  PROJECT_PAGE_PART_HEIGHT,
  PROJECT_PAGE_RENDERED_NOTE,
  projectPageNextOffset,
  projectPagePlace,
  projectPageTitle,
  type ProjectPageView,
} from '@clem/chat-engine';
import { haptic } from '../lib/native-bridge';
import { getProjectPageImage } from '../lib/project-api';
import {
  PAGE_ENDED_WORDS,
  PAGE_LIMIT_WORDS,
  PAGE_MORE_WORDS,
  PAGE_RENDERING_WORDS,
  PAGE_WIDTH_USUAL,
  drawnPageParts,
  pageFailure,
  pageFooter,
  pageNearEnd,
  pagePart,
  pagePartLabel,
  pageWidthFor,
  readPageImage,
  type PageFailure,
  type PagePart,
} from '../lib/project-pages';
import { Sheet } from './Sheet';

interface Props {
  projectId: string;
  /** The page being looked at; null while none is. */
  page: ProjectPageView | null;
  onClose: () => void;
}

export function ProjectPageViewer({ projectId, page, onClose }: Props) {
  return (
    <Sheet
      open={page !== null}
      onClose={onClose}
      title={page ? projectPageTitle(page) : undefined}
      aside={<button type="button" class="btn-quiet" onClick={onClose}>Close</button>}
      backGesture
      class="project-page-sheet"
    >
      {/* Keyed by the page, so another page starts with nothing drawn. */}
      {page ? <PageParts key={`${projectId}:${page.id}`} projectId={projectId} page={page} onClose={onClose} /> : null}
    </Sheet>
  );
}

function PageParts({ projectId, page, onClose }: { projectId: string; page: ProjectPageView; onClose: () => void }) {
  const title = projectPageTitle(page);
  const [parts, setParts] = useState<PagePart[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<PageFailure | null>(null);
  // What has arrived, read by a request that finishes after a render.
  const kept = useRef<PagePart[]>([]);
  const lock = useRef(false);
  const open = useRef(true);
  // After a failure nothing is asked for until the reader asks again.
  const halted = useRef(false);
  const width = useRef(PAGE_WIDTH_USUAL);
  const scroller = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);

  const ask = async () => {
    if (lock.current || !open.current) return;
    const offset = projectPageNextOffset(kept.current);
    if (offset === null) return;
    lock.current = true;
    halted.current = false;
    setLoading(true);
    setFailure(null);
    try {
      const part = readPageImage(await getProjectPageImage(projectId, page.id, {
        width: width.current,
        height: PROJECT_PAGE_PART_HEIGHT,
        offset,
      }));
      // An answer for a viewer that closed, or for a place no longer next, is left unused.
      if (!open.current || projectPageNextOffset(kept.current) !== offset) return;
      // A part is kept only when it reads as a picture of the place asked for.
      if (!part || part.offsetY !== offset) throw new Error('The part could not be read.');
      kept.current = [...kept.current, pagePart(part)];
      setParts(kept.current);
    } catch (err) {
      if (!open.current) return;
      haptic('error');
      halted.current = true;
      setFailure(pageFailure(err));
    } finally {
      lock.current = false;
      if (open.current) setLoading(false);
    }
  };

  useEffect(() => {
    open.current = true;
    // Measured once: every part of one viewing is rendered at the same width.
    width.current = pageWidthFor(column.current?.clientWidth);
    void ask();
    return () => {
      open.current = false;
      kept.current = [];
    };
  }, []);

  /** Ask for the next part once the reader is within a screen of the end of what is drawn. */
  const follow = () => {
    if (lock.current || halted.current || !open.current || kept.current.length === 0) return;
    const view = scroller.current;
    const drawn = column.current;
    if (!view || !drawn) return;
    const distance = drawn.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom;
    if (pageNearEnd(distance, view.clientHeight)) void ask();
  };

  /** A picture the phone could not draw is no part: it is dropped with what followed it. */
  const spoiled = (part: PagePart) => {
    const at = kept.current.indexOf(part);
    if (at < 0) return;
    kept.current = kept.current.slice(0, at);
    setParts(kept.current);
    haptic('error');
    halted.current = true;
    setFailure(pageFailure(null));
  };

  const drawn = drawnPageParts(parts);
  const footer = pageFooter(parts, loading, failure);

  return (
    <div class="project-page-scroll" ref={scroller} onScroll={follow}>
      <div class="project-page-about">
        <p class="project-page-caption">{projectPagePlace(page)}</p>
        <p class="project-page-caption">{PROJECT_PAGE_RENDERED_NOTE}</p>
      </div>
      <div class="project-page-parts" ref={column}>
        {drawn.map((part, index) => (
          <img
            key={part.offsetY}
            class="project-page-part"
            src={part.src}
            width={part.width}
            height={part.height}
            alt={pagePartLabel(index, title)}
            decoding="async"
            draggable={false}
            onLoad={follow}
            onError={() => spoiled(part)}
          />
        ))}
      </div>
      <div class="project-page-foot">
        {footer === 'loading' ? (
          <div class="project-page-wait" role="status" aria-live="polite">
            <div class="skeleton-stack" aria-hidden="true"><i /></div>
            <p class="project-page-caption">{PAGE_RENDERING_WORDS}</p>
          </div>
        ) : null}
        {footer === 'error' && failure ? (
          <>
            <p class="agent-failure" role="alert">{failure.text}</p>
            {failure.retry ? (
              <button type="button" class="project-page-more" onClick={() => { haptic('light'); void ask(); }}>Try again</button>
            ) : (
              <button type="button" class="project-page-more" onClick={onClose}>Back to the project</button>
            )}
          </>
        ) : null}
        {footer === 'more' ? (
          <button type="button" class="project-page-more" onClick={() => { haptic('light'); void ask(); }}>{PAGE_MORE_WORDS}</button>
        ) : null}
        {footer === 'ended' ? <p class="project-page-caption">{PAGE_ENDED_WORDS}</p> : null}
        {footer === 'limit' ? <p class="project-page-caption">{PAGE_LIMIT_WORDS}</p> : null}
      </div>
    </div>
  );
}
