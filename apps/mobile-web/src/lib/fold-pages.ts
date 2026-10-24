import { useEffect, useState } from 'preact/hooks';

/**
 * Whether the window is open across a fold as two pages. The native shell
 * publishes the crease on the page root (data-fold-axis, --fold-start,
 * --fold-end); the layout itself is CSS. This only tells screens when the
 * first page is showing, so they read what it shows only while it is visible.
 */
const TWO_PAGES = '(min-width: 880px)';

export function foldPagesShown(root: { dataset: DOMStringMap }, wide: boolean): boolean {
  return wide && root.dataset.foldAxis === 'vertical';
}

export function useFoldPages(): boolean {
  const read = () => foldPagesShown(document.documentElement, window.matchMedia(TWO_PAGES).matches);
  const [shown, setShown] = useState(read);
  useEffect(() => {
    const update = () => setShown(read());
    const media = window.matchMedia(TWO_PAGES);
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fold-axis'] });
    update();
    return () => { media.removeEventListener('change', update); observer.disconnect(); };
  }, []);
  return shown;
}
