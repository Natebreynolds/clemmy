/**
 * Directed "who can talk to whom" graph for the multi-agent workspace.
 * Nodes = team agents (colored by live status), directed edges =
 * `canMessage` permissions. When a fresh message/delegation flows between
 * polls, the matching edge briefly pulses so you can watch the team work.
 *
 * Built on cytoscape + fcose (same lib as MemoryGraph). The graph is
 * rebuilt only when the node/edge SET changes (structural key), so 4s
 * polling updates status colors and pulses without flicker.
 */
import { useEffect, useRef } from 'react';
import type { Core, NodeSingular } from 'cytoscape';
import type { AgentGraphData, AgentStatus } from '@/lib/agents';

let fcoseRegistered = false;
const reduceMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

const STATUS_VAR: Record<AgentStatus, string> = {
  active: '--primary',
  blocked: '--danger',
  idle: '--text-subtle',
};

function structuralKey(data: AgentGraphData): string {
  const nodes = data.nodes.map((n) => n.id).sort().join(',');
  const edges = data.edges.map((e) => `${e.source}>${e.target}`).sort().join(',');
  return `${nodes}|${edges}`;
}

export function AgentGraph({
  data,
  pulseEdge,
  pulseKey,
  onSelect,
  height = 420,
}: {
  data: AgentGraphData;
  pulseEdge?: { source: string; target: string } | null;
  pulseKey?: string;
  onSelect?: (slug: string) => void;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const sig = structuralKey(data);

  // Build (and rebuild on structural change). Status/pulse are handled by
  // the lighter effects below so polling doesn't reconstruct the graph.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cyMod, fcoseMod] = await Promise.all([import('cytoscape'), import('cytoscape-fcose')]);
      if (cancelled || !container.current) return;
      const cytoscape = cyMod.default;
      if (!fcoseRegistered) { cytoscape.use(fcoseMod.default); fcoseRegistered = true; }

      try { cyRef.current?.destroy(); } catch { /* ignore */ }

      const surface = cssVar('--bg-surface');
      const text = cssVar('--text');
      const edgeColor = cssVar('--border-strong');
      const primary = cssVar('--primary');

      const cy = cytoscape({
        container: container.current,
        elements: [
          ...data.nodes.map((n) => ({
            data: {
              id: n.id,
              label: n.label,
              role: n.role ?? '',
              primary: n.primary ? 1 : 0,
              status: n.status,
              kind: n.kind,
              color: n.kind === 'skill' ? cssVar('--info') : n.kind === 'workflow' ? cssVar('--success') : cssVar(STATUS_VAR[n.status]),
            },
          })),
          ...data.edges.map((e) => ({ data: { id: `${e.source}>${e.target}`, source: e.source, target: e.target, kind: e.kind } })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              width: 26, height: 26,
              'border-width': 2, 'border-color': surface,
              label: 'data(label)', color: text, 'font-size': 12, 'font-weight': 700,
              'font-family': 'Plus Jakarta Sans Variable, sans-serif',
              'text-valign': 'bottom', 'text-margin-y': 5,
              'transition-property': 'background-color border-width', 'transition-duration': 200,
            },
          },
          {
            // The orchestrator hub reads as the center of gravity.
            selector: 'node[primary = 1]',
            style: { width: 40, height: 40, 'border-width': 3, 'border-color': primary, 'font-size': 13, 'font-weight': 800 },
          },
          {
            // Skills + workflows are owned "assets" — rounded tiles, smaller,
            // visually distinct from the round agent nodes.
            selector: 'node[kind = "skill"], node[kind = "workflow"]',
            style: { shape: 'round-rectangle', width: 18, height: 18, 'font-size': 11, 'font-weight': 600, 'text-valign': 'bottom' },
          },
          {
            selector: 'edge',
            style: {
              width: 1.5, 'line-color': edgeColor, 'curve-style': 'bezier',
              'target-arrow-shape': 'triangle', 'target-arrow-color': edgeColor,
              'arrow-scale': 0.9, opacity: 0.45,
              'transition-property': 'line-color target-arrow-color width opacity', 'transition-duration': 200,
            },
          },
          {
            // Ownership edges (agent→skill / agent→workflow) read as quiet
            // dashed tethers, not directed messages.
            selector: 'edge[kind = "skill"], edge[kind = "workflow"]',
            style: { 'line-style': 'dashed', 'target-arrow-shape': 'none', opacity: 0.3, width: 1 },
          },
          { selector: 'edge.pulse', style: { 'line-color': primary, 'target-arrow-color': primary, width: 3.5, opacity: 1 } },
          { selector: '.hovered', style: { 'border-width': 4, 'border-color': primary } },
        ],
        minZoom: 0.3, maxZoom: 2.5, wheelSensitivity: 0.2,
      });

      cy.layout({
        name: 'fcose', animate: !reduceMotion(), animationDuration: 600, randomize: true,
        nodeSeparation: 120, idealEdgeLength: 110, nodeRepulsion: 6500, gravity: 0.3, padding: 40, fit: true,
      } as never).run();

      cy.on('mouseover', 'node', (e) => (e.target as NodeSingular).addClass('hovered'));
      cy.on('mouseout', 'node', (e) => (e.target as NodeSingular).removeClass('hovered'));
      cy.on('tap', 'node', (evt) => {
        const node = evt.target as NodeSingular;
        if (node.data('kind') === 'agent') onSelectRef.current?.(node.id());
      });

      cyRef.current = cy;
    })();
    return () => { cancelled = true; try { cyRef.current?.destroy(); } catch { /* ignore */ } cyRef.current = null; };
  }, [sig]);

  // Live status recolor without a rebuild.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      for (const n of data.nodes) {
        if (n.kind !== 'agent') continue; // skill/workflow nodes keep their kind color
        const el = cy.getElementById(n.id);
        if (!el.empty()) { el.data('status', n.status); el.data('color', cssVar(STATUS_VAR[n.status])); }
      }
    });
  }, [data]);

  // Pulse the edge for the freshest comms event.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !pulseEdge || reduceMotion()) return;
    const edge = cy.getElementById(`${pulseEdge.source}>${pulseEdge.target}`);
    if (edge.empty()) return;
    edge.addClass('pulse');
    const timer = setTimeout(() => { try { edge.removeClass('pulse'); } catch { /* ignore */ } }, 1400);
    return () => clearTimeout(timer);
  }, [pulseKey, pulseEdge]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-subtle" style={{ height }}>
      <div ref={container} className="h-full w-full" />
      {data.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-body text-muted">
          No agents yet — create one and it'll appear here.
        </div>
      )}
    </div>
  );
}
