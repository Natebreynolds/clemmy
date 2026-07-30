import { useEffect, useRef, useState } from 'preact/hooks';
import { getMemoryGraph, getMemoryNeighborhood, type GraphNode, type MemoryGraph } from '../lib/api';

/**
 * The Memory Constellation, phone-sized.
 *
 * Hosts the framework-free `3d-force-graph` engine (the same one under the
 * desktop console's KnowledgeGraph3D) in a plain DOM node. The library —
 * three.js and all — is imported dynamically inside the effect, so Vite
 * splits it into an async chunk fetched only when this view opens; the main
 * bundle stays light. Palette matches the desktop constellation so memory
 * looks like ONE place across devices.
 *
 * Touch: orbit = drag, zoom = pinch (three's controls handle both). Tap a
 * node for the detail sheet; Expand pulls its neighborhood into the scene.
 */

const KIND_COLOR: Record<string, string> = {
  project: '#FF8A3D', user: '#8FA2FF', feedback: '#FF73B9', reference: '#4FD8C4', constraint: '#FF5B5B',
};
const TYPE_COLOR: Record<string, string> = {
  kind: '#FF7A1A', entity: '#FFC24B', file: '#6FE0FF',
  'tool-recall': '#7CF5A6', skill: '#FFD166', workflow: '#67B7FF', goal: '#FF6FA8', focus: '#C792EA',
  resource: '#75E6B1', episode: '#BFA7FF', policy: '#FF6B6B',
};
const TYPE_LABEL: Record<string, string> = {
  'tool-recall': 'Tool recall', skill: 'Skill', workflow: 'Workflow', goal: 'Goal', focus: 'Focus',
  entity: 'Person / thing', file: 'File', kind: 'Topic', fact: 'Fact',
  resource: 'Resource', episode: 'Episode', policy: 'Policy',
};

function nodeColor(node: GraphNode): string {
  if (node.type === 'fact') return KIND_COLOR[(node.data?.kind as string) ?? 'project'] ?? '#FBE9D6';
  return TYPE_COLOR[node.type] ?? '#FBE9D6';
}

/* Thumb-sized raycast targets — nodeVal scales the sphere the raycaster
   hits, and phone taps land within ~20px, not 2. */
function nodeSize(node: GraphNode): number {
  if (node.type === 'kind') return 14;
  if (node.type === 'entity' || node.type === 'goal' || node.type === 'workflow') return 9;
  return 6;
}

const EDGE_COLOR: Record<string, string> = {
  similar: 'rgba(181,140,255,0.55)',
  entity: 'rgba(255,194,75,0.25)',
  mentions: 'rgba(111,224,255,0.25)',
  kind: 'rgba(255,150,80,0.16)',
};

interface SheetState {
  node: GraphNode;
  expanded: boolean;
}

