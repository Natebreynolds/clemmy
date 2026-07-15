import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d';
import { Vector2 } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { X, RotateCcw, Maximize2, Search, Sparkles, Layers3 } from 'lucide-react';
import { getGraph, getGraphNeighborhood, type GraphNode, type GraphEdge } from '@/lib/memory';
import { cn } from '@/lib/cn';

/**
 * The 3D "Memory Constellation" — a Three.js WebGL force-graph of everything
 * Clementine knows, with glow (UnrealBloomPass), fly-to-node camera, and
 * fact↔fact semantic "similar" links. Lazy-loaded by MemoryGraphContainer so
 * three.js (~600KB) is its own async chunk, fetched only when 3D is shown.
 *
 * This is the React port of the standalone prototype
 * (clementine-memory-constellation.html); the visual constants are kept in
 * sync. The 2D Cytoscape MemoryGraph stays the universal fallback.
 *
 * three is a single deduped copy in node_modules (react-force-graph-3d →
 * 3d-force-graph → three, all deduped to the top-level three), so bloom
 * attaches to the right renderer — no "two copies of three" hazard.
 */

const reduceMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function hasWebGL(): boolean {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch { return false; }
}

const KIND_COLOR: Record<string, string> = { project: '#FF8A3D', user: '#8FA2FF', feedback: '#FF73B9', reference: '#4FD8C4', constraint: '#FF5B5B' };
const COLOR = {
  kind: '#FF7A1A', entity: '#FFC24B', file: '#6FE0FF', similar: '#B58CFF',
  // WS1 non-fact stores
  'tool-recall': '#7CF5A6', skill: '#FFD166', workflow: '#67B7FF', goal: '#FF6FA8', focus: '#C792EA',
  resource: '#75E6B1', episode: '#BFA7FF', policy: '#FF6B6B',
};
const KIND_LABEL: Record<string, string> = { project: 'Projects', user: 'About you', feedback: 'Feedback', reference: 'Reference', constraint: 'Constraints' };
const NODE_TYPE_LABEL: Record<string, string> = {
  'tool-recall': 'Tool recall', skill: 'Skill', workflow: 'Workflow', goal: 'Goal', focus: 'Focus',
  entity: 'Person / thing', file: 'File', kind: 'Topic', fact: 'Fact',
  resource: 'Resource', episode: 'Episode', policy: 'Policy',
};

const dim = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};
const baseNodeColor = (n: GNode) =>
  n.type === 'fact' ? (KIND_COLOR[(n.data?.kind as string) || 'project'] || '#FBE9D6') : ((COLOR as Record<string, string>)[n.type] || '#FBE9D6');

const EDGE_BASE: Record<string, (w?: number) => string> = {
  similar: (w) => dim(COLOR.similar, Math.min(0.6, 0.18 + (w || 0.6) * 0.45)),
  entity: () => dim(COLOR.entity, 0.1),
  mentions: () => dim(COLOR.file, 0.12),
  kind: () => 'rgba(255,150,80,0.07)',
  uses: () => dim(COLOR.skill, 0.28),
  pursues: () => dim(COLOR.goal, 0.28),
  related: () => dim(COLOR.entity, 0.4), // stored entity↔entity relations
  source: () => dim(COLOR.file, 0.35),
  resource: () => dim(COLOR.resource, 0.35),
  evidence: () => dim(COLOR.episode, 0.35),
  observed: () => dim(COLOR.episode, 0.5),
  artifact: () => dim(COLOR.file, 0.5),
  governs: () => dim(COLOR.policy, 0.5),
};

