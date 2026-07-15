import { useEffect, useRef, useState } from 'react';
import { X, Maximize2, Minimize2, RotateCcw, Search } from 'lucide-react';
import type { Core, NodeSingular, CollectionReturnValue } from 'cytoscape';
import { getGraph } from '@/lib/memory';
import { cn } from '@/lib/cn';

let fcoseRegistered = false;
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

const KIND_LABELS: Record<string, string> = { USER: 'About you', PROJECT: 'Projects', FEEDBACK: 'Feedback', REFERENCE: 'Reference', CONSTRAINT: 'Constraints' };

const TYPES: { type: string; label: string; varName?: string; hex?: string }[] = [
  { type: 'kind', label: 'Topics', varName: '--primary' },
  { type: 'entity', label: 'People & things', varName: '--success' },
  { type: 'file', label: 'Files', varName: '--info' },
  { type: 'resource', label: 'Resources', hex: '#75E6B1' },
  { type: 'episode', label: 'Episodes', hex: '#BFA7FF' },
  { type: 'policy', label: 'Policies', hex: '#FF6B6B' },
  { type: 'fact', label: 'Facts', varName: '--text-subtle' },
  // WS1 non-fact stores (fixed hex — no theme var). Shown only when present.
  { type: 'tool-recall', label: 'Tool recall', hex: '#7CF5A6' },
  { type: 'skill', label: 'Skills', hex: '#FFD166' },
  { type: 'workflow', label: 'Workflows', hex: '#67B7FF' },
  { type: 'goal', label: 'Goals', hex: '#FF6FA8' },
  { type: 'focus', label: 'Focus', hex: '#C792EA' },
];
// Fixed colors for the non-fact node types (parity with the 3D constellation).
const STORE_COLOR: Record<string, string> = {
  'tool-recall': '#7CF5A6', skill: '#FFD166', workflow: '#67B7FF', goal: '#FF6FA8', focus: '#C792EA',
  resource: '#75E6B1', episode: '#BFA7FF', policy: '#FF6B6B',
};

