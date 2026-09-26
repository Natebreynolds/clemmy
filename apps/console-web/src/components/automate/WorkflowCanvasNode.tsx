/**
 * One step, drawn as a canvas node.
 *
 * Everything shown here comes from the graph the daemon derived from the
 * workflow's own steps, so the badges describe what the engine will actually
 * do — a send really is a send, an approval gate really is one. The node is
 * presentational: it never edits, so it cannot disagree with the stored step.
 */
import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Boxes, CircleDot, Repeat, ShieldCheck, Terminal, Wrench } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { CanvasGraphNode, CanvasSideEffect } from '@/lib/workflow-canvas';

/** What the step did in the run the page is showing, when it shows one. */
export type WorkflowCanvasNodeRun = {
  label: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'live';
  /** A short line for the node: how long, or what went wrong. */
  detail?: string;
};

export type WorkflowCanvasNodeData = {
  node: CanvasGraphNode;
  /** A step the canvas added that has not been saved to the daemon yet. */
  isNew?: boolean;
  /** Set while the Last run tab is open: the node is coloured by what happened. */
  run?: WorkflowCanvasNodeRun;
  [key: string]: unknown;
};

export type WorkflowCanvasFlowNode = Node<WorkflowCanvasNodeData, 'workflowStep'>;

/** Read/write/send is the effect class the engine gates on, so it leads. */
const EFFECT_STYLE: Record<CanvasSideEffect, { label: string; className: string }> = {
  read: { label: 'reads', className: 'bg-info-tint text-info' },
  write: { label: 'writes', className: 'bg-warning-tint text-warning' },
  send: { label: 'sends', className: 'bg-danger-tint text-danger' },
  unknown: { label: 'effect unknown', className: 'bg-subtle text-muted' },
};

const VERDICT_RING: Record<string, string> = {
  trusted: 'border-border',
  attention: 'border-warning',
  blocked: 'border-danger',
};

/** In run view the ring says what happened, and only that. */
const RUN_RING: Record<WorkflowCanvasNodeRun['tone'], string> = {
  success: 'border-success',
  info: 'border-info',
  warning: 'border-warning',
  danger: 'border-danger',
  neutral: 'border-border opacity-70',
  live: 'border-primary',
};
const RUN_PILL: Record<WorkflowCanvasNodeRun['tone'], string> = {
  success: 'bg-success-tint text-success',
  info: 'bg-info-tint text-info',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-subtle text-muted',
  live: 'bg-primary-tint text-primary',
};

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium', className)}>
      {children}
    </span>
  );
}

function WorkflowCanvasNodeImpl({ data, selected }: NodeProps<WorkflowCanvasFlowNode>) {
  const { node, isNew, run } = data;
  const effect = EFFECT_STYLE[node.meta?.sideEffect ?? 'unknown'];
  const verdict = node.verdict?.status ?? 'trusted';
  const executor = node.meta?.executor;
  const toolCount = node.meta?.toolCount ?? 0;

  return (
    <div
      className={cn(
        'w-56 rounded-lg border bg-surface p-3 shadow-popover transition-colors',
        run ? RUN_RING[run.tone] : (VERDICT_RING[verdict] ?? 'border-border'),
        run?.tone === 'live' && 'border-2',
        selected && 'ring-2 ring-ring',
        isNew && 'border-dashed',
      )}
    >
      {/* Left = incoming dependency, right = dependents. Direction matches the
          left-to-right layering, so an edge always reads "runs before". */}
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-surface" />

      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-caption text-muted" title={node.id}>
          {node.id}
        </span>
        {isNew ? <Badge className="bg-primary-tint text-primary">new</Badge> : null}
        {run ? <Badge className={RUN_PILL[run.tone]}>{run.label}</Badge> : null}
      </div>

      <div className="mb-2 line-clamp-2 text-small font-medium text-fg" title={node.label ?? node.id}>
        {node.label ?? node.id}
      </div>

      {run?.detail ? (
        <div className="mb-2 truncate text-caption text-muted" title={run.detail}>{run.detail}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <Badge className={effect.className}>
          <CircleDot size={10} aria-hidden />
          {effect.label}
        </Badge>

        {node.flags?.approval ? (
          <Badge className="bg-subtle text-fg">
            <ShieldCheck size={10} aria-hidden />
            approval
          </Badge>
        ) : null}

        {node.flags?.forEach ? (
          <Badge className="bg-subtle text-fg">
            <Repeat size={10} aria-hidden />
            each
          </Badge>
        ) : null}

        {node.flags?.skill ? (
          <Badge className="bg-subtle text-fg">
            <Boxes size={10} aria-hidden />
            {node.flags.skill}
          </Badge>
        ) : null}

        {executor === 'deterministic' ? (
          <Badge className="bg-subtle text-fg">
            <Terminal size={10} aria-hidden />
            script
          </Badge>
        ) : null}

        {toolCount > 0 ? (
          <Badge className="bg-subtle text-muted">
            <Wrench size={10} aria-hidden />
            {toolCount}
          </Badge>
        ) : null}
      </div>

      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-surface" />
    </div>
  );
}

export const WorkflowCanvasNode = memo(WorkflowCanvasNodeImpl);