function nodeVal(n: GNode): number {
  if (n.type === 'kind') return 42;
  if (n.type === 'entity') {
    const exactObservations = (n.data?.observationCount as number) || 0;
    const legacyMentions = (n.data?.mention_count as number) || 0;
    return 6 + Math.min(18, exactObservations > 0 ? exactObservations : legacyMentions) * 0.5;
  }
  if (n.type === 'file') return 5;
  if (n.type === 'goal') return 14;
  if (n.type === 'workflow') return 9;
  if (n.type === 'skill') return 7 + Math.min(12, (n.data?.useCount as number) || 0) * 0.4;
  if (n.type === 'tool-recall') return 5 + Math.min(10, (n.data?.successCount as number) || 0) * 0.4;
  if (n.type === 'focus') return 8;
  if (n.type === 'resource') return 7;
  if (n.type === 'episode') return 5;
  if (n.type === 'policy') return 8;
  const imp = n.data?.importance as number | undefined;
  const deg = (n.data?.degree as number) || 0;
  return imp ? 2 + imp * 0.7 : 3 + Math.min(deg, 16) * 0.35;
}

type GNode = GraphNode & { x?: number; y?: number; z?: number };
// react-force-graph replaces the string source/target with the node objects
// once the graph is built, so override (don't intersect) those fields.
type GLink = Omit<GraphEdge, 'source' | 'target'> & { source: string | GNode; target: string | GNode };

// All possible legend chips, in display order. The component renders only the
// ones actually present in the loaded graph so the legend stays honest (e.g.
// no "Workflows" chip when there are none, or when CLEMMY_GRAPH_FULL is off).
const ALL_TYPES = [
  { type: 'kind', label: 'Topics', color: COLOR.kind },
  { type: 'fact', label: 'Facts', color: '#FFB98A' },
  { type: 'entity', label: 'People & things', color: COLOR.entity },
  { type: 'file', label: 'Files', color: COLOR.file },
  { type: 'resource', label: 'Resources', color: COLOR.resource },
  { type: 'episode', label: 'Episodes', color: COLOR.episode },
  { type: 'policy', label: 'Policies', color: COLOR.policy },
  { type: 'tool-recall', label: 'Tool recall', color: COLOR['tool-recall'] },
  { type: 'skill', label: 'Skills', color: COLOR.skill },
  { type: 'workflow', label: 'Workflows', color: COLOR.workflow },
  { type: 'goal', label: 'Goals', color: COLOR.goal },
  { type: 'focus', label: 'Focus', color: COLOR.focus },
];

interface Sel { label: string; type: string; content?: string; data?: Record<string, unknown>; connected: number }

interface RelationshipEvidence {
  episodeId: string;
  excerpt: string;
  sourceUri?: string | null;
  confidence?: number;
  observedAt?: string;
  validFrom?: string | null;
  validTo?: string | null;
  extractionMethod?: string;
  episodeStatus?: string;
}