// Which topic rooms the user has folded — persisted so returning users keep
// their tidied layout. A brand-new user (no key) gets an empty set → all rooms
// open, so the first impression is the rich "look how much it knows" view.
const COLLAPSE_KEY = 'mem.collapsedRooms';
function loadCollapsed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveCollapsed(set: Set<string>): void {
  try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

interface Sel { label: string; type: string; content?: string; data?: Record<string, unknown> }

export function MemoryGraph({ height = 480 }: { height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const pulseRef = useRef(false);
  // Removed fact children of each collapsed room, keyed by kind-node id.
  // restore() needs the EXACT collection remove() returned (it remembers
  // each node's data/position/parent + connected edges).
  const stashedRef = useRef<Map<string, CollectionReturnValue>>(new Map());
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [counts, setCounts] = useState({ facts: 0, context: 0, edges: 0 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hiddenRef = useRef(hidden);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Sel | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [roomCount, setRoomCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cyMod, fcoseMod, data] = await Promise.all([import('cytoscape'), import('cytoscape-fcose'), getGraph()]);
        if (cancelled || !container.current) return;
        const cytoscape = cyMod.default;
        if (!fcoseRegistered) { cytoscape.use(fcoseMod.default); fcoseRegistered = true; }

        const allNodes = data.nodes ?? [];
        const edges = (data.edges ?? []).filter((e) => e.source && e.target);
        if (allNodes.length === 0) { setStatus('empty'); return; }

        const deg = new Map<string, number>();
        for (const e of edges) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }

        // Topic clustering: each topic (kind) is a labeled CONTAINER and its
        // facts live inside it (compound parent). Facts are always shown (in
        // their topic); files/people only when connected. We drop the implicit
        // fact→topic edges (membership shows that) and keep the meaningful
        // cross-links — a fact referencing a file/entity — so it reads as a
        // map, not a hairball.
        const nodes = allNodes.filter((n) => n.type === 'kind' || n.type === 'fact' || (deg.get(n.id) || 0) > 0);
        const kept = new Set(nodes.map((n) => n.id));
        const keptEdges = edges.filter((e) => e.type !== 'kind' && kept.has(e.source) && kept.has(e.target));

        const color: Record<string, string> = { kind: cssVar('--primary'), fact: cssVar('--text-subtle'), file: cssVar('--info'), entity: cssVar('--success'), ...STORE_COLOR };
        const surface = cssVar('--bg-surface');
        const text = cssVar('--text');
        const edgeColor = cssVar('--border-strong');
        const primary = cssVar('--primary');

        const cy = cytoscape({
          container: container.current,
          elements: [
            ...nodes.map((n) => {
              const parentId = n.type === 'fact' && typeof n.data?.kind === 'string' ? `kind:${n.data.kind}` : undefined;
              return {
                data: {
                  id: n.id, label: n.type === 'kind' ? (KIND_LABELS[n.label] ?? n.label) : n.label,
                  type: n.type, content: (n.data?.content as string) ?? '',
                  parent: parentId && kept.has(parentId) ? parentId : undefined,
                  size: Math.max(16, Math.min(44, 16 + (deg.get(n.id) || 0) * 4)),
                  color: color[n.type] ?? color.fact,
                },
              };
            }),
            ...keptEdges.map((e) => ({ data: {
              id: e.id, source: e.source, target: e.target, type: e.type,
              label: e.label ?? '', truth: e.truth, details: e.data ?? {},
            } })),
          ],
          style: [
            {
              selector: 'node',
              style: {
                'background-color': 'data(color)', width: 'data(size)', height: 'data(size)',
                'border-width': 2, 'border-color': surface, label: '',
                'transition-property': 'width height opacity border-width', 'transition-duration': 150,
              },
            },
            {
              // Topic container (compound parent): a soft tinted "room" with a
              // clear orange header tab naming the topic.
              selector: 'node[type="kind"]',
              style: {
                shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.06,
                'border-width': 1.5, 'border-color': 'data(color)', 'border-opacity': 0.5,
                label: 'data(label)', color: '#ffffff', 'font-size': 15, 'font-weight': 800,
                'font-family': 'Plus Jakarta Sans Variable, sans-serif',
                'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -13,
                'text-background-color': 'data(color)', 'text-background-opacity': 1,
                'text-background-padding': '6px', 'text-background-shape': 'roundrectangle',
                padding: '20px', 'z-index': 1,
              },
            },
            {
              // Collapsed room = a tidy orange pill. The facts are REMOVED (not
              // display:none'd), so the node is no longer a compound and the
              // explicit width/height/label below are honored. Reuses the same
              // orange tokens as the header tab so identity is stable.
              selector: 'node[type="kind"].collapsed',
              style: {
                // Invisible body (wide, for packing spacing) + a solid orange
                // text pill as the only visible element, so tiled chips don't
                // collide and labels never clip.
                shape: 'round-rectangle', width: 172, height: 44, padding: '0px',
                'background-opacity': 0, 'border-width': 0,
                label: 'data(collapsedLabel)',
                'text-valign': 'center', 'text-halign': 'center', 'text-margin-y': 0,
                color: '#ffffff', 'font-size': 12, 'font-weight': 800,
                'font-family': 'Plus Jakarta Sans Variable, sans-serif',
                'text-background-color': 'data(color)', 'text-background-opacity': 1,
                'text-background-padding': '8px', 'text-background-shape': 'roundrectangle',
                'z-index': 3,
              },
            },
            { selector: 'edge', style: { width: 1, 'line-color': edgeColor, 'curve-style': 'bezier', opacity: 0.4, 'z-index': 0 } },
            { selector: 'edge[truth="inferred"]', style: { 'line-style': 'dashed', opacity: 0.25 } },
            { selector: 'edge[truth="semantic"]', style: { 'line-style': 'dotted', opacity: 0.25 } },
            {
              selector: 'edge[type="related"]',
              style: {
                label: 'data(label)', 'font-size': 9, color: text,
                'text-background-color': surface, 'text-background-opacity': 0.85,
                'text-background-padding': '3px', 'target-arrow-shape': 'triangle',
                'target-arrow-color': edgeColor, opacity: 0.7,
              },
            },
            { selector: '.hovered', style: { 'border-width': 4, 'border-color': primary, label: 'data(label)', color: text, 'font-size': 10, 'text-outline-color': surface, 'text-outline-width': 3, 'z-index': 99 } },
            { selector: 'edge.hl', style: { 'line-color': primary, opacity: 0.9, width: 2, 'z-index': 90 } },
            { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0 } },
            { selector: '.match', style: { 'border-width': 4, 'border-color': primary, 'z-index': 80 } },
            { selector: 'node:selected', style: { 'border-width': 4, 'border-color': primary } },
          ],
          minZoom: 0.15, maxZoom: 3, wheelSensitivity: 0.2,
        });

        // Apply any persisted folds BEFORE the first layout so we lay out the
        // already-collapsed graph once (no double settle).
        collapsed.forEach((id) => collapseRoom(cy, id, stashedRef.current, hiddenRef.current, false));
        applyVisibility(cy, hiddenRef.current);
        runLayout(cy);

        cy.on('mouseover', 'node', (e) => (e.target as NodeSingular).addClass('hovered'));
        cy.on('mouseout', 'node', (e) => (e.target as NodeSingular).removeClass('hovered'));
        cy.on('tap', 'node', (evt) => {
          const n = evt.target as NodeSingular;
          // Tap a topic room → fold/unfold it. Facts/people/files render on top
          // of the room body, so a body tap lands on those (focus); only a bare
          // tap on the room frame/header hits the kind node (collapse).
          if (n.data('type') === 'kind') {
            cy.elements().removeClass('faded hl');   // clear any prior focus dimming
            setSelected(null);
            const id = n.id();
            const wasCollapsed = n.hasClass('collapsed');
            if (wasCollapsed) expandRoom(cy, id, stashedRef.current, hiddenRef.current);
            else collapseRoom(cy, id, stashedRef.current, hiddenRef.current);
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (wasCollapsed) next.delete(id); else next.add(id);
              saveCollapsed(next);
              return next;
            });
            return;
          }
          const d = n.data();
          setSelected({ label: d.label, type: d.type, content: d.content });
          cy.elements().addClass('faded');
          const hood = n.closedNeighborhood().union(n.descendants()).union(n.ancestors());
          hood.removeClass('faded');
          hood.edgesWith(hood).removeClass('faded').addClass('hl');
        });
        cy.on('tap', 'edge[type="related"]', (evt) => {
          const edge = evt.target;
          const details = edge.data('details') as Record<string, unknown>;
          const evidence = Array.isArray(details?.evidence) ? details.evidence as Array<{ excerpt?: string }> : [];
          setSelected({
            label: edge.data('label') || 'relationship',
            type: 'stored relationship',
            content: `${edge.source().data('label')} → ${edge.target().data('label')}${evidence[0]?.excerpt ? `\n\nEvidence: “${evidence[0].excerpt}”` : '\n\nLegacy edge — no grounded excerpt available.'}`,
            data: details,
          });
          cy.elements().addClass('faded');
          edge.removeClass('faded').addClass('hl');
          edge.source().removeClass('faded');
          edge.target().removeClass('faded');
        });
        cy.on('tap', (evt) => { if (evt.target === cy) { setSelected(null); cy.elements().removeClass('faded hl'); } });

        cyRef.current = cy;
        setCounts({
          facts: nodes.filter((n) => n.type === 'fact').length,
          context: nodes.filter((n) => n.type !== 'kind' && n.type !== 'fact').length,
          edges: keptEdges.length,
        });
        setRoomCount(cy.nodes('[type="kind"]').length);
        // Drop any persisted fold-ids for rooms that no longer exist, so
        // collapsed.size can't outrun the real room count (toggle correctness).
        const valid = new Set([...collapsed].filter((id) => !cy.getElementById(id).empty()));
        if (valid.size !== collapsed.size) { setCollapsed(valid); saveCollapsed(valid); }
        setStatus('ready');

        if (!reduceMotion()) {
          pulseRef.current = true;
          const pulse = () => {
            if (!pulseRef.current || !cyRef.current) return;
            const kinds = cyRef.current.nodes('[type="kind"]');
            kinds.animate({ style: { 'border-opacity': 0.95 } }, {
              duration: 1500,
              complete: () => kinds.animate({ style: { 'border-opacity': 0.45 } }, { duration: 1500, complete: pulse }),
            });
          };
          setTimeout(pulse, 1100);
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; pulseRef.current = false; stashedRef.current.clear(); try { cyRef.current?.destroy(); } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    hiddenRef.current = hidden;
    const cy = cyRef.current;
    if (!cy) return;
    applyVisibility(cy, hidden);
  }, [hidden]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = query.trim().toLowerCase();
    cy.batch(() => {
      cy.elements().removeClass('match faded hl');
      if (!q) return;
      const matches = cy.nodes().filter((n) => `${n.data('label')} ${n.data('content')}`.toLowerCase().includes(q));
      cy.elements().addClass('faded');
      matches.removeClass('faded').addClass('match');
      matches.connectedEdges().removeClass('faded');
      matches.neighborhood().removeClass('faded');
    });
  }, [query]);

  const fit = () => { try { cyRef.current?.animate({ fit: { eles: cyRef.current.elements(':visible'), padding: 30 } } as never, { duration: 300 }); } catch { /* ignore */ } };
  const reset = () => {
    const cy = cyRef.current; if (!cy) return;
    cy.nodes('[type="kind"]').forEach((k) => expandRoom(cy, k.id(), stashedRef.current, hiddenRef.current, false));
    setCollapsed(new Set()); saveCollapsed(new Set());
    cy.elements().removeClass('faded match hl'); setSelected(null); setQuery('');
    runLayout(cy);
  };
  const toggleType = (t: string) => setHidden((prev) => { const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next; });

  const anyExpanded = roomCount > 0 && collapsed.size < roomCount;
  const setAllRooms = (collapse: boolean) => {
    const cy = cyRef.current; if (!cy) return;
    const next = new Set<string>();
    cy.nodes('[type="kind"]').forEach((k) => {
      const id = k.id();
      if (collapse) { collapseRoom(cy, id, stashedRef.current, hiddenRef.current, false); next.add(id); }
      else { expandRoom(cy, id, stashedRef.current, hiddenRef.current, false); }
    });
    runLayout(cy);
    setCollapsed(next); saveCollapsed(next);
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-subtle" style={{ height }}>
      <div ref={container} className="h-full w-full" />

      {status === 'ready' && (
        <>
          <div className="absolute left-3 top-3 flex max-w-[calc(100%-9rem)] flex-wrap items-center gap-1.5">
            {TYPES.map((t) => {
              const off = hidden.has(t.type);
              return (
                <button key={t.type} type="button" onClick={() => toggleType(t.type)}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption backdrop-blur transition-colors cursor-pointer',
                    off ? 'border-border bg-surface/70 text-faint line-through' : 'border-border bg-surface/90 text-muted')}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: off ? 'var(--text-subtle)' : (t.hex ?? cssVar(t.varName ?? '')) }} aria-hidden />{t.label}
                </button>
              );
            })}
            <div className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/90 px-2.5 py-1 backdrop-blur">
              <Search className="h-3.5 w-3.5 text-faint" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find…" aria-label="Find in graph" className="w-24 bg-transparent text-caption text-fg outline-none placeholder:text-faint" />
            </div>
          </div>
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <span className="rounded-md bg-surface/90 px-2 py-1 text-caption text-faint backdrop-blur">{counts.facts} facts · {counts.context} context nodes · {counts.edges} stored links</span>
            <button type="button" onClick={() => setAllRooms(anyExpanded)}
              aria-label={anyExpanded ? 'Collapse all rooms' : 'Expand all rooms'}
              title={anyExpanded ? 'Fold every topic into a tidy chip' : 'Open every topic to see its facts'}
              className="rounded-md border border-border bg-surface/90 p-1.5 text-muted backdrop-blur hover:text-fg cursor-pointer">
              {anyExpanded ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            </button>
            <button type="button" onClick={reset} aria-label="Reset" title="Reset layout" className="rounded-md border border-border bg-surface/90 p-1.5 text-muted backdrop-blur hover:text-fg cursor-pointer"><RotateCcw className="h-4 w-4" aria-hidden /></button>
            <button type="button" onClick={fit} aria-label="Fit" title="Fit to view" className="rounded-md border border-border bg-surface/90 p-1.5 text-muted backdrop-blur hover:text-fg cursor-pointer"><Maximize2 className="h-4 w-4" aria-hidden /></button>
          </div>

          {!selected && (
            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[55%] text-caption text-faint">
              Drag to explore · tap a topic to fold it · tap a node for details
            </div>
          )}
        </>
      )}

      {status === 'loading' && <Overlay>Mapping what Clementine knows…</Overlay>}
      {status === 'empty' && <Overlay>Nothing to map yet — Clementine will fill this in as it learns.</Overlay>}
      {status === 'error' && <Overlay>Couldn't load the graph.</Overlay>}

      {selected && (
        <div className="absolute bottom-3 right-3 w-72 rounded-lg border border-border bg-surface p-3 shadow-md">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide text-faint">{selected.type === 'kind' ? 'Topic' : selected.type}</span>
            <button type="button" onClick={() => { setSelected(null); cyRef.current?.elements().removeClass('faded hl'); }} aria-label="Close" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>
          </div>
          <div className="text-body font-medium text-fg">{selected.label}</div>
          {selected.content && <p className="mt-1 max-h-40 whitespace-pre-line overflow-auto text-small text-muted">{selected.content}</p>}
        </div>
      )}
    </div>
  );
}

