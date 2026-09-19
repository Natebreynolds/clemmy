/**
 * A workflow's steps as a graph you can rewire.
 *
 * Read and write both go through the surface the form-based Automate screens
 * already use: GET /api/console/workflows/:name supplies the graph the daemon
 * derived from the workflow's own steps, and PATCH sends `steps` back. Nothing
 * here is a parallel representation — see lib/workflow-canvas.ts for why the
 * save only ever names `id` and `dependsOn`, and why a cycle is blocked here
 * rather than at the API.
 *
 * This screen is additive. The guided form at /automate and /automate/new is
 * untouched and remains the way a workflow is created.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, ArrowLeft, Loader2, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { getWorkflow, listWorkflows, patchWorkflow, type WorkflowDetail } from '@/lib/automate';
import {
  WorkflowCanvasNode,
  type WorkflowCanvasFlowNode,
} from '@/components/automate/WorkflowCanvasNode';
import {
  findCycle,
  graphDiffersFrom,
  loadPositions,
  newStepId,
  nextFreePosition,
  resolvePositions,
  SAVED_PLAINLY,
  saveOutcome,
  savePositions,
  toStepPatch,
  type CanvasGraph,
  type CanvasGraphNode,
  type CanvasPosition,
} from '@/lib/workflow-canvas';

const nodeTypes = { workflowStep: WorkflowCanvasNode };

/** The canvas edits a graph; an empty one still has to be a valid object. */
const EMPTY_GRAPH: CanvasGraph = { nodes: [], edges: [] };

/**
 * React Flow paints its own controls, minimap and edges, so it needs the theme
 * too. The `dark` class on the root element is the ground truth whoever set it
 * — the sidebar toggle, the stored choice, or the OS — so watch that rather
 * than re-deriving the preference and drifting out of sync with the toggle.
 */
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export function WorkflowCanvas() {
  const { name } = useParams<{ name: string }>();
  return name ? (
    <ReactFlowProvider>
      <CanvasEditor name={name} />
    </ReactFlowProvider>
  ) : (
    <CanvasPicker />
  );
}