export default function KnowledgeGraph3D({ height = 540 }: { height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  const orbitRaf = useRef<number | null>(null);
  const orbitAngle = useRef(0);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error' | 'nowebgl'>('loading');
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [counts, setCounts] = useState({ facts: 0, links: 0, totalFacts: 0, relationships: 0, totalRelationships: 0, stored: 0, inferred: 0, semantic: 0 });
  const [dims, setDims] = useState({ w: 0, h: height });

  // view state
  const [hideType, setHideType] = useState<Set<string>>(new Set());
  const [showSimilar, setShowSimilar] = useState(true);
  const [showOverlays, setShowOverlays] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [bloomOn, setBloomOn] = useState(!reduceMotion());
  const [sel, setSel] = useState<Sel | null>(null);

  const hi = useRef<{ nodes: Set<string>; links: Set<GLink> }>({ nodes: new Set(), links: new Set() });
  const SIM_THRESHOLD = 0.66;

  // ── size to container ──────────────────────────────────────────────
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDims({ w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // ── fetch graph ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!hasWebGL()) { setStatus('nowebgl'); return; }
    (async () => {
      try {
        setStatus('loading');
        const res = await getGraph({ layout: 'semantic', simEdges: showOverlays ? 3 : 0, facts: 300, files: 80, entities: 100, truth: showOverlays ? 'augmented' : 'stored' });
        if (cancelled) return;
        const rawNodes = res.nodes ?? [];
        if (rawNodes.length === 0) { setStatus('empty'); return; }
        // clone + seed positions from PCA so the graph lands pre-clustered
        const nodes: GNode[] = rawNodes.map((n) => {
          const m: GNode = { ...n };
          const d = n.data;
          if (d && typeof d.fx === 'number') { m.x = d.fx as number; m.y = d.fy as number; m.z = d.fz as number; }
          return m;
        });
        const links = (res.edges ?? []).filter((e) => e.source && e.target).map((e) => ({ ...e })) as GLink[];
        setData({ nodes, links });
        setCounts({
          facts: nodes.filter((n) => n.type === 'fact').length,
          links: links.filter((l) => l.type === 'similar').length,
          totalFacts: res.meta?.totalFacts ?? 0,
          relationships: links.filter((l) => l.type === 'related').length,
          totalRelationships: res.meta?.coverage?.edgeTypeTotals?.related ?? links.filter((l) => l.type === 'related').length,
          stored: res.meta?.coverage?.edges?.stored ?? links.filter((link) => link.truth === 'stored').length,
          inferred: res.meta?.coverage?.edges?.inferred ?? links.filter((link) => link.truth === 'inferred').length,
          semantic: res.meta?.coverage?.edges?.semantic ?? links.filter((link) => link.truth === 'semantic').length,
        });
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [showOverlays]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    if (data) for (const n of data.nodes) m.set(n.id, n);
    return m;
  }, [data]);

  // Only show legend chips for node types actually present (honest legend).
  const presentTypes = useMemo(() => {
    const s = new Set<string>();
    if (data) for (const n of data.nodes) s.add(n.type);
    return ALL_TYPES.filter((t) => s.has(t.type));
  }, [data]);

  // ── visibility / styling predicates (read live state) ──────────────
  const typeHidden = (t: string) => hideType.has(t);
  const linkEndType = (e: string | GNode) => (typeof e === 'object' ? e.type : nodeById.get(e)?.type);
  const linkVisible = (l: GLink) => {
    if (l.truth !== 'stored' && !showOverlays) return false;
    if (l.type === 'similar') return showSimilar && (l.weight || 0) >= SIM_THRESHOLD;
    return !typeHidden(linkEndType(l.source) || '') && !typeHidden(linkEndType(l.target) || '');
  };
  const matches = (n: GNode) => !!query && `${n.label} ${(n.data?.content as string) || ''}`.toLowerCase().includes(query);

  // ── bloom ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || status !== 'ready') return;
    try {
      if (!bloomPassRef.current) {
        const p = new UnrealBloomPass(new Vector2(dims.w || 1, dims.h || 1), 2.0, 0.85, 0.0);
        bloomPassRef.current = p;
      }
      const composer = fg.postProcessingComposer();
      const pass = bloomPassRef.current;
      const has = composer.passes.includes(pass);
      if (bloomOn && !has) composer.addPass(pass);
      if (!bloomOn && has) composer.removePass(pass);
    } catch { /* bloom unavailable → bright nodes, no glow; never blanks */ }
  }, [bloomOn, status, dims.w, dims.h]);

  // ── intro fly-in + gentle auto-orbit ───────────────────────────────
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || status !== 'ready') return;
    const R = 320, H = 70;
    const stopOrbit = () => { if (orbitRaf.current != null) { cancelAnimationFrame(orbitRaf.current); orbitRaf.current = null; } };
    if (reduceMotion()) {
      fg.cameraPosition({ x: 0, y: H, z: R });
    } else {
      fg.cameraPosition({ z: 760 });
      const t1 = setTimeout(() => fg.cameraPosition({ x: 0, y: H, z: R }, { x: 0, y: 0, z: 0 }, 2600), 120);
      const t2 = setTimeout(() => {
        const tick = () => {
          orbitAngle.current += 0.0016;
          fg.cameraPosition({ x: R * Math.sin(orbitAngle.current), y: H, z: R * Math.cos(orbitAngle.current) });
          orbitRaf.current = requestAnimationFrame(tick);
        };
        orbitRaf.current = requestAnimationFrame(tick);
      }, 2900);
      // stop the orbit the moment the user grabs the view
      try { (fg.controls() as { addEventListener?: (ev: string, cb: () => void) => void }).addEventListener?.('start', stopOrbit); } catch { /* ignore */ }
      const el = wrap.current;
      el?.addEventListener('pointerdown', stopOrbit, { passive: true });
      el?.addEventListener('wheel', stopOrbit, { passive: true });
      try { fg.d3Force('charge')?.strength(-60); } catch { /* ignore */ }
      return () => { clearTimeout(t1); clearTimeout(t2); stopOrbit(); el?.removeEventListener('pointerdown', stopOrbit); el?.removeEventListener('wheel', stopOrbit); };
    }
    return () => stopOrbit();
  }, [status]);

  // ── teardown ───────────────────────────────────────────────────────
  useEffect(() => () => {
    if (orbitRaf.current != null) cancelAnimationFrame(orbitRaf.current);
    try { bloomPassRef.current?.dispose(); } catch { /* ignore */ }
    bloomPassRef.current = null;
  }, []);

  // ── interactions ───────────────────────────────────────────────────
  const stopOrbit = () => { if (orbitRaf.current != null) { cancelAnimationFrame(orbitRaf.current); orbitRaf.current = null; } };
  const neighborsOf = (node: GNode) => {
    const ns = new Set<string>([node.id]); const ls = new Set<GLink>();
    if (data) for (const l of data.links) {
      if (!linkVisible(l)) continue;
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (s === node.id || t === node.id) { ls.add(l); ns.add(s); ns.add(t); }
    }
    hi.current = { nodes: ns, links: ls };
  };
  const bump = () => setSel((s) => (s ? { ...s } : s)); // nudge a re-render so accessors re-run

  const onHover = (node: GNode | null) => {
    if (selected) return;
    if (node) neighborsOf(node); else hi.current = { nodes: new Set(), links: new Set() };
    bump();
  };
  const onNodeClick = (node: GNode) => {
    stopOrbit();
    setSelected(node.id);
    neighborsOf(node);
    const fg = fgRef.current;
    const r = Math.hypot(node.x || 0, node.y || 0, node.z || 0) || 1;
    const ratio = 1 + 120 / r;
    fg?.cameraPosition(
      { x: (node.x || 0) * ratio, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio },
      { x: node.x || 0, y: node.y || 0, z: node.z || 0 },
      900,
    );
    setSel({
      label: node.label, type: node.type,
      content: node.type === 'fact' ? (node.data?.content as string) : undefined,
      data: node.data, connected: hi.current.nodes.size - 1,
    });
  };
  const onLinkClick = (link: GLink) => {
    stopOrbit();
    const source = typeof link.source === 'object' ? link.source : nodeById.get(link.source);
    const target = typeof link.target === 'object' ? link.target : nodeById.get(link.target);
    const sourceId = source?.id ?? String(link.source);
    const targetId = target?.id ?? String(link.target);
    setSelected(`edge:${link.id}`);
    hi.current = { nodes: new Set([sourceId, targetId]), links: new Set([link]) };
    setSel({
      label: link.label ?? link.type,
      type: 'relationship',
      content: `${source?.label ?? sourceId} → ${target?.label ?? targetId}`,
      data: { ...link.data, truth: link.truth, edgeType: link.type, weight: link.weight },
      connected: 2,
    });
  };
  const clearFocus = () => { setSelected(null); hi.current = { nodes: new Set(), links: new Set() }; setSel(null); };

  // search → fly to first match
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      if (query) { const hit = data.nodes.find((n) => !typeHidden(n.type) && matches(n)); if (hit) { stopOrbit(); onNodeClick(hit); } }
      else clearFocus();
      bump();
    }, 240);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggleType = (t: string) => setHideType((prev) => { const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next; });
  const fit = () => { try { fgRef.current?.zoomToFit(700, 60); } catch { /* ignore */ } };
  const reset = () => { clearFocus(); setQuery(''); setHideType(new Set()); setShowSimilar(true); fit(); };

  const expandNeighborhood = async () => {
    if (!selected) return;
    setExpanding(true);
    try {
      const neighborhood = await getGraphNeighborhood(selected, 2);
      setData((current) => {
        if (!current) return current;
        const nodes = new Map(current.nodes.map((node) => [node.id, node]));
        for (const node of neighborhood.nodes) if (!nodes.has(node.id)) nodes.set(node.id, { ...node });
        const links = new Map<string, GLink>();
        for (const link of current.links) links.set(link.id, {
          ...link,
          source: typeof link.source === 'object' ? link.source.id : link.source,
          target: typeof link.target === 'object' ? link.target.id : link.target,
        });
        for (const link of neighborhood.edges) links.set(link.id, { ...link });
        return { nodes: Array.from(nodes.values()), links: Array.from(links.values()) };
      });
    } finally { setExpanding(false); }
  };

  const focusing = !!selected || !!query;

  return (
    <div ref={wrap} className="relative overflow-hidden rounded-xl border border-border" style={{ height, background: 'radial-gradient(120% 90% at 50% 42%, #1c1411 0%, #120d14 40%, #0a0810 70%, #07050a 100%)' }}>
      {status === 'ready' && data && dims.w > 0 && (
        <ForceGraph3D<GNode, GLink>
          ref={fgRef}
          width={dims.w}
          height={dims.h}
          graphData={data}
          backgroundColor="rgba(7,5,10,0)"
          showNavInfo={false}
          nodeId="id"
          nodeVal={nodeVal}
          nodeRelSize={1.15}
          nodeResolution={reduceMotion() ? 8 : 14}
          nodeOpacity={0.92}
          nodeVisibility={(n) => !typeHidden(n.type)}
          nodeColor={(n) => {
            const base = baseNodeColor(n);
            if (focusing) return (hi.current.nodes.has(n.id) || matches(n)) ? base : dim(base, 0.1);
            return base;
          }}
          nodeLabel={(n) => labelHtml(n)}
          linkVisibility={linkVisible}
          linkColor={(l) => {
            if (hi.current.links.has(l)) return l.type === 'similar' ? dim(COLOR.similar, 0.95) : 'rgba(255,255,255,0.7)';
            if (focusing) return l.type === 'similar' ? dim(COLOR.similar, 0.06) : 'rgba(255,255,255,0.02)';
            // Stored fact→entity edges read brighter than inferred (substring) ones.
            if (l.type === 'entity') return dim(COLOR.entity, l.inferred ? 0.07 : 0.22);
            return (EDGE_BASE[l.type] || EDGE_BASE.kind)(l.weight);
          }}
          linkWidth={(l) => (hi.current.links.has(l) ? 1.4 : l.type === 'similar' ? 0.5 : 0.25)}
          linkCurvature={(l) => (l.type === 'similar' ? 0.12 : 0)}
          linkLabel={(l) => l.label ?? l.type}
          linkDirectionalArrowLength={(l) => (l.type === 'related' ? 3.5 : 0)}
          linkDirectionalArrowRelPos={0.72}
          linkDirectionalArrowColor={(l) => (l.type === 'related' ? dim(COLOR.entity, 0.85) : 'rgba(255,255,255,0)')}
          linkDirectionalParticles={(l) => (!reduceMotion() && hi.current.links.has(l) && l.type === 'similar' ? 3 : 0)}
          linkDirectionalParticleWidth={1.4}
          linkDirectionalParticleSpeed={0.01}
          linkDirectionalParticleColor={() => COLOR.similar}
          onNodeHover={onHover}
          onNodeClick={onNodeClick}
          onLinkClick={onLinkClick}
          onBackgroundClick={clearFocus}
          warmupTicks={reduceMotion() ? 60 : 20}
          cooldownTime={reduceMotion() ? 0 : 4000}
          enableNodeDrag={false}
        />
      )}

      {status === 'ready' && (
        <>
          {/* filters + search (top-left) */}
          <div className="absolute left-3 top-3 flex max-w-[calc(100%-9rem)] flex-wrap items-center gap-1.5">
            {presentTypes.map((t) => {
              const off = hideType.has(t.type);
              return (
                <button key={t.type} type="button" onClick={() => toggleType(t.type)}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption backdrop-blur transition-colors cursor-pointer',
                    off ? 'border-white/10 bg-black/40 text-white/40 line-through' : 'border-white/15 bg-black/50 text-white/80')}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: off ? '#666' : t.color, boxShadow: off ? 'none' : `0 0 8px ${t.color}` }} aria-hidden />{t.label}
                </button>
              );
            })}
            {showOverlays && <button type="button" onClick={() => setShowSimilar((v) => !v)}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption backdrop-blur transition-colors cursor-pointer',
                !showSimilar ? 'border-white/10 bg-black/40 text-white/40 line-through' : 'border-white/15 bg-black/50 text-white/80')}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: !showSimilar ? '#666' : COLOR.similar, boxShadow: !showSimilar ? 'none' : `0 0 8px ${COLOR.similar}` }} aria-hidden />Similar links
            </button>}
            <button type="button" onClick={() => setShowOverlays((value) => !value)}
              title="Stored truth is the default; this adds explicitly labeled inferred and semantic overlays."
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption backdrop-blur transition-colors cursor-pointer',
                showOverlays ? 'border-violet-300/50 bg-violet-400/20 text-violet-100' : 'border-white/15 bg-black/50 text-white/80')}>
              <Layers3 className="h-3.5 w-3.5" aria-hidden /> {showOverlays ? 'Augmented view' : 'Stored truth'}
            </button>
            <div className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-2.5 py-1 backdrop-blur">
              <Search className="h-3.5 w-3.5 text-white/50" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value.trim().toLowerCase())} placeholder="Find…" aria-label="Find in graph"
                className="w-24 bg-transparent text-caption text-white outline-none placeholder:text-white/40" />
            </div>
          </div>

          {/* controls (top-right) */}
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <button type="button" onClick={() => setBloomOn((v) => !v)} aria-label="Toggle glow" title="Toggle glow"
              className={cn('rounded-md border p-1.5 backdrop-blur cursor-pointer', bloomOn ? 'border-amber-300/50 bg-amber-400/20 text-amber-200' : 'border-white/15 bg-black/50 text-white/70 hover:text-white')}>
              <Sparkles className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" onClick={reset} aria-label="Reset" title="Reset view"
              className="rounded-md border border-white/15 bg-black/50 p-1.5 text-white/70 backdrop-blur hover:text-white cursor-pointer"><RotateCcw className="h-4 w-4" aria-hidden /></button>
            <button type="button" onClick={fit} aria-label="Fit" title="Fit to view"
              className="rounded-md border border-white/15 bg-black/50 p-1.5 text-white/70 backdrop-blur hover:text-white cursor-pointer"><Maximize2 className="h-4 w-4" aria-hidden /></button>
          </div>

          {!sel && (
            <>
              <div className="pointer-events-none absolute bottom-3 left-3 max-w-[45%] text-caption text-white/45">
                Drag to orbit · scroll to zoom · click a star to dive in
              </div>
              <div className="pointer-events-none absolute bottom-3 right-3 max-w-[52%] rounded-md bg-black/50 px-2 py-1 text-right text-caption text-white/60 backdrop-blur"
                title={counts.totalFacts > counts.facts ? `Showing the ${counts.facts} most relevant of ${counts.totalFacts} facts` : undefined}>
                {counts.totalFacts > counts.facts ? `${counts.facts} of ${counts.totalFacts}` : counts.facts} facts
                {' · '}{counts.totalRelationships > counts.relationships ? `${counts.relationships} of ${counts.totalRelationships}` : counts.relationships} entity relations
                {' · '}{counts.stored} stored edges{showOverlays ? ` · ${counts.inferred} inferred · ${counts.semantic} semantic` : ''}
              </div>
            </>
          )}
        </>
      )}

      {status === 'loading' && <Overlay>Igniting the constellation…</Overlay>}
      {status === 'empty' && <Overlay>Nothing to map yet — Clementine will fill this in as it learns.</Overlay>}
      {status === 'error' && <Overlay>Couldn’t load the graph.</Overlay>}
      {status === 'nowebgl' && <Overlay>This view needs WebGL / hardware acceleration — enable it to see the constellation.</Overlay>}

      {sel && (
        <div className="absolute bottom-3 right-3 w-72 rounded-lg border border-white/15 bg-black/70 p-3 text-white shadow-lg backdrop-blur">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide" style={{ color: sel.type === 'fact' ? KIND_COLOR[(sel.data?.kind as string)] || '#FBE9D6' : sel.type === 'relationship' ? COLOR.entity : (COLOR as Record<string, string>)[sel.type] }}>
              {sel.type === 'fact' ? (KIND_LABEL[(sel.data?.kind as string)] || 'Fact') : sel.type === 'relationship' ? 'Stored relationship' : (NODE_TYPE_LABEL[sel.type] ?? 'Topic')}
            </span>
            <button type="button" onClick={clearFocus} aria-label="Close" className="cursor-pointer text-white/50 hover:text-white"><X className="h-4 w-4" aria-hidden /></button>
          </div>
          <div className="text-body font-medium">{sel.label}</div>
          {sel.type === 'entity' && Array.isArray(sel.data?.aliases) && (sel.data.aliases as string[]).length > 0 && (
            <p className="mt-1 line-clamp-2 text-caption text-white/55">aka {(sel.data.aliases as string[]).join(', ')}</p>
          )}
          {sel.content && <p className="mt-1 max-h-40 overflow-auto text-small text-white/70">{sel.content}</p>}
          {sel.type === 'relationship' && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-100">{String(sel.data?.truth ?? 'stored')} truth</span>
                {typeof sel.data?.confidence === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{Math.round((sel.data.confidence as number) * 100)}% confidence</span>}
                {typeof sel.data?.evidenceCount === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.evidenceCount as number} evidence {sel.data.evidenceCount === 1 ? 'source' : 'sources'}</span>}
              </div>
              {(typeof sel.data?.validFrom === 'string' || typeof sel.data?.validTo === 'string') && (
                <p className="text-caption text-white/50">
                  Valid {typeof sel.data.validFrom === 'string' ? `from ${new Date(sel.data.validFrom).toLocaleDateString()}` : ''}{typeof sel.data.validTo === 'string' ? ` until ${new Date(sel.data.validTo).toLocaleDateString()}` : ' · current'}
                </p>
              )}
              {sel.data?.edgeType === 'observed' ? (
                <div className="rounded-md border border-violet-300/20 bg-violet-400/10 p-2 text-caption text-violet-100">
                  Exact source observation{typeof sel.data?.sourceKind === 'string' ? ` · ${(sel.data.sourceKind as string).replace(/_/g, ' ')}` : ''}
                  {typeof sel.data?.observedAt === 'string' ? ` · ${new Date(sel.data.observedAt as string).toLocaleDateString()}` : ''}
                  {typeof sel.data?.sourceUri === 'string' && <p className="mt-1 truncate text-[10px] text-violet-100/60" title={sel.data.sourceUri as string}>{sel.data.sourceUri as string}</p>}
                </div>
              ) : Array.isArray(sel.data?.evidence) && (sel.data.evidence as RelationshipEvidence[]).length > 0 ? (
                <div className="max-h-44 space-y-2 overflow-auto border-t border-white/10 pt-2">
                  {(sel.data.evidence as RelationshipEvidence[]).map((evidence, index) => (
                    <div key={`${evidence.episodeId}:${index}`} className="rounded-md border border-white/10 bg-white/5 p-2">
                      <p className="text-caption leading-relaxed text-white/75">“{evidence.excerpt}”</p>
                      <p className="mt-1 text-[10px] text-white/40">
                        {evidence.extractionMethod?.replace(/_/g, ' ') ?? 'source evidence'}
                        {evidence.episodeStatus ? ` · ${evidence.episodeStatus}` : ''}
                        {evidence.observedAt ? ` · ${new Date(evidence.observedAt).toLocaleDateString()}` : ''}
                      </p>
                      {evidence.sourceUri && <p className="mt-0.5 truncate text-[10px] text-white/35" title={evidence.sourceUri}>{evidence.sourceUri}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-amber-300/20 bg-amber-400/10 p-2 text-caption text-amber-100">Legacy stored edge — no grounded excerpt is available yet.</p>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sel.data?.pinned === true && <span className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-semibold text-amber-950">pinned</span>}
            {typeof sel.data?.importance === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">importance {sel.data.importance as number}/10</span>}
            {sel.type === 'tool-recall' && typeof sel.data?.chosenTool === 'string' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">→ {sel.data.chosenTool as string}</span>}
            {sel.type === 'tool-recall' && typeof sel.data?.score === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{Math.round((sel.data.score as number) * 100)}% success</span>}
            {sel.type === 'skill' && typeof sel.data?.tier === 'string' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.tier as string}</span>}
            {(sel.type === 'goal' || sel.type === 'focus') && typeof sel.data?.status === 'string' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.status as string}</span>}
            {sel.type === 'workflow' && typeof sel.data?.steps === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.steps as number} steps</span>}
            {sel.type === 'entity' && typeof sel.data?.factCount === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.factCount as number} facts</span>}
            {sel.type === 'entity' && typeof sel.data?.mention_count === 'number' && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.data.mention_count as number} mentions</span>}
            {sel.type === 'entity' && typeof sel.data?.observationCount === 'number' && (sel.data.observationCount as number) > 0 && <span className="rounded-full border border-violet-300/30 bg-violet-400/10 px-2 py-0.5 text-[10px] text-violet-100">{sel.data.observationCount as number} source episodes</span>}
            {sel.type === 'entity' && typeof sel.data?.identifierCount === 'number' && (sel.data.identifierCount as number) > 0 && <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-100">{sel.data.identifierCount as number} stable IDs</span>}
            {sel.connected > 0 && <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70">{sel.connected} connected</span>}
          </div>
          {sel.type !== 'relationship' && <button type="button" onClick={() => void expandNeighborhood()} disabled={expanding}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-white/20 px-2.5 py-1.5 text-caption text-white/80 hover:bg-white/10 disabled:opacity-50">
            <Layers3 className="h-3.5 w-3.5" aria-hidden /> {expanding ? 'Expanding…' : 'Expand stored neighborhood'}
          </button>}
        </div>
      )}
    </div>
  );
}

function labelHtml(n: GNode): string {
  const kind = n.type === 'fact' ? (KIND_LABEL[(n.data?.kind as string)] || 'Fact')
    : n.type === 'entity' ? ((n.data?.entity_type as string) || 'entity')
    : n.type === 'file' ? 'file' : (NODE_TYPE_LABEL[n.type] ?? 'topic');
  const txt = n.type === 'fact' ? ((n.data?.content as string) || n.label) : n.label;
  const esc = String(txt).slice(0, 180).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] as string));
  return `<div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:12px;color:#F6EEE6;background:rgba(16,11,18,0.92);border:1px solid rgba(255,180,120,0.16);padding:7px 10px;border-radius:9px;max-width:280px;box-shadow:0 8px 24px rgba(0,0,0,0.5)"><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:0.07em;opacity:0.7;margin-bottom:2px">${kind}</div>${esc}</div>`;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-body text-white/70">{children}</div>;
}