function collapseRoom(cy: Core, kindId: string, stash: Map<string, CollectionReturnValue>, hidden: Set<string>, relayout = true): void {
  const room = cy.getElementById(kindId);
  if (room.empty() || room.hasClass('collapsed') || stash.has(kindId)) return;
  const facts = room.children();
  const count = facts.length;
  cy.batch(() => {
    // Remove + stash the facts (and their edges). The room becomes a clean chip.
    stash.set(kindId, facts.remove());
    room.data('collapsedLabel', `▸ ${room.data('label')} · ${count}`);
    room.addClass('collapsed');                // now childless → width/height/label honored
  });
  applyVisibility(cy, hidden);                 // hide people/files orphaned by the fold
  // Fresh layout (animated) re-integrates + fits; folding reflows smoothly.
  if (relayout) runLayout(cy);
}

function expandRoom(cy: Core, kindId: string, stash: Map<string, CollectionReturnValue>, hidden: Set<string>, relayout = true): void {
  const room = cy.getElementById(kindId);
  if (!room.hasClass('collapsed')) return;
  const kids = stash.get(kindId);
  cy.batch(() => {
    kids?.restore();                           // re-adds facts + their original edges
    stash.delete(kindId);
    room.removeClass('collapsed');
    room.removeData('collapsedLabel');
  });
  applyVisibility(cy, hidden);                 // re-show people/files that reconnect
  if (relayout) runLayout(cy);
}

