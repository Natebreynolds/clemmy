import { Component, lazy, Suspense, type ReactNode } from 'react';

/**
 * Hosts the Memory tab graph.
 *
 * The 3D "Memory Constellation" (KnowledgeGraph3D) is THE view — lazy-loaded so
 * three.js ships as its own chunk, fetched only when the Memory tab opens. There
 * is intentionally no 2D toggle: the 3D component shows a graceful message if
 * WebGL is unavailable or the data can't load (never blank), and the error
 * boundary below shows a message if it ever throws.
 */

const KnowledgeGraph3D = lazy(() => import('./KnowledgeGraph3D'));

const Box = ({ height, children }: { height: number; children: ReactNode }) => (
  <div className="flex items-center justify-center rounded-xl border border-border bg-subtle px-6 text-center text-body text-muted" style={{ height }}>{children}</div>
);

/** Shows a message (not a 2D fallback) if the 3D view ever throws at runtime. */
class GraphErrorBoundary extends Component<{ children: ReactNode; height: number }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Box height={this.props.height}>Couldn’t load the constellation. Reload the page to try again.</Box>;
    return this.props.children;
  }
}

export function MemoryGraphContainer({ height = 540 }: { height?: number }) {
  return (
    <GraphErrorBoundary height={height}>
      <Suspense fallback={<Box height={height}>Loading the constellation…</Box>}>
        <KnowledgeGraph3D height={height} />
      </Suspense>
    </GraphErrorBoundary>
  );
}
