/** Load an external script once (cached by src). Resolves when ready. */
const cache = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  const existing = cache.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { cache.delete(src); reject(new Error(`Failed to load ${src}`)); };
    document.head.appendChild(el);
  });
  cache.set(src, p);
  return p;
}
