import { useLayoutEffect, useRef, type UIEvent } from 'react';
import { readArtifactReadingState, rememberArtifactReadingState } from './artifact-reading-state';

/** Restore only once the rendered content has its real dimensions. */
export function useArtifactScroll(key: string, view: string, ready: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ready || !ref.current) return;
    const saved = readArtifactReadingState(key).scroll[view];
    ref.current.scrollTop = saved?.top ?? 0;
    ref.current.scrollLeft = saved?.left ?? 0;
  }, [key, view, ready]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!ready) return;
    const node = event.currentTarget;
    rememberArtifactReadingState(key, { scroll: { [view]: { top: node.scrollTop, left: node.scrollLeft } } });
  };
  return { ref, onScroll };
}
