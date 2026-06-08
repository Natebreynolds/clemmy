import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { MemoryGraph } from './MemoryGraph';
import { isMemory3dEnabled } from '@/lib/bootstrap';
import { cn } from '@/lib/cn';

/**
 * Hosts the Memory tab graph and the 2D⇄3D toggle.
 *
 * - Flag CLEMENTINE_MEMORY_3D OFF (default) → renders the existing 2D
 *   Cytoscape MemoryGraph unchanged (byte-identical to before this feature).
 * - Flag ON → offers a 2D⇄3D toggle. 3D (KnowledgeGraph3D) is lazy-loaded so
 *   three.js ships as its own chunk, fetched only when 3D is shown. The 2D
 *   MemoryGraph stays the universal fallback for: no WebGL, the user's choice,
 *   oversized graphs, fetch/runtime errors (via the error boundary), and
 *   reduced-motion defaults.
 */

const KnowledgeGraph3D = lazy(() => import('./KnowledgeGraph3D'));

const MODE_KEY = 'mem.graphMode';
function hasWebGL(): boolean {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch { return false; }
}
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** If the 3D view throws at render time, silently fall back to 2D. */
class GraphErrorBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function MemoryGraphContainer({ height = 540 }: { height?: number }) {
  const enabled = isMemory3dEnabled();
  const webgl = enabled && hasWebGL();
  const [mode, setMode] = useState<'2d' | '3d'>(() => {
    if (!webgl) return '2d';
    const saved = (typeof window !== 'undefined' && window.localStorage.getItem(MODE_KEY)) || '';
    if (saved === '2d' || saved === '3d') return saved;
    return reduceMotion() ? '2d' : '3d';
  });
  const choose = (m: '2d' | '3d') => { setMode(m); try { window.localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };

  // Flag off → unchanged behaviour.
  if (!enabled) return <MemoryGraph height={height} />;

  return (
    <div className="relative">
      {webgl && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2">
          <div className="flex rounded-full border border-border bg-surface/90 p-0.5 shadow-xs backdrop-blur">
            {(['3d', '2d'] as const).map((m) => (
              <button key={m} type="button" onClick={() => choose(m)}
                className={cn('rounded-full px-3 py-1 text-caption font-semibold uppercase transition-colors cursor-pointer',
                  mode === m ? 'bg-primary text-white' : 'text-muted hover:text-fg')}>{m}</button>
            ))}
          </div>
        </div>
      )}

      {mode === '3d' && webgl ? (
        <GraphErrorBoundary onError={() => choose('2d')}>
          <Suspense fallback={<div className="flex items-center justify-center rounded-xl border border-border bg-subtle text-body text-muted" style={{ height }}>Loading the constellation…</div>}>
            <KnowledgeGraph3D height={height} onFallback={() => choose('2d')} />
          </Suspense>
        </GraphErrorBoundary>
      ) : (
        <MemoryGraph height={height} />
      )}
    </div>
  );
}
