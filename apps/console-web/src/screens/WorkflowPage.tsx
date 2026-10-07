/**
 * One workflow, opened: what it does on top, its steps as a graph in the
 * middle, the step you clicked on the right, and everything operational
 * folded under Advanced.
 *
 * Nothing here is a second model of the workflow. The graph is the one the
 * daemon compiles from the steps (GET /api/console/workflows/:name → graph);
 * rewiring saves back through the same PATCH `stepEdits` the form screens
 * use, and the step panel reads the stored step and the dry-run trace. The
 * panel is read-only in this slice: changing a step still goes through
 * Clementine, and "Ask Clementine" opens that conversation with the step named.
 *
 * Placement is shared: the daemon keeps a sidecar beside the definition, so
 * the shape you arranged here is the shape the phone and the next machine
 * see. The browser copy remains the fallback for a workflow nobody has
 * arranged since the sidecar existed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  AlertTriangle, ArrowLeft, Bot, Check, ChevronRight, Clock, ExternalLink, FlaskConical, History, Loader2, Lock, MessageSquare,
  PenLine, Play, Plus, Puzzle, Repeat, RotateCcw, Save, ScrollText, Send, ShieldCheck, Trash2, Undo2, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, Tag, type Tone } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { ScheduleEditor } from '@/components/automate/ScheduleEditor';
import { WorkflowEnginePanel } from '@/components/automate/WorkflowDrawer';
import { WorkflowCanvasNode, type WorkflowCanvasFlowNode, type WorkflowCanvasNodeRun } from '@/components/automate/WorkflowCanvasNode';
import { useWorkflowChanges } from '@/lib/workflow-changes';
import { usePoll } from '@/lib/poll';
import { usePendingCommit, type PendingCommit } from '@/lib/pending-commit';
import { workflowRunFailure, workflowRunNotice, workflowRunTone } from '@/lib/workflow-run-receipt';
import { getSettings, type ModelRolesSnapshot } from '@/lib/settings';
import { detectedTimezone, humanizeCron } from '@/lib/cron';
import { cn } from '@/lib/cn';
import { certPrimaryAction, certificationTone, sentenceCaseLabel } from '@/lib/workflowCertification';
import {
  deleteWorkflow, editWorkflowStep, getWorkflow, getWorkflowRunOverlay, listWorkflowRuns, listWorkflowStepEdits, patchWorkflow,
  putWorkflowLayout, revertWorkflowStepEdit, runWorkflow, runWorkflowStep, setWorkflowEnabled,
  type WorkflowCertification, type WorkflowDetail, type WorkflowRunOverlay, type WorkflowRunOverlayStep, type WorkflowRunRecord,
  type WorkflowStep,
} from '@/lib/automate';
import { statusTone } from '@/lib/inbox';
import {
  formatDuration, latestRun, overlayByStep, runHeadline, runStepLabel, runStepTone, runStillGoing, runWhen,
} from '@/lib/workflow-run-view';
import {
  choosePositions,
  findCycle,
  graphDiffersFrom,
  loadPositions,
  newStepId,
  nextFreePosition,
  removedStepIds,
  resolvePositions,
  SAVED_PLAINLY,
  saveOutcome,
  savePositions,
  toStepPatch,
  writtenButTurnedOff,
  type CanvasGraph,
  type CanvasGraphNode,
  type CanvasPosition,
} from '@/lib/workflow-canvas';
import {
  askAboutStepPrompt, dependentsOf, describeStepRun, draftChanged, RUN_STILL_GOING, stepDraftFrom,
  stepPatchFromDraft, workflowShape, type StepDraft,
} from '@/lib/workflow-step-view';

const nodeTypes = { workflowStep: WorkflowCanvasNode };
const EMPTY_GRAPH: CanvasGraph = { nodes: [], edges: [] };

/** How long a drag has to be over before the shared placement is written. */
const LAYOUT_WRITE_DELAY_MS = 600;

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

export function WorkflowPage() {
  const { name } = useParams<{ name: string }>();
  if (!name) return null;
  return (
    <ReactFlowProvider>
      <WorkflowView key={name} name={name} />
    </ReactFlowProvider>
  );
}