/** Without a workflow in the path there is nothing to draw, so offer a list. */
function CanvasPicker() {
  const workflows = usePoll(['workflows'], listWorkflows, 10000);
  const rows = workflows.data?.workflows ?? [];

  return (
    <Page title="Canvas" subtitle="See a workflow as a graph and rewire how its steps depend on each other.">
      {workflows.isPending ? (
        <Skeleton className="h-40" />
      ) : workflows.isError ? (
        <QueryUnavailable
          title="Workflows are unavailable"
          description="Clementine couldn’t load your workflows, so this is not an empty list. Nothing has been deleted."
          onRetry={() => { void workflows.refetch(); }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description="Create one with Clementine first, then open it here to see its shape."
          action={
            <Link to="/automate/new">
              <Button>Create a workflow</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((w) => (
            <Link key={w.name} to={`/automate/${encodeURIComponent(w.name)}/canvas`}>
              <Card className="h-full p-4 transition-colors hover:bg-hover">
                <div className="text-body font-medium text-fg">{w.name}</div>
                {w.description ? (
                  <div className="mt-1 line-clamp-2 text-small text-muted">{w.description}</div>
                ) : null}
                <div className="mt-2 text-caption text-faint">
                  {w.stepCount ?? 0} {w.stepCount === 1 ? 'step' : 'steps'}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}

function CanvasEditor({ name }: { name: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isDark = useIsDarkTheme();

  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Steps added on the canvas and not yet saved — they need a prompt body. */
  const [createdIds, setCreatedIds] = useState<string[]>([]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  /** The graph as last returned by the daemon — the baseline "dirty" is measured against. */
  const baseline = useRef<CanvasGraph>(EMPTY_GRAPH);

  const applyGraph = useCallback(
    (graph: CanvasGraph) => {
      baseline.current = graph;
      const positions = resolvePositions(graph, loadPositions(name));
      setNodes(
        graph.nodes.map((node) => ({
          id: node.id,
          type: 'workflowStep' as const,
          position: positions[node.id] ?? { x: 0, y: 0 },
          data: { node },
        })),
      );
      setEdges(
        graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      );
      setCreatedIds([]);
    },
    [name, setEdges, setNodes],
  );

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getWorkflow(name)
      .then((wf) => {
        if (!alive) return;
        setDetail(wf);
        applyGraph(wf.graph ?? EMPTY_GRAPH);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load this workflow.');
      });
    return () => {
      alive = false;
    };
  }, [name, applyGraph]);

  // A plain "Saved." can fade; anything that says the workflow was turned off
  // or repaired has to stay until it is read.
  useEffect(() => {
    if (notice !== SAVED_PLAINLY) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* Placement is browser-local: the workflow file has nowhere to keep it. */
  const persistPositions = useCallback(
    (current: WorkflowCanvasFlowNode[]) => {
      const out: Record<string, CanvasPosition> = {};
      for (const n of current) out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      savePositions(name, out);
    },
    [name],
  );

  // Placement is written once a drag ends, never on every frame of it. The
  // write waits for the committed node state rather than happening inside the
  // updater, which React may run more than once per change.
  const dragEnded = useRef(false);

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowCanvasFlowNode>[]) => {
      if (changes.some((c) => c.type === 'position' && c.dragging === false)) dragEnded.current = true;
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  useEffect(() => {
    if (!dragEnded.current) return;
    dragEnded.current = false;
    persistPositions(nodes);
  }, [nodes, persistPositions]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) return; // a step cannot wait on itself
      setEdges((current) => addEdge({ ...connection, id: `${connection.source}->${connection.target}` }, current));
    },
    [setEdges],
  );

  // The id is minted here, not inside the setNodes updater: an updater can be
  // invoked more than once for a single call, and a second run would mint a
  // second id and record a step that was never added.
  const addStep = useCallback(() => {
    const id = newStepId(nodes.map((n) => n.id));
    const positions: Record<string, CanvasPosition> = {};
    for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y };
    const node: CanvasGraphNode = { id, label: 'New step', dependsOn: [], meta: { sideEffect: 'unknown' } };
    setNodes((current) => [
      ...current,
      { id, type: 'workflowStep' as const, position: nextFreePosition(positions), data: { node, isNew: true } },
    ]);
    setCreatedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }, [nodes, setNodes]);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setEdges((current) => current.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setCreatedIds((ids) => ids.filter((id) => id !== selectedId));
    setSelectedId(null);
  }, [selectedId, setEdges, setNodes]);

  const revert = useCallback(() => {
    applyGraph(baseline.current);
    setSelectedId(null);
    setSaveError(null);
  }, [applyGraph]);

  const graphNodes = useMemo(() => nodes.map((n) => n.data.node), [nodes]);
  const canvasEdges = useMemo(
    () => edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    [edges],
  );

  const cycle = useMemo(() => findCycle(graphNodes, canvasEdges), [graphNodes, canvasEdges]);
  const patch = useMemo(
    () => toStepPatch(graphNodes, canvasEdges, createdIds),
    [graphNodes, canvasEdges, createdIds],
  );
  const dirty = useMemo(() => graphDiffersFrom(baseline.current, patch), [patch]);

  const save = useCallback(async () => {
    if (cycle || !dirty || patch.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await patchWorkflow(name, { steps: patch });
      const fresh = await getWorkflow(name);
      setDetail(fresh);
      applyGraph(fresh.graph ?? EMPTY_GRAPH);
      // The list screens cache workflow rows; a step change moves stepCount.
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      // A 2xx is not always a plain save: rewiring a live workflow can turn it
      // off pending a verification test, and the daemon may have repaired the
      // definition. Saying only "Saved" would leave a workflow silently off.
      setNotice(saveOutcome(result));
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the graph.');
    } finally {
      setSaving(false);
    }
  }, [applyGraph, cycle, dirty, name, patch, queryClient]);

  if (loadError) {
    return (
      <Page title="Canvas">
        <QueryUnavailable
          title="This workflow is unavailable"
          description="Clementine couldn’t load it, so the canvas is not showing an empty graph. The workflow itself is unchanged."
          onRetry={() => { navigate(0); }}
        />
        <p className="mt-2 text-small text-muted">{loadError}</p>
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page title="Canvas">
        <Skeleton className="h-[60vh]" />
      </Page>
    );
  }

  const stepless = nodes.length === 0;

  return (
    <Page
      title={detail.name}
      subtitle={detail.description}
      actions={
        <>
          <Link to="/automate">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} aria-hidden />
              Automate
            </Button>
          </Link>
          <Button variant="secondary" size="sm" onClick={addStep}>
            <Plus size={16} aria-hidden />
            Add step
          </Button>
          <Button variant="secondary" size="sm" onClick={removeSelected} disabled={!selectedId}>
            <Trash2 size={16} aria-hidden />
            Remove
          </Button>
          <Button variant="ghost" size="sm" onClick={revert} disabled={!dirty || saving}>
            <RotateCcw size={16} aria-hidden />
            Revert
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || !!cycle || saving || stepless}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
            Save
          </Button>
        </>
      }
    >
      {cycle ? (
        <Banner tone="danger">
          <strong className="font-semibold">These steps depend on each other in a loop:</strong>{' '}
          <span className="font-mono">{cycle.join(' → ')}</span>. A loop never becomes ready to run, so saving is
          blocked until it is broken.
        </Banner>
      ) : null}

      {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
      {notice ? <Banner tone={notice === SAVED_PLAINLY ? 'success' : 'warning'}>{notice}</Banner> : null}

      {detail.enabled ? (
        <Banner tone="warning">
          This workflow is on. Changing how its steps run can send it back for a verification test before it fires
          again.
        </Banner>
      ) : null}

      <Card className={cn('overflow-hidden p-0', 'h-[62vh] min-h-[420px]')}>
        {stepless ? (
          <EmptyState
            title="No steps to draw"
            description="This workflow has no steps yet. Add one here, or build it out with Clementine."
            action={
              <Button variant="secondary" onClick={addStep}>
                <Plus size={16} aria-hidden />
                Add step
              </Button>
            }
          />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode={isDark ? 'dark' : 'light'}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </Card>

      <p className="mt-3 text-small text-muted">
        Drag from a step's right edge to another step's left edge to make it wait for that step. Select an edge and
        press Backspace to disconnect it. Placement is remembered in this browser only — the workflow file has no
        place to store it.
      </p>
    </Page>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'warning' | 'success'; children: React.ReactNode }) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger bg-danger-tint text-fg'
      : tone === 'warning'
        ? 'border-warning bg-warning-tint text-fg'
        : 'border-success bg-success-tint text-fg';
  return (
    <div className={cn('mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-small', toneClass)}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