// Single source of truth for what's visible. A node is shown unless its TYPE is
// filtered off; additionally, a person/file is shown only when it still
// connects to a present fact — so folding a room cleanly removes the leaves
// that were only attached to it (display:none also drops them from the layout,
// so no orphan dots or empty gaps remain).
function applyVisibility(cy: Core, hidden: Set<string>): void {
  const hide = new Set<string>();
  // Pass 1: type filter (Topics / People / Files / Facts chips).
  cy.nodes().forEach((n) => { if (hidden.has(n.data('type'))) hide.add(n.id()); });
  // Pass 2: a person/file shows only if it still connects to a VISIBLE node.
  // (connectedEdges() counts edges to display-hidden facts, so we check the
  // neighbour against the pass-1 set — keeps the Facts filter from leaving
  // orphan dots, and folding a room drops its now-edgeless leaves.)
  cy.nodes().forEach((n) => {
    const t = n.data('type');
    if ((t === 'entity' || t === 'file') && !hide.has(n.id())) {
      let linked = false;
      n.connectedEdges().forEach((e) => {
        const other = e.source().id() === n.id() ? e.target() : e.source();
        if (!hide.has(other.id())) linked = true;
      });
      if (!linked) hide.add(n.id());
    }
  });
  cy.batch(() => {
    cy.nodes().forEach((n) => { n.style('display', hide.has(n.id()) ? 'none' : 'element'); });
    cy.edges().forEach((e) => { e.style('display', (hide.has(e.source().id()) || hide.has(e.target().id())) ? 'none' : 'element'); });
  });
}