export function MemoryGraph3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  // 3d-force-graph instance; typed loosely because the lib is loaded lazily.
  const graphRef = useRef<any>(null);
  const dataRef = useRef<MemoryGraph>({ nodes: [], edges: [] });
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [sheet, setSheet] = useState<SheetState | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [{ default: ForceGraph3D }, data] = await Promise.all([
          import('3d-force-graph'),
          getMemoryGraph(),
        ]);
        if (disposed || !hostRef.current) return;
        if (data.nodes.length === 0) { setStatus('empty'); return; }
        dataRef.current = data;

        const host = hostRef.current;
        const rect = host.getBoundingClientRect();
        const graph = new ForceGraph3D(host)
          .width(rect.width)
          .height(rect.height)
          .backgroundColor('#0c0906')
          .showNavInfo(false)
          .enableNodeDrag(false)
          .nodeId('id')
          .nodeRelSize(6)
          .nodeLabel(() => '')
          .nodeColor((n) => nodeColor(n as unknown as GraphNode))
          .nodeVal((n) => nodeSize(n as unknown as GraphNode))
          .nodeOpacity(0.92)
          .linkSource('source')
          .linkTarget('target')
          .linkColor((l) => EDGE_COLOR[(l as { type?: string }).type ?? 'kind'] ?? 'rgba(255,232,200,0.08)')
          .linkWidth((l) => ((l as { type?: string }).type === 'similar' ? 0.8 : 0.3))
          .onNodeClick((n) => setSheet({ node: n as unknown as GraphNode, expanded: false }))
          .onBackgroundClick(() => setSheet(null))
          .graphData({ nodes: data.nodes, links: data.edges });

        // Frame the whole constellation once the first physics pass settles;
        // PCA seed positions can sit far off-center of the default camera.
        let framed = false;
        graph.onEngineStop(() => {
          if (framed) return;
          framed = true;
          graph.zoomToFit(500, 30);
        });

        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const controls = graph.controls?.() as { autoRotate?: boolean; autoRotateSpeed?: number } | undefined;
        if (!reduce && controls) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.55;
          // The idle spin is ambience, not a fight: the first touch wins and
          // the scene holds still for aiming from then on.
          host.addEventListener('pointerdown', () => { controls.autoRotate = false; }, { once: true, capture: true });
        }

        graphRef.current = graph;
        setStatus('ready');
      } catch {
        if (!disposed) setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      graphRef.current?._destructor?.();
      graphRef.current = null;
    };
  }, []);

  async function expand(node: GraphNode) {
    try {
      const extra = await getMemoryNeighborhood(node.id, 1);
      const current = dataRef.current;
      const known = new Set(current.nodes.map((n) => n.id));
      const edgeKey = (e: { source: unknown; target: unknown; type: string }) => {
        const s = typeof e.source === 'object' && e.source ? (e.source as GraphNode).id : String(e.source);
        const t = typeof e.target === 'object' && e.target ? (e.target as GraphNode).id : String(e.target);
        return `${s}→${t}:${e.type}`;
      };
      const knownEdges = new Set(current.edges.map(edgeKey));
      const merged: MemoryGraph = {
        nodes: [...current.nodes, ...extra.nodes.filter((n) => !known.has(n.id))],
        edges: [...current.edges, ...extra.edges.filter((e) => !knownEdges.has(edgeKey(e)))],
      };
      dataRef.current = merged;
      graphRef.current?.graphData({ nodes: merged.nodes, links: merged.edges });
      setSheet((s) => (s ? { ...s, expanded: true } : s));
    } catch { /* sheet stays; the graph is unchanged */ }
  }

  return (
    <div class="constellation">
      <div class="constellation-canvas" ref={hostRef} />
      {status === 'loading' ? <div class="constellation-note">Mapping what Clem knows…</div> : null}
      {status === 'empty' ? <div class="constellation-note">No memory yet. As Clem works, everything she learns lands here.</div> : null}
      {status === 'error' ? <div class="constellation-note error">Couldn't load the constellation. Pull down or reopen Memory to retry.</div> : null}
      {sheet ? (
        <div class="node-sheet">
          <div class="node-sheet-type" style={{ color: nodeColor(sheet.node) }}>
            {TYPE_LABEL[sheet.node.type] ?? sheet.node.type}
            {sheet.node.type === 'fact' && sheet.node.data?.kind ? ` · ${String(sheet.node.data.kind)}` : ''}
          </div>
          <div class="node-sheet-title">{sheet.node.label}</div>
          {typeof sheet.node.data?.content === 'string' && sheet.node.data.content !== sheet.node.label ? (
            <div class="node-sheet-body">{sheet.node.data.content as string}</div>
          ) : null}
          <div class="node-sheet-actions">
            <button class="node-sheet-expand" disabled={sheet.expanded} onClick={() => expand(sheet.node)}>
              {sheet.expanded ? 'Neighbors shown' : 'Show neighbors'}
            </button>
            <button class="node-sheet-close" onClick={() => setSheet(null)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