function WorkflowView({ name }: { name: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isDark = useIsDarkTheme();
  const [searchParams] = useSearchParams();
  const graphCommit = usePendingCommit(name);
  const runCommit = usePendingCommit(name);
  useWorkflowChanges();

  const detailQuery = useQuery({
    queryKey: ['workflow', name],
    queryFn: () => getWorkflow(name),
  });
  const detail = detailQuery.data ?? null;

  /* ---------- the graph ---------- */
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The daemon changed this workflow while the graph here had unsaved edits. */
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const baseline = useRef<CanvasGraph>(EMPTY_GRAPH);
  /** The last detail the graph was drawn from, so a refetch is applied once. */
  const drawnFrom = useRef<WorkflowDetail | null>(null);
  // Redrawing the graph (after a save, an undo, or Clementine's own edit)
  // keeps the step that was open: a fresh node set otherwise reads as "nothing
  // selected" and the panel you were working in would vanish mid-thought.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const applyGraph = useCallback(
    (graph: CanvasGraph, shared?: Record<string, CanvasPosition> | null) => {
      baseline.current = graph;
      const positions = resolvePositions(graph, choosePositions(shared, loadPositions(name)));
      const keep = selectedRef.current;
      setNodes(
        graph.nodes.map((node) => ({
          id: node.id,
          type: 'workflowStep' as const,
          position: positions[node.id] ?? { x: 0, y: 0 },
          data: { node },
          selected: node.id === keep,
        })),
      );
      if (keep && !graph.nodes.some((node) => node.id === keep)) setSelectedId(null);
      setEdges(graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })));
      setCreatedIds([]);
      setChangedElsewhere(false);
    },
    [name, setEdges, setNodes],
  );

  const graphNodes = useMemo(() => nodes.map((n) => n.data.node), [nodes]);
  const canvasEdges = useMemo(() => edges.map((e) => ({ id: e.id, source: e.source, target: e.target })), [edges]);
  const cycle = useMemo(() => findCycle(graphNodes, canvasEdges), [graphNodes, canvasEdges]);
  const patch = useMemo(() => toStepPatch(graphNodes, canvasEdges, createdIds), [graphNodes, canvasEdges, createdIds]);
  const removedIds = useMemo(() => removedStepIds(baseline.current, graphNodes), [graphNodes]);
  const dirty = useMemo(() => graphDiffersFrom(baseline.current, patch), [patch]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Draw the graph from each new detail. A refetch while the graph has unsaved
  // edits must not throw them away, so it is announced instead and applied on
  // Reload (or after the next save, which reloads).
  useEffect(() => {
    if (!detail || drawnFrom.current === detail) return;
    const first = drawnFrom.current === null;
    drawnFrom.current = detail;
    if (first || !dirtyRef.current) applyGraph(detail.graph ?? EMPTY_GRAPH, detail.layout?.positions);
    else setChangedElsewhere(true);
  }, [detail, applyGraph]);

  useEffect(() => {
    if (notice !== SAVED_PLAINLY) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /* ---------- placement: browser copy at once, shared copy after the drag settles ---------- */
  const layoutTimer = useRef<number | null>(null);
  const persistPositions = useCallback(
    (current: WorkflowCanvasFlowNode[]) => {
      const out: Record<string, CanvasPosition> = {};
      for (const n of current) out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      savePositions(name, out);
      if (layoutTimer.current) window.clearTimeout(layoutTimer.current);
      layoutTimer.current = window.setTimeout(() => {
        // A refused write (legacy single-file workflow) costs nothing but the
        // shared copy; the browser copy above already holds the placement.
        void putWorkflowLayout(name, out).catch(() => undefined);
      }, LAYOUT_WRITE_DELAY_MS);
    },
    [name],
  );
  useEffect(() => () => { if (layoutTimer.current) window.clearTimeout(layoutTimer.current); }, []);

  const dragEnded = useRef(false);
  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowCanvasFlowNode>[]) => {
      if (graphCommit.pending) {
        onNodesChange(changes.filter((change) => change.type === 'select' || change.type === 'dimensions'));
        return;
      }
      if (changes.some((c) => c.type === 'position' && c.dragging === false)) dragEnded.current = true;
      onNodesChange(changes);
    },
    [graphCommit, onNodesChange],
  );
  useEffect(() => {
    if (!dragEnded.current) return;
    dragEnded.current = false;
    persistPositions(nodes);
  }, [nodes, persistPositions]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (graphCommit.pending) return;
      if (connection.source === connection.target) return;
      setEdges((current) => addEdge({ ...connection, id: `${connection.source}->${connection.target}` }, current));
    },
    [graphCommit, setEdges],
  );

  const addStep = useCallback(() => {
    if (graphCommit.pending) return;
    const id = newStepId(nodes.map((n) => n.id));
    const positions: Record<string, CanvasPosition> = {};
    for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y };
    const node: CanvasGraphNode = { id, label: 'New step', dependsOn: [], meta: { sideEffect: 'unknown' } };
    setNodes((current) => [
      ...current,
      { id, type: 'workflowStep' as const, position: nextFreePosition(positions), data: { node, isNew: true } },
    ]);
    setCreatedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }, [graphCommit, nodes, setNodes]);

  const removeSelected = useCallback(() => {
    if (graphCommit.pending) return;
    if (!selectedId) return;
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setEdges((current) => current.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setCreatedIds((ids) => ids.filter((id) => id !== selectedId));
    setSelectedId(null);
  }, [graphCommit, selectedId, setEdges, setNodes]);

  const revert = useCallback(() => {
    if (graphCommit.pending) return;
    applyGraph(baseline.current, detail?.layout?.positions);
    setSelectedId(null);
    setSaveError(null);
  }, [applyGraph, detail, graphCommit]);

  const reloadFromDaemon = useCallback(async (token?: symbol) => {
    const owned = token ?? graphCommit.begin();
    if (!owned || !graphCommit.owns(owned)) return null;
    if (!token) setSaving(true);
    try {
      const fresh = await queryClient.fetchQuery({ queryKey: ['workflow', name], queryFn: () => getWorkflow(name) });
      if (!graphCommit.owns(owned)) return null;
      setSaveError(null);
      drawnFrom.current = fresh;
      applyGraph(fresh.graph ?? EMPTY_GRAPH, fresh.layout?.positions);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      return fresh;
    } catch (err) {
      if (graphCommit.owns(owned)) {
        setSaveError(`Could not reload this workflow. Your draft is still here. Try Reload again.${err instanceof Error ? ` ${err.message}` : ''}`);
      }
      return null;
    } finally {
      if (!token && graphCommit.finish(owned)) setSaving(false);
    }
  }, [applyGraph, graphCommit, name, queryClient]);

  const saveGraph = useCallback(async () => {
    if (cycle || !dirty || patch.length === 0) return;
    const token = graphCommit.begin();
    if (!token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await patchWorkflow(name, {
        stepEdits: patch,
        ...(removedIds.length > 0 ? { removeStepIds: removedIds } : {}),
      });
      await reloadFromDaemon(token);
      if (graphCommit.owns(token)) setNotice(saveOutcome(result));
    } catch (err: unknown) {
      if (!graphCommit.owns(token)) return;
      const written = writtenButTurnedOff(err);
      if (written) {
        await reloadFromDaemon(token).catch(() => undefined);
        if (graphCommit.owns(token)) setNotice(written);
      } else {
        setSaveError(err instanceof Error ? err.message : 'Could not save the graph.');
      }
    } finally {
      if (graphCommit.finish(token)) setSaving(false);
    }
  }, [cycle, dirty, graphCommit, name, patch, reloadFromDaemon, removedIds]);

  /* ---------- workflow-level controls ---------- */
  const [busy, setBusy] = useState<'run' | 'enable' | 'delete' | null>(null);
  const [testing, setTesting] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [runNoticeTone, setRunNoticeTone] = useState<'info' | 'warning'>('info');
  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['workflow', name] });
    void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    void queryClient.invalidateQueries({ queryKey: ['workflows-home'] });
  }, [name, queryClient]);

  const run = async () => {
    const token = runCommit.begin();
    if (!token) return;
    setBusy('run'); setControlError(null); setRunNotice(null);
    try {
      const receipt = await runWorkflow(name);
      if (!runCommit.owns(token)) return;
      setRunNotice(workflowRunNotice(receipt));
      setRunNoticeTone(workflowRunTone(receipt));
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      invalidateAll();
    } catch (e) { if (runCommit.owns(token)) setControlError(workflowRunFailure(e)); }
    finally { if (runCommit.finish(token)) setBusy(null); }
  };

  // A queued creation test is followed to its settled result (passed → on,
  // needs review → the daemon's report) instead of leaving the switch off with
  // nothing saying why. Used by turning on and by a step save that changed
  // what a live workflow runs.
  const followCreationTest = useCallback(async () => {
    setTesting(true);
    try {
      let fresh = await getWorkflow(name);
      const deadline = Date.now() + 4 * 60_000;
      while (Date.now() < deadline && !fresh.enabled && fresh.creationTest?.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        fresh = await getWorkflow(name);
      }
    } finally {
      setTesting(false);
      invalidateAll();
    }
  }, [invalidateAll, name]);

  // Turning on IS the creation test.
  const setEnabled = async (enabled: boolean) => {
    setBusy('enable'); setControlError(null);
    try {
      const result = await setWorkflowEnabled(name, enabled);
      if (enabled && result.verificationQueued) await followCreationTest();
      invalidateAll();
    } catch (e) { setControlError((e as Error).message); setTesting(false); }
    finally { setBusy(null); }
  };

  // After a step save: the graph is redrawn from the daemon unless it holds
  // unsaved rewiring, in which case only the detail (and so the panel) refreshes.
  const afterStepChange = useCallback(async (token?: symbol) => {
    if (dirtyRef.current) invalidateAll();
    else await reloadFromDaemon(token);
  }, [invalidateAll, reloadFromDaemon]);

  const remove = async () => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setBusy('delete');
    try {
      await deleteWorkflow(name);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate('/automate');
    } catch (e) { setControlError((e as Error).message); setBusy(null); }
  };

  /* ---------- details: description, schedule, model pins ---------- */
  const [advancedOpen, setAdvancedOpen] = useState(() => searchParams.get('advanced') === '1');
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const openAdvanced = () => {
    setAdvancedOpen(true);
    window.setTimeout(() => advancedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const primary = certPrimaryAction(detail?.certification);
  const runPrimary = () => {
    if (!primary || primary.kind === 'run') return void run();
    if (primary.kind === 'enable') return void setEnabled(true);
    return openAdvanced();
  };

  /* ---------- selection ---------- */
  const selectedNode = selectedId ? graphNodes.find((n) => n.id === selectedId) ?? null : null;
  const selectedStep = selectedId ? detail?.steps?.find((s) => s.id === selectedId) : undefined;
  const selectedTrace = selectedId ? detail?.certification?.dryRun?.steps?.find((s) => s.stepId === selectedId) : undefined;
  const canvasGraph = useMemo<CanvasGraph>(() => ({ nodes: graphNodes, edges: canvasEdges }), [graphNodes, canvasEdges]);

  /* ---------- the Last run tab ---------- */
  const [view, setView] = useState<'steps' | 'run'>(() => (searchParams.get('run') ? 'run' : 'steps'));
  const [chosenRunId, setChosenRunId] = useState<string | null>(() => searchParams.get('run'));
  const runsQuery = useQuery({
    queryKey: ['workflow-runs', name],
    queryFn: () => listWorkflowRuns(name, 20),
    refetchInterval: (query) => (view !== 'run' ? false : (query.state.data?.runs ?? []).some((r) => runStillGoing(r)) ? 5000 : 30000),
  });
  const runs = runsQuery.data?.runs ?? [];
  const newest = latestRun(runs);
  const shownRun: WorkflowRunRecord | null = (chosenRunId ? runs.find((r) => r.id === chosenRunId) : null) ?? newest;
  const overlayQuery = useQuery({
    queryKey: ['workflow-run-overlay', name, shownRun?.id ?? null],
    queryFn: () => getWorkflowRunOverlay(name, shownRun!.id),
    enabled: view === 'run' && !!shownRun,
    refetchInterval: () => (runStillGoing(shownRun) ? 3000 : false),
  });
  const overlay: WorkflowRunOverlay | null = view === 'run' ? overlayQuery.data?.overlay ?? null : null;
  const overlaySteps = useMemo(() => overlayByStep(overlay), [overlay]);

  // Colour the nodes by what the run did. A map over the current nodes keeps
  // positions, selection and any unsaved rewiring exactly as they are.
  useEffect(() => {
    setNodes((current) => current.map((n) => {
      const step = view === 'run' ? overlaySteps.get(n.id) : undefined;
      const run: WorkflowCanvasNodeRun | undefined = step
        ? {
            label: runStepLabel(step.status),
            tone: runStepTone(step.status),
            ...(step.status === 'done' && step.durationMs !== undefined ? { detail: formatDuration(step.durationMs) }
              : step.error ? { detail: step.error } : {}),
          }
        : view === 'run' && overlay ? { label: 'Not started', tone: 'neutral' } : undefined;
      if (run === n.data.run || (run && n.data.run && run.label === n.data.run.label && run.detail === n.data.run.detail)) return n;
      const { run: _drop, ...rest } = n.data;
      return { ...n, data: run ? { ...rest, run } : rest };
    }));
  }, [view, overlay, overlaySteps, setNodes]);
  const selectedRunStep = selectedId && view === 'run' ? overlaySteps.get(selectedId) ?? null : null;

  if (detailQuery.isError) {
    return (
      <Page title={name}>
        <QueryUnavailable
          title="This workflow is unavailable"
          description="Clementine couldn’t load it, so this is not an empty workflow. The workflow itself is unchanged."
          onRetry={() => { void detailQuery.refetch(); }}
        />
        <p className="mt-2 text-small text-muted">{(detailQuery.error as Error)?.message}</p>
      </Page>
    );
  }
  if (!detail) {
    return (
      <Page title={name}>
        <Skeleton className="mb-4 h-20" />
        <Skeleton className="h-[60vh]" />
      </Page>
    );
  }

  const schedule = detail.trigger?.schedule;
  const stepless = nodes.length === 0;
  const enabled = detail.enabled === true;

  return (
    <Page
      title={detail.name}
      actions={
        <>
          <Link to="/automate">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} aria-hidden />
              Automate
            </Button>
          </Link>
          {primary && primary.kind !== 'run' ? (
            <Button size="sm" onClick={runPrimary} disabled={busy !== null} title={detail.certification?.summary}>
              {busy === 'enable' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : primary.kind === 'enable' ? <ShieldCheck size={16} aria-hidden /> : null}
              {primary.label}
            </Button>
          ) : null}
          <Button size="sm" variant={primary && primary.kind !== 'run' ? 'secondary' : 'primary'} onClick={() => void run()} disabled={busy !== null || stepless}>
            {busy === 'run' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Play size={16} aria-hidden />}
            Run now
          </Button>
        </>
      }
    >
      {/* What it does, and whether it is on */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <DescriptionEditor
          key={detail.description ?? ''}
          value={detail.description ?? ''}
          onSave={async (description) => { await patchWorkflow(name, { description }); invalidateAll(); }}
        />
        <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onChange={(v) => void setEnabled(v)} label={enabled ? 'Turn off' : 'Turn on'} disabled={busy !== null || testing} />
            <span className="text-small text-fg">
              {testing || detail.creationTest?.status === 'running'
                ? 'Testing before it goes live…'
                : enabled ? 'On' : 'Off'}
            </span>
          </div>
          <button type="button" onClick={openAdvanced} className="inline-flex items-center gap-1.5 text-small text-muted hover:text-fg cursor-pointer" title="Change when it runs">
            <Clock size={14} aria-hidden />
            {schedule ? humanizeCron(schedule, detail.trigger?.timezone) : 'Only when you start it'}
          </button>
        </div>
      </div>

      {detail.creationTest && detail.creationTest.status !== 'passed' && !testing ? (
        <Banner tone={detail.creationTest.status === 'running' ? 'info' : 'warning'}>
          {detail.creationTest.status === 'running'
            ? 'Creation test running: the read-only steps run against the real tools; it turns on by itself when they return data.'
            : `Creation test needs review: ${(detail.creationTest.body ?? '').split('\n').filter((line) => line.trim()).slice(0, 3).join(' · ')}`}
        </Banner>
      ) : null}
      {controlError ? <Banner tone="danger">{controlError}</Banner> : null}
      {runNotice ? <Banner tone={runNoticeTone}>{runNotice}</Banner> : null}
      {changedElsewhere ? (
        <Banner tone="warning">
          This workflow changed while you had unsaved edits here.{' '}
          <button type="button" className="underline underline-offset-2 cursor-pointer" onClick={() => void reloadFromDaemon()}>Reload</button>
          {' '}to see the new version (your unsaved rewiring is dropped), or save yours.
        </Banner>
      ) : null}
      {cycle ? (
        <Banner tone="danger">
          <strong className="font-semibold">These steps depend on each other in a loop:</strong>{' '}
          <span className="font-mono">{cycle.join(' → ')}</span>. A loop never becomes ready to run, so saving is blocked until it is broken.
        </Banner>
      ) : null}
      {removedIds.length > 0 ? (
        <Banner tone="warning">
          Saving deletes {removedIds.length === 1 ? 'this step' : `these ${removedIds.length} steps`}:{' '}
          <span className="font-mono">{removedIds.join(', ')}</span>. Revert brings {removedIds.length === 1 ? 'it' : 'them'} back.
        </Banner>
      ) : null}
      {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
      {notice ? <Banner tone={notice === SAVED_PLAINLY ? 'success' : 'warning'}>{notice}</Banner> : null}
      {enabled && dirty ? (
        <Banner tone="warning">
          This workflow is on. Saving a change to how its steps run pauses it for a quick test, then turns it back on.
        </Banner>
      ) : null}

      {/* The graph and the step panel */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="flex min-h-[460px] flex-col overflow-hidden p-0 h-[min(70vh,760px)]">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <div role="tablist" aria-label="Graph view" className="mr-auto inline-flex rounded-full bg-subtle p-0.5">
              <button
                type="button" role="tab" aria-selected={view === 'steps'}
                onClick={() => setView('steps')}
                className={cn('rounded-full px-3 py-1 text-small font-medium cursor-pointer', view === 'steps' ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg')}
              >
                Steps
              </button>
              <button
                type="button" role="tab" aria-selected={view === 'run'}
                onClick={() => setView('run')}
                className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-small font-medium cursor-pointer', view === 'run' ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg')}
              >
                <History size={14} aria-hidden />
                Last run{newest ? ` · ${runWhen(newest)}` : ''}
              </button>
            </div>
            {view === 'steps' ? (
              <>
                <Button variant="ghost" size="sm" onClick={addStep} disabled={saving}>
                  <Plus size={16} aria-hidden />
                  Add step
                </Button>
                <Button variant="ghost" size="sm" onClick={removeSelected} disabled={!selectedId || saving}>
                  <Trash2 size={16} aria-hidden />
                  Remove
                </Button>
                <Button variant="ghost" size="sm" onClick={revert} disabled={!dirty || saving}>
                  <RotateCcw size={16} aria-hidden />
                  Revert
                </Button>
                <Button size="sm" variant={dirty ? 'primary' : 'secondary'} onClick={() => void saveGraph()} disabled={!dirty || !!cycle || saving || stepless}>
                  {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
                  Save
                </Button>
              </>
            ) : runs.length > 0 ? (
              <>
                <select
                  aria-label="Which run"
                  className="max-w-[260px] rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
                  value={shownRun?.id ?? ''}
                  onChange={(e) => setChosenRunId(e.target.value || null)}
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>{runWhen(r)} · {statusTone(r.status).label}{r.targetStepId ? ` · only ${r.targetStepId}` : ''}</option>
                  ))}
                </select>
                {shownRun ? (
                  <Link to={`/automate?workflow=${encodeURIComponent(detail.name)}&run=${encodeURIComponent(shownRun.id)}`} className="inline-flex items-center gap-1 text-small text-muted underline-offset-2 hover:text-fg hover:underline">
                    Open run <ExternalLink size={12} aria-hidden />
                  </Link>
                ) : null}
              </>
            ) : (
              <span className="text-small text-muted">No runs yet</span>
            )}
          </div>
          {stepless ? (
            <EmptyState
              title="No steps to draw"
              description="This workflow has no steps yet. Add one here, or build it out with Clementine."
              action={
                <Button variant="secondary" onClick={addStep} disabled={saving}>
                  <Plus size={16} aria-hidden />
                  Add step
                </Button>
              }
            />
          ) : (
            <div className="min-h-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={(changes) => onEdgesChange(graphCommit.pending ? changes.filter((change) => change.type === 'select') : changes)}
                onConnect={onConnect}
                onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
                nodesConnectable={view === 'steps' && !saving}
                nodesDraggable={!saving}
                deleteKeyCode={view === 'steps' && !saving ? ['Backspace', 'Delete'] : null}
                colorMode={isDark ? 'dark' : 'light'}
                fitView
              >
                <Background />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
          )}
          <p className="border-t border-border px-3 py-1.5 text-caption text-faint">
            {view === 'run'
              ? (overlay ? runHeadline(overlay, shownRun) : shownRun ? 'Loading the run…' : 'Run the workflow once and its steps show here, coloured by what happened.')
              : 'Drag between steps to change what waits on what. Click a step to open it. Placement is saved with the workflow.'}
          </p>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden p-0 lg:h-[min(70vh,760px)]">
          {view === 'run' ? (
            selectedNode ? (
              <RunStepPanel
                node={selectedNode}
                step={selectedRunStep}
                run={shownRun}
                loaded={!!overlay}
                onEdit={() => setView('steps')}
              />
            ) : (
              <RunSummaryPanel overlay={overlay} run={shownRun} workflowName={detail.name} loading={overlayQuery.isPending && !!shownRun} />
            )
          ) : selectedNode ? (
            <StepPanel
              key={selectedNode.id}
              workflowName={detail.name}
              node={selectedNode}
              step={selectedStep}
              trace={selectedTrace}
              graph={canvasGraph}
              isNew={createdIds.includes(selectedNode.id)}
              workflowOn={enabled}
              graphCommit={graphCommit}
              graphSaving={saving}
              onGraphPending={setSaving}
              onChanged={afterStepChange}
              onTestQueued={followCreationTest}
            />
          ) : (
            <ShapePanel graph={canvasGraph} certification={detail.certification} />
          )}
        </Card>
      </div>

      {/* Advanced */}
      <details
        ref={advancedRef}
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="mt-5 rounded-md border border-border bg-subtle"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-small font-medium text-fg [&::-webkit-details-marker]:hidden">
          <ChevronRight size={16} className={cn('transition-transform', advancedOpen && 'rotate-90')} aria-hidden />
          Advanced
          <span className="font-normal text-muted">schedule, models, readiness, delete</span>
        </summary>
        <div className="border-t border-border px-4 py-4">
          <DetailsForm detail={detail} onSaved={invalidateAll} />
          <div id="wf-engine-panel">
            <WorkflowEnginePanel certification={detail.certification} stepCount={detail.steps?.length ?? 0} resources={detail.resources} resourceBinding={detail.resourceBinding} />
          </div>
          <div className="mt-5 flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-surface px-3 py-2">
            <span className="text-small text-muted">Delete this workflow and its run history.</span>
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => void remove()} disabled={busy !== null}>
              {busy === 'delete' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
              Delete
            </Button>
          </div>
        </div>
      </details>
    </Page>
  );
}

/* ---------- the description: read as text, edited in place ---------- */

function DescriptionEditor({ value, onSave }: { value: string; onSave: (next: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = async () => {
    if (draft.trim() === value.trim()) { setEditing(false); return; }
    setSaving(true); setError(null);
    try { await onSave(draft.trim()); setEditing(false); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Change what this workflow does"
        className="reading max-w-3xl min-w-0 text-left text-body-lg text-muted hover:text-fg cursor-pointer"
      >
        {value || <span className="italic">No description yet. Click to write one.</span>}
        <PenLine size={14} className="ml-1.5 inline-block align-[-2px] opacity-60" aria-hidden />
      </button>
    );
  }
  return (
    <div className="min-w-0 flex-1 max-w-3xl">
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What does this workflow do, in a sentence or two?" autoFocus rows={3} />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={() => void commit()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft(value); setEditing(false); }} disabled={saving}>Cancel</Button>
        {error ? <span className="text-small text-danger">{error}</span> : null}
      </div>
    </div>
  );
}

/* ---------- the step panel (read-only in this slice) ---------- */

type DryRunTraceStep = NonNullable<NonNullable<WorkflowCertification['dryRun']>['steps']>[number];

const RUN_ICON: Record<ReturnType<typeof describeStepRun>['kind'], LucideIcon> = {
  model: Bot, skill: Puzzle, script: ScrollText, call: Zap,
};

function StepPanel({ workflowName, node, step, trace, graph, isNew, workflowOn, graphCommit, graphSaving, onGraphPending, onChanged, onTestQueued }: {
  workflowName: string;
  node: CanvasGraphNode;
  step?: WorkflowStep;
  trace?: DryRunTraceStep;
  graph: CanvasGraph;
  isNew: boolean;
  /** The workflow is on, so a change to what runs pauses it for a test. */
  workflowOn: boolean;
  graphCommit: PendingCommit;
  graphSaving: boolean;
  onGraphPending: (pending: boolean) => void;
  /** The step was saved or undone; the page refreshes what it shows. */
  onChanged: (token?: symbol) => Promise<void>;
  /** A save turned the workflow off and queued its test; the page follows it. */
  onTestQueued: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const stepCommit = usePendingCommit(`${workflowName}:${node.id}`);
  const beginMutation = () => {
    const graphToken = graphCommit.begin();
    if (!graphToken) return null;
    const stepToken = stepCommit.begin();
    if (!stepToken) { graphCommit.finish(graphToken); return null; }
    onGraphPending(true);
    return { graph: graphToken, step: stepToken };
  };
  const ownsMutation = (token: { graph: symbol; step: symbol }) => graphCommit.owns(token.graph) && stepCommit.owns(token.step);
  const finishMutation = (token: { graph: symbol; step: symbol }) => {
    if (graphCommit.finish(token.graph)) onGraphPending(false);
    return stepCommit.finish(token.step);
  };
  const runAs = describeStepRun(node, step);
  const RunIcon = RUN_ICON[runAs.kind];
  const waitsFor = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const then = dependentsOf(graph, node.id);
  const tools = node.meta?.tools ?? step?.allowedTools ?? [];
  const produces = trace?.emits ?? node.meta?.outputType ?? step?.output?.type ?? null;
  const reads = trace?.reads ?? [];
  const effect = node.meta?.sideEffect;
  const verdict = node.verdict;
  const askHref = `/chat?prompt=${encodeURIComponent(askAboutStepPrompt(workflowName, node.id))}`;

  /* ---- the everyday four, as a draft against the stored step ---- */
  const base = useMemo(() => stepDraftFrom(node, step), [node, step]);
  const [draft, setDraft] = useState<StepDraft>(base);
  const [baseSeen, setBaseSeen] = useState(base);
  // A fresh stored step (after a save, undo, or Clementine's own edit) resets a
  // draft that has no unsaved changes; unsaved typing is kept.
  useEffect(() => {
    if (base === baseSeen) return;
    setBaseSeen(base);
    setDraft((current) => (draftChanged(baseSeen, current) ? current : base));
  }, [base, baseSeen]);
  const changed = draftChanged(base, draft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const save = async () => {
    const patch = stepPatchFromDraft(base, draft);
    if (Object.keys(patch).length === 0) return;
    const token = beginMutation();
    if (!token) return;
    setSaving(true); setSaveError(null); setSaveNote(null);
    try {
      const result = await editWorkflowStep(workflowName, node.id, patch);
      if (!graphCommit.owns(token.graph)) return;
      void queryClient.invalidateQueries({ queryKey: ['workflow-step-edits', workflowName] });
      await onChanged(token.graph);
      if (!ownsMutation(token)) return;
      if (result.verification.turnedOff) {
        if (result.verification.runId) {
          setSaveNote('Saved. The workflow is paused while its quick test runs; it turns back on when the test passes.');
          void onTestQueued();
        } else {
          setSaveNote(result.verification.message ?? 'Saved, and the workflow is now off until its test can run.');
        }
      } else {
        setSaveNote('Saved.');
      }
    } catch (e) {
      if (!ownsMutation(token)) return;
      const body = (e as { body?: { error?: string; errors?: string[] } }).body;
      setSaveError(body?.error ? [body.error, ...(body.errors ?? [])].join(' ') : (e as Error).message);
    } finally {
      if (finishMutation(token)) setSaving(false);
    }
  };
  useEffect(() => {
    if (saveNote !== 'Saved.') return;
    const t = window.setTimeout(() => setSaveNote(null), 3000);
    return () => window.clearTimeout(t);
  }, [saveNote]);

  /* ---- undo: the newest reversible edit of this step ---- */
  const editsQuery = useQuery({
    queryKey: ['workflow-step-edits', workflowName],
    queryFn: () => listWorkflowStepEdits(workflowName),
    staleTime: 10_000,
  });
  const lastEdit = editsQuery.data?.edits.find((edit) => edit.stepId === node.id) ?? null;
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    if (!lastEdit) return;
    const token = beginMutation();
    if (!token) return;
    setUndoing(true); setSaveError(null);
    try {
      const result = await revertWorkflowStepEdit(workflowName, lastEdit.id);
      if (!graphCommit.owns(token.graph)) return;
      void queryClient.invalidateQueries({ queryKey: ['workflow-step-edits', workflowName] });
      await onChanged(token.graph);
      if (ownsMutation(token)) setSaveNote(result.message);
    } catch (e) { if (ownsMutation(token)) setSaveError((e as Error).message); }
    finally { if (finishMutation(token)) setUndoing(false); }
  };

  /* ---- test this step: one run of just this step, followed here ---- */
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const runsQuery = useQuery({
    queryKey: ['workflow-runs-follow', workflowName, testRunId],
    queryFn: () => listWorkflowRuns(workflowName, 30),
    enabled: testRunId !== null,
    refetchInterval: (query) => {
      const run = query.state.data?.runs.find((r) => r.id === testRunId);
      return !run || RUN_STILL_GOING.has(String(run.status ?? 'queued')) ? 3000 : false;
    },
  });
  const testRun = testRunId ? runsQuery.data?.runs.find((r) => r.id === testRunId) ?? null : null;
  const testTone = statusTone(testRun?.status ?? (testRunId ? 'queued' : undefined));
  const testThisStep = async () => {
    const token = beginMutation();
    if (!token) return;
    setStarting(true); setTestNote(null); setTestRunId(null);
    try {
      const result = await runWorkflowStep(workflowName, node.id);
      if (!ownsMutation(token)) return;
      if (result.id) setTestRunId(result.id);
      else setTestNote(result.message ?? 'The test could not start.');
    } catch (e) {
      if (!ownsMutation(token)) return;
      const body = (e as { body?: { error?: string; message?: string } }).body;
      setTestNote(body?.message ?? body?.error ?? (e as Error).message);
    } finally {
      if (finishMutation(token)) setStarting(false);
    }
  };
  const openRunHref = testRunId ? `/automate?workflow=${encodeURIComponent(workflowName)}&run=${encodeURIComponent(testRunId)}` : null;

  const perItemOptions = useMemo(() => {
    const ids = [...waitsFor];
    if (draft.perItem && !ids.includes(draft.perItem)) ids.push(draft.perItem);
    return ids;
  }, [waitsFor, draft.perItem]);

  return (
    <>
      <div className="border-b border-border px-4 py-3">
        <div className="font-mono text-caption text-faint">{node.id}</div>
        <div className="text-body font-medium text-fg">{step?.name || node.label || node.id}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusPill tone={runAs.kind === 'model' ? 'info' : 'success'} icon={RunIcon}>{runAs.label}</StatusPill>
          {effect === 'send' ? <StatusPill tone="warning" icon={Send}>Sends externally</StatusPill> : null}
          {effect === 'write' ? <StatusPill tone="info" icon={PenLine}>Writes</StatusPill> : null}
          {isNew ? <StatusPill tone="live">Not saved yet</StatusPill> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {isNew ? (
          <p className="text-small text-muted">A new step has no instructions yet. Save the graph first, then write what this step should do here.</p>
        ) : (
          <fieldset disabled={graphSaving} aria-busy={graphSaving} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <section>
              <label className="mb-1 block text-label text-fg" htmlFor={`step-prompt-${node.id}`}>What this step does</label>
              <Textarea
                id={`step-prompt-${node.id}`}
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                rows={Math.min(14, Math.max(4, draft.prompt.split('\n').length + 1))}
                placeholder="Say what this step should do, in your own words."
                className="text-small leading-relaxed"
              />
            </section>

            <section className="space-y-2.5">
              <EditRow icon={Lock} label="Asks me first" hint={node.meta?.approvalPreview ?? 'The run pauses here until you approve.'}>
                <Switch checked={draft.asksFirst} onChange={(v) => setDraft({ ...draft, asksFirst: v })} label="Asks me first" />
              </EditRow>
              <EditRow icon={ShieldCheck} label="Keeps going if this fails" hint="A failure here leaves a gap; the rest of the run continues.">
                <Switch checked={draft.keepGoing} onChange={(v) => setDraft({ ...draft, keepGoing: v })} label="Keeps going if this fails" />
              </EditRow>
              <EditRow
                icon={Repeat}
                label="Runs once per item"
                hint={waitsFor.length === 0 ? 'Needs a step to wait for: its items are what this step runs over.' : 'Runs once for each item the chosen step produced.'}
              >
                <Switch
                  checked={draft.perItem !== ''}
                  disabled={waitsFor.length === 0 && draft.perItem === ''}
                  onChange={(v) => setDraft({ ...draft, perItem: v ? (perItemOptions[0] ?? '') : '' })}
                  label="Runs once per item"
                />
              </EditRow>
              {draft.perItem !== '' ? (
                <div className="pl-6">
                  <label className="mb-1 block text-caption text-muted" htmlFor={`step-per-item-${node.id}`}>Items from</label>
                  <select
                    id={`step-per-item-${node.id}`}
                    className="w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-small text-fg"
                    value={draft.perItem}
                    onChange={(e) => setDraft({ ...draft, perItem: e.target.value })}
                  >
                    {perItemOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </div>
              ) : null}
            </section>

            {changed && workflowOn ? (
              <p className="rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-caption text-fg">
                This workflow is on. Saving pauses it for a quick test of the new step, then turns it back on.
              </p>
            ) : null}
            {saveError ? <p className="text-small text-danger">{saveError}</p> : null}
            {saveNote ? <p className="text-small text-success">{saveNote}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={!changed || saving || undoing || graphSaving}>
                {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
                Save step
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { if (!graphCommit.pending) setDraft(base); }} disabled={!changed || saving || graphSaving}>Discard</Button>
              {lastEdit ? (
                <Button size="sm" variant="ghost" onClick={() => void undo()} disabled={undoing || saving || graphSaving} title={`${lastEdit.description} · ${new Date(lastEdit.createdAt).toLocaleString()}`}>
                  {undoing ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Undo2 size={16} aria-hidden />}
                  Undo last change
                </Button>
              ) : null}
            </div>

            <section className="rounded-md border border-border bg-subtle px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-small font-medium text-fg">Try just this step</div>
                <Button size="sm" variant="secondary" onClick={() => void testThisStep()} disabled={starting || changed || graphSaving} title={changed ? 'Save the step first' : 'Runs this step alone, with no upstream chain'}>
                  {starting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <FlaskConical size={16} aria-hidden />}
                  Test this step
                </Button>
              </div>
              {testRunId ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-small">
                  <StatusPill tone={testTone.tone}>{testTone.label}</StatusPill>
                  {testRun?.error ? <span className="text-danger">{testRun.error}</span> : null}
                  {openRunHref ? (
                    <Link to={openRunHref} className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-fg hover:underline">
                      Open run <ExternalLink size={12} aria-hidden />
                    </Link>
                  ) : null}
                </div>
              ) : null}
              {testNote ? <p className="mt-2 text-small text-muted">{testNote}</p> : null}
              <p className="mt-1 text-caption text-faint">Runs the saved step by itself, using the real tools. Nothing upstream runs.</p>
            </section>
          </fieldset>
        )}

        <section>
          <div className="mb-1 text-label text-fg">Waits for</div>
          {waitsFor.length > 0 ? <ChipList items={waitsFor} /> : <p className="text-small text-muted">Nothing. It runs first.</p>}
        </section>
        {then.length > 0 ? (
          <section>
            <div className="mb-1 text-label text-fg">Then</div>
            <ChipList items={then} />
          </section>
        ) : null}

        {tools.length > 0 ? (
          <section>
            <div className="mb-1 flex items-center gap-1.5 text-label text-fg"><Wrench size={13} aria-hidden /> Tools it may use</div>
            <ChipList items={tools} />
          </section>
        ) : null}
        {(reads.length > 0 || produces) ? (
          <section>
            <div className="mb-1 text-label text-fg">Data</div>
            <p className="text-small text-muted">
              {reads.length > 0 ? `Reads ${reads.join(', ')}` : ''}
              {reads.length > 0 && produces ? ' · ' : ''}
              {produces ? `Produces ${produces}` : ''}
            </p>
          </section>
        ) : null}

        {verdict && verdict.status && verdict.status !== 'trusted' ? (
          <section className={cn('rounded-md border px-3 py-2', verdict.status === 'blocked' ? 'border-danger/30 bg-danger-tint' : 'border-warning/30 bg-warning-tint')}>
            <div className="text-small font-semibold text-fg">{verdict.label}</div>
            {node.verdict && 'reasons' in node.verdict && Array.isArray((node.verdict as { reasons?: unknown }).reasons) ? (
              <ul className="mt-1 space-y-0.5 text-caption text-muted">
                {((node.verdict as { reasons: string[] }).reasons).slice(0, 4).map((r) => <li key={r}>{r}</li>)}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>

      <div className="border-t border-border px-4 py-3">
        <Link to={askHref}>
          <Button variant="secondary" size="sm" className="w-full">
            <MessageSquare size={16} aria-hidden />
            Ask Clementine about this step
          </Button>
        </Link>
        <p className="mt-2 text-caption text-faint">Tools, model and output shape change through Clementine or Advanced.</p>
      </div>
    </>
  );
}

/* ---------- the Last run tab's right-hand panels ---------- */

function RunStepPanel({ node, step, run, loaded, onEdit }: {
  node: CanvasGraphNode;
  step: WorkflowRunOverlayStep | null;
  run: WorkflowRunRecord | null;
  loaded: boolean;
  onEdit: () => void;
}) {
  const tone = step ? runStepTone(step.status) : 'neutral';
  const waiting = step && (step.status === 'awaiting_approval' || step.status === 'awaiting_input' || step.status === 'awaiting_capability');
  return (
    <>
      <div className="border-b border-border px-4 py-3">
        <div className="font-mono text-caption text-faint">{node.id}</div>
        <div className="text-body font-medium text-fg">{node.label || node.id}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step ? <StatusPill tone={tone}>{runStepLabel(step.status)}</StatusPill> : loaded ? <StatusPill tone="neutral">Not started</StatusPill> : null}
          {step?.durationMs !== undefined && step.status === 'done' ? <Tag>{formatDuration(step.durationMs)}</Tag> : null}
          {step && step.retries > 0 ? <Tag>{step.retries} retr{step.retries === 1 ? 'y' : 'ies'}</Tag> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {!step ? (
          <p className="text-small text-muted">{loaded ? (run ? 'This step did not run in this run.' : 'No run to show yet.') : 'Loading…'}</p>
        ) : (
          <>
            {step.error ? (
              <section className={cn('rounded-md border px-3 py-2 text-small', waiting ? 'border-warning/30 bg-warning-tint text-fg' : step.status === 'failed' || step.status === 'blocked' ? 'border-danger/30 bg-danger-tint text-fg' : 'border-border bg-subtle text-fg')}>
                <div className="mb-0.5 text-caption font-semibold text-muted">{waiting ? 'Waiting' : step.status === 'blocked' ? 'Why it was blocked' : step.status === 'redoing' ? 'Why it runs again' : 'What went wrong'}</div>
                <p className="whitespace-pre-wrap">{step.error}</p>
              </section>
            ) : null}
            {step.runVerdict?.primaryAction && (waiting || step.status === 'failed' || step.status === 'blocked') ? (
              <p className="text-small text-muted">Next: {step.runVerdict.primaryAction}.</p>
            ) : null}
            {step.outputPreview ? (
              <section>
                <div className="mb-1 text-label text-fg">What it produced</div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-canvas px-3 py-2 text-caption text-fg">{step.outputPreview}</pre>
              </section>
            ) : null}
            <section className="grid grid-cols-2 gap-2 text-small">
              <Fact label="Started" value={step.startedAt ? new Date(step.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'} />
              <Fact label="Finished" value={step.finishedAt && step.status !== 'running' ? new Date(step.finishedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'} />
              <Fact label="Tool calls" value={String(step.toolCalls)} />
              <Fact label="Attempts" value={String(Math.max(1, step.attempts))} />
              {step.itemsStarted > 0 ? <Fact label="Items" value={`${step.itemsCompleted}/${step.itemsStarted}${step.itemsFailed ? ` · ${step.itemsFailed} failed` : ''}`} /> : null}
              {step.approvalsRequested > 0 ? <Fact label="Approvals" value={`${step.approvalsResolved}/${step.approvalsRequested} answered`} /> : null}
              {step.externalWrites > 0 ? <Fact label="Outside writes" value={String(step.externalWrites)} /> : null}
            </section>
            {step.tools.length > 0 ? (
              <section>
                <div className="mb-1 flex items-center gap-1.5 text-label text-fg"><Wrench size={13} aria-hidden /> Tools it used</div>
                <ChipList items={step.tools} />
              </section>
            ) : null}
            {step.models.length > 0 ? (
              <section>
                <div className="mb-1 text-label text-fg">Models</div>
                <ChipList items={step.models} />
              </section>
            ) : null}
            {step.attentionReasons.length > 0 ? (
              <section>
                <div className="mb-1 text-label text-fg">Worth knowing</div>
                <ul className="space-y-0.5 text-caption text-muted">
                  {step.attentionReasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
      <div className="border-t border-border px-4 py-3">
        <Button variant="secondary" size="sm" className="w-full" onClick={onEdit}>
          <PenLine size={16} aria-hidden />
          Edit this step
        </Button>
      </div>
    </>
  );
}

function RunSummaryPanel({ overlay, run, workflowName, loading }: {
  overlay: WorkflowRunOverlay | null;
  run: WorkflowRunRecord | null;
  workflowName: string;
  loading: boolean;
}) {
  const bottleneck = overlay?.summary.bottleneckStepId;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-body font-medium text-fg">{run ? runWhen(run) : 'Last run'}</div>
        {run ? <div className="mt-2"><StatusPill tone={statusTone(run.status).tone}>{statusTone(run.status).label}</StatusPill></div> : null}
      </div>
      <div className="space-y-3 px-4 py-3 text-small text-muted">
        {!run ? (
          <p>This workflow has not run yet. Run now, or test one step from the Steps view.</p>
        ) : loading ? (
          <p>Loading the run…</p>
        ) : overlay ? (
          <>
            <p className="text-fg">{runHeadline(overlay, run)}</p>
            {bottleneck && overlay.summary.bottleneck ? <p>Held up at <span className="font-mono text-fg">{bottleneck}</span>: {overlay.summary.bottleneck}.</p> : null}
            {overlay.goal && overlay.goal.status !== 'unknown' ? <p>Goal: {overlay.goal.status.replace(/_/g, ' ')}.</p> : null}
            {run.error ? <p className="text-danger">{run.error}</p> : null}
            <p className="text-faint">Click a step to see what it did, how long it took, and what it produced.</p>
            <Link to={`/automate?workflow=${encodeURIComponent(workflowName)}&run=${encodeURIComponent(run.id)}`} className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline">
              Open the full run <ExternalLink size={12} aria-hidden />
            </Link>
          </>
        ) : (
          <p>The run's details are unavailable right now.</p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-subtle px-2.5 py-1.5">
      <div className="text-caption text-faint">{label}</div>
      <div className="text-small text-fg">{value}</div>
    </div>
  );
}

function EditRow({ icon: Icon, label, hint, children }: { icon: LucideIcon; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="inline-flex min-w-0 items-start gap-1.5 text-small text-fg">
        <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          {label}
          {hint ? <span className="block text-caption text-faint">{hint}</span> : null}
        </span>
      </span>
      <span className="shrink-0 pt-0.5">{children}</span>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => <Tag key={item} className="font-mono">{item}</Tag>)}
    </div>
  );
}

/* ---------- before a step is picked: the shape of the whole thing ---------- */

function ShapePanel({ graph, certification }: { graph: CanvasGraph; certification?: WorkflowCertification }) {
  const shape = workflowShape(graph);
  const tone: Tone = certification ? certificationTone(certification.state) : 'neutral';
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-body font-medium text-fg">This workflow</div>
        {certification ? (
          <div className="mt-2"><StatusPill tone={tone}>{sentenceCaseLabel(certification.label)}</StatusPill></div>
        ) : null}
      </div>
      <div className="space-y-3 px-4 py-3 text-small text-muted">
        <p>
          {shape.steps} step{shape.steps === 1 ? '' : 's'}
          {shape.reads > 0 ? ` · ${shape.reads} read${shape.reads === 1 ? '' : 's'}` : ''}
          {shape.writes > 0 ? ` · ${shape.writes} write${shape.writes === 1 ? '' : 's'}` : ''}
          {shape.sends > 0 ? ` · ${shape.sends} send${shape.sends === 1 ? '' : 's'}` : ''}
          {shape.approvals > 0 ? ` · asks you first ${shape.approvals === 1 ? 'once' : `${shape.approvals} times`}` : ''}
        </p>
        {certification?.summary ? <p>{certification.summary}</p> : null}
        <p className="text-faint">Click a step to see what it does, what it waits for, and what it touches.</p>
      </div>
    </div>
  );
}

/* ---------- Advanced: schedule and model pins, saved together ---------- */

function DetailsForm({ detail, onSaved }: { detail: WorkflowDetail; onSaved: () => void }) {
  const [cron, setCron] = useState(detail.trigger?.schedule ?? '');
  const [tz, setTz] = useState(detail.trigger?.timezone || (detail.trigger?.schedule ? detectedTimezone() : ''));
  const [pinBrain, setPinBrain] = useState(detail.models?.brain ?? '');
  const [pinWorker, setPinWorker] = useState(detail.models?.worker ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = usePoll(['settings'], getSettings, 0);
  const dirty = cron !== (detail.trigger?.schedule ?? '')
    || (cron.trim() !== '' && tz !== (detail.trigger?.timezone || (detail.trigger?.schedule ? detectedTimezone() : '')))
    || pinBrain !== (detail.models?.brain ?? '')
    || pinWorker !== (detail.models?.worker ?? '');

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await patchWorkflow(detail.name, {
        models: { brain: pinBrain.trim(), worker: pinWorker.trim() },
        ...(cron.trim() ? { triggerSchedule: cron.trim(), ...(tz ? { timezone: tz } : {}) } : { clearTriggerSchedule: true }),
      });
      setSaved(true); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const available = (settings.data?.modelRoles?.available ?? []) as NonNullable<ModelRolesSnapshot['available']>;
  const workerOptions = (settings.data?.modelRoles?.roleOptions?.worker ?? settings.data?.modelRoles?.available ?? []) as NonNullable<ModelRolesSnapshot['available']>;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section>
        <div className="mb-1.5 text-label text-fg">When it runs</div>
        <ScheduleEditor value={cron} onChange={(c) => { setCron(c); setSaved(false); }} timezone={tz} onTimezoneChange={(z) => { setTz(z); setSaved(false); }} />
      </section>
      <section>
        <div className="mb-1.5 text-label text-fg">Models for this workflow</div>
        <p className="mb-2 text-small text-muted">Blank follows your global Models &amp; routing. The judge always follows the global judge setting.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-small text-muted" htmlFor="wf-pin-brain">Steps (brain)</label>
            <select id="wf-pin-brain" className="w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-body text-fg" value={pinBrain} onChange={(e) => { setPinBrain(e.target.value); setSaved(false); }}>
              <option value="">Default (global routing)</option>
              {available.map((g) => (
                <optgroup key={`${g.provider}:${g.label}`} label={g.label}>
                  {g.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-small text-muted" htmlFor="wf-pin-worker">Workers (fan-outs)</label>
            <select id="wf-pin-worker" className="w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-body text-fg" value={pinWorker} onChange={(e) => { setPinWorker(e.target.value); setSaved(false); }}>
              <option value="">Default (global routing)</option>
              {workerOptions.map((g) => (
                <optgroup key={`${g.provider}:${g.label}`} label={g.label}>
                  {g.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      </section>
      <div className="flex items-center gap-2 lg:col-span-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save details'}</Button>
        {saved ? <span className="inline-flex items-center gap-1 text-small text-success"><Check size={14} aria-hidden /> Saved</span> : null}
        {error ? <span className="text-small text-danger">{error}</span> : null}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'warning' | 'success' | 'info'; children: React.ReactNode }) {
  const toneClass = tone === 'danger'
    ? 'border-danger bg-danger-tint text-fg'
    : tone === 'warning'
      ? 'border-warning bg-warning-tint text-fg'
      : tone === 'info'
        ? 'border-info bg-info-tint text-fg'
        : 'border-success bg-success-tint text-fg';
  return (
    <div className={cn('mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-small', toneClass)}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