function runLayout(cy: Core, opts: Record<string, unknown> = {}): void {
  const animate = !reduceMotion();
  // fcose pulls disconnected collapsed chips to the gravity centre (they pile
  // up). So lay out only the connected cluster with fcose, then place the
  // folded chips in a tidy row ourselves and fit everything.
  const chips = cy.nodes('node[type="kind"].collapsed');
  const hasChips = chips.nonempty();
  const target = hasChips ? cy.elements().not('node[type="kind"].collapsed') : cy.elements();
  const layout = target.layout({
    name: 'fcose', animate, animationDuration: 900, randomize: true, packComponents: true,
    nodeSeparation: 75, idealEdgeLength: 70, nodeRepulsion: 5500,
    gravity: 0.35, gravityCompound: 3, gravityRangeCompound: 1.2,
    padding: 30, fit: !hasChips, ...opts,
  } as never);
  if (hasChips) {
    layout.one('layoutstop', () => {
      arrangeCollapsedChips(cy);
      try { cy.animate({ fit: { eles: cy.elements(':visible'), padding: 36 } } as never, { duration: 320 }); } catch { /* ignore */ }
    });
  }
  layout.run();
}

// Lay folded chips out in a centred, wrapped row — above the connected cluster
// when one is showing, otherwise centred on their own.
function arrangeCollapsedChips(cy: Core): void {
  const chips = cy.nodes('node[type="kind"].collapsed');
  if (chips.empty()) return;
  const others = cy.nodes(':visible').difference(chips);
  const colW = 200, rowH = 66;
  const perRow = others.nonempty() ? Math.min(chips.length, 4) : Math.min(chips.length, 2);
  let cx = 0, baseY = 0;
  if (others.nonempty()) {
    const bb = others.boundingBox();
    cx = (bb.x1 + bb.x2) / 2;
    baseY = bb.y1 - 96;                 // sit just above the cluster
  }
  const cols = Math.max(1, perRow);
  const startX = cx - ((cols - 1) * colW) / 2;
  chips.forEach((chip, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    chip.position({ x: startX + c * colW, y: baseY - r * rowH });
  });
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-body text-muted">{children}</div>;
}
