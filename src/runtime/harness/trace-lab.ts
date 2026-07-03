import {
  getSession,
  listEvents,
  listSessions,
  type EventRow,
  type EventType,
  type SessionKind,
  type SessionRow,
  type SessionStatus,
} from './eventlog.js';

export type TraceNodeCategory =
  | 'user'
  | 'model'
  | 'tool'
  | 'external_write'
  | 'guardrail'
  | 'approval'
  | 'handoff'
  | 'memory'
  | 'plan'
  | 'workflow'
  | 'system';

export type TraceSeverity = 'debug' | 'info' | 'warn' | 'error';
export type TraceRiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface TraceNode {
  id: string;
  seq: number;
  eventId: string;
  sessionId: string;
  turn: number;
  type: EventType;
  category: TraceNodeCategory;
  severity: TraceSeverity;
  label: string;
  detail: string;
  createdAt: string;
  parentId?: string;
  tool?: string;
  callId?: string;
  target?: string;
  dataPreview: string;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  kind: 'temporal' | 'parent' | 'tool_result' | 'approval_resolution' | 'turn';
  label: string;
}

export interface TraceMetrics {
  events: number;
  turns: number;
  toolCalls: number;
  toolReturns: number;
  guardrails: number;
  approvalsRequested: number;
  approvalsResolved: number;
  handoffs: number;
  externalWrites: number;
  modelRoutes: number;
  memoryWrites: number;
  failures: number;
  durationMs?: number;
}

export interface TraceReplayStatus {
  ready: boolean;
  mode: 'safe_prompt';
  riskLevel: TraceRiskLevel;
  risks: string[];
}

export interface TraceSummary {
  sessionId: string;
  kind: SessionKind;
  status: SessionStatus;
  title?: string;
  objective?: string;
  startedAt: string;
  updatedAt: string;
  firstEventAt?: string;
  lastEventAt?: string;
  metrics: TraceMetrics;
  replay: TraceReplayStatus;
}

export interface TraceDetail extends TraceSummary {
  nodes: TraceNode[];
  edges: TraceEdge[];
  truncated: boolean;
}

export interface TraceReplayPreview {
  sessionId: string;
  generatedAt: string;
  mode: 'safe_prompt';
  ready: boolean;
  riskLevel: TraceRiskLevel;
  risks: string[];
  prompt: string;
  source: {
    events: number;
    nodesIncluded: number;
    truncated: boolean;
  };
}

export interface ListTraceOptions {
  limit?: number;
  kind?: SessionKind;
  status?: SessionStatus | 'any';
}

const DEFAULT_NODE_LIMIT = 500;

function str(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function clip(value: string, max = 900): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function dataPreview(data: Record<string, unknown>): string {
  try {
    return clip(JSON.stringify(data));
  } catch {
    return '{}';
  }
}

function eventCategory(type: EventType): TraceNodeCategory {
  if (type === 'user_input_received' || type === 'awaiting_user_input') return 'user';
  if (
    type === 'reasoning_effort'
    || type === 'worker_model_routed'
    || type === 'brain_fallover'
    || type === 'sdk_auto_continue'
    || type === 'sdk_compact_boundary'
    || type === 'sdk_compact_failed'
    || type === 'native_compaction_applied'
    || type === 'rubric_variant'
  ) return 'model';
  if (
    type === 'tool_called'
    || type === 'tool_returned'
    || type === 'mcp_tool_scope'
    || type === 'tool_jit_scope'
    || type === 'tool_policy_resolved'
    || type === 'sdk_tool_surface_retry'
  ) return 'tool';
  if (type === 'external_write' || type === 'external_write_failed' || type === 'external_write_orphaned') return 'external_write';
  if (type === 'guardrail_tripped' || type === 'goal_alignment_judged' || type === 'output_grounding_judged') return 'guardrail';
  if (type === 'approval_requested' || type === 'approval_resolved' || type === 'autonomy_note') return 'approval';
  if (type === 'handoff') return 'handoff';
  if (type === 'memory_signals_captured' || type === 'turn_memory_primer') return 'memory';
  if (type.startsWith('plan_') || type === 'loop_intent_proposed' || type === 'plan_first_started' || type === 'plan_first_failed') return 'plan';
  if (
    type === 'step_started'
    || type === 'step_verified'
    || type === 'step_failed'
    || type === 'workflow_step_overbudget'
    || type === 'worker_capped'
    || type === 'worker_result'
    || type === 'fanout_policy_decision'
    || type === 'ooda_cycle'
  ) return 'workflow';
  return 'system';
}

function eventSeverity(type: EventType, data: Record<string, unknown>): TraceSeverity {
  if (
    type === 'run_failed'
    || type === 'step_failed'
    || type === 'sdk_compact_failed'
    || type === 'external_write_failed'
    || data.ok === false
    || data.status === 'failed'
    || data.outcome === 'error'
  ) return 'error';
  if (
    type === 'guardrail_tripped'
    || type === 'stuck_detected'
    || type === 'conversation_limit_exceeded'
    || type === 'external_write_orphaned'
    || type === 'approval_requested'
    || type === 'brain_fallover'
    || data.outcome === 'advisory'
    || data.reason === 'interrupted_by_restart'
  ) return 'warn';
  if (type === 'heartbeat' || type === 'turn_memory_primer') return 'debug';
  return 'info';
}

function eventLabel(type: EventType, data: Record<string, unknown>): string {
  switch (type) {
    case 'user_input_received': return 'User input';
    case 'turn_started': return 'Turn started';
    case 'turn_ended': return 'Turn ended';
    case 'tool_called': return `Tool called: ${str(data, 'tool', 'toolName') ?? 'unknown'}`;
    case 'tool_returned': return `Tool returned: ${str(data, 'tool', 'toolName') ?? 'unknown'}`;
    case 'external_write': return 'External write allowed';
    case 'external_write_failed': return 'External write failed';
    case 'external_write_orphaned': return 'External write timed out';
    case 'guardrail_tripped': return `Guardrail: ${str(data, 'kind', 'reason') ?? 'tripped'}`;
    case 'approval_requested': return 'Approval requested';
    case 'approval_resolved': return `Approval ${str(data, 'resolution', 'status') ?? 'resolved'}`;
    case 'handoff': return `Handoff to ${str(data, 'to', 'agent', 'target') ?? 'agent'}`;
    case 'conversation_completed': return 'Conversation completed';
    case 'run_completed': return 'Run completed';
    case 'run_failed': return 'Run failed';
    case 'worker_model_routed': return 'Worker model routed';
    case 'reasoning_effort': return 'Reasoning effort selected';
    case 'goal_alignment_judged': return 'Goal alignment judged';
    case 'output_grounding_judged': return 'Output grounding judged';
    default: return type.replace(/_/g, ' ');
  }
}

function eventDetail(ev: EventRow): string {
  const data = ev.data;
  const category = eventCategory(ev.type);
  if (ev.type === 'user_input_received') return clip(str(data, 'text') ?? '');
  if (ev.type === 'conversation_completed') return clip(str(data, 'reply', 'summary', 'reason') ?? '');
  if (ev.type === 'tool_called') return clip(str(data, 'arguments', 'args', 'tool_slug') ?? '');
  if (ev.type === 'tool_returned') return clip(str(data, 'output', 'summary', 'result') ?? '');
  if (ev.type === 'approval_requested') return clip(str(data, 'subject', 'tool') ?? '');
  if (ev.type === 'guardrail_tripped') return clip(str(data, 'message', 'reason', 'kind') ?? '');
  if (ev.type === 'run_failed' || ev.type === 'step_failed') return clip(str(data, 'error', 'message', 'reason') ?? '');
  if (category === 'external_write') return clip(str(data, 'shapeKey', 'target', 'tool', 'reason') ?? '');
  if (category === 'model') return clip(str(data, 'model', 'resolvedModel', 'effort', 'reason', 'toModel') ?? '');
  return clip(str(data, 'summary', 'message', 'reason', 'status', 'outcome') ?? '');
}

function eventTarget(data: Record<string, unknown>): string | undefined {
  return str(data, 'target', 'to', 'to_email', 'email', 'url', 'workspaceId', 'workflowRunId');
}

function eventCallId(data: Record<string, unknown>): string | undefined {
  return str(data, 'callId', 'call_id', 'toolCallId', 'approvalId');
}

function eventTool(data: Record<string, unknown>): string | undefined {
  return str(data, 'tool', 'toolName', 'tool_slug');
}

function nodeFromEvent(ev: EventRow): TraceNode {
  const data = ev.data;
  const parentId = ev.parentEventId ? `event:${ev.parentEventId}` : undefined;
  const tool = eventTool(data);
  const callId = eventCallId(data);
  const target = eventTarget(data);
  return {
    id: `event:${ev.id}`,
    seq: ev.seq,
    eventId: ev.id,
    sessionId: ev.sessionId,
    turn: ev.turn,
    type: ev.type,
    category: eventCategory(ev.type),
    severity: eventSeverity(ev.type, data),
    label: eventLabel(ev.type, data),
    detail: eventDetail(ev),
    createdAt: ev.createdAt,
    ...(parentId ? { parentId } : {}),
    ...(tool ? { tool } : {}),
    ...(callId ? { callId } : {}),
    ...(target ? { target } : {}),
    dataPreview: dataPreview(data),
  };
}

function emptyMetrics(events = 0): TraceMetrics {
  return {
    events,
    turns: 0,
    toolCalls: 0,
    toolReturns: 0,
    guardrails: 0,
    approvalsRequested: 0,
    approvalsResolved: 0,
    handoffs: 0,
    externalWrites: 0,
    modelRoutes: 0,
    memoryWrites: 0,
    failures: 0,
  };
}

function computeMetrics(events: EventRow[]): TraceMetrics {
  const metrics = emptyMetrics(events.length);
  const turns = new Set<number>();
  for (const ev of events) {
    turns.add(ev.turn);
    if (ev.type === 'tool_called') metrics.toolCalls += 1;
    if (ev.type === 'tool_returned') metrics.toolReturns += 1;
    if (eventCategory(ev.type) === 'guardrail') metrics.guardrails += 1;
    if (ev.type === 'approval_requested') metrics.approvalsRequested += 1;
    if (ev.type === 'approval_resolved') metrics.approvalsResolved += 1;
    if (ev.type === 'handoff') metrics.handoffs += 1;
    if (eventCategory(ev.type) === 'external_write') metrics.externalWrites += 1;
    if (ev.type === 'worker_model_routed' || ev.type === 'reasoning_effort' || ev.type === 'brain_fallover') metrics.modelRoutes += 1;
    if (ev.type === 'memory_signals_captured') metrics.memoryWrites += 1;
    if (eventSeverity(ev.type, ev.data) === 'error') metrics.failures += 1;
  }
  metrics.turns = turns.size;
  if (events.length >= 2) {
    const first = Date.parse(events[0].createdAt);
    const last = Date.parse(events[events.length - 1].createdAt);
    if (Number.isFinite(first) && Number.isFinite(last)) metrics.durationMs = Math.max(0, last - first);
  }
  return metrics;
}

function replayStatus(session: SessionRow, events: EventRow[], metrics: TraceMetrics): TraceReplayStatus {
  const risks: string[] = [];
  if (events.length === 0) risks.push('No harness events were recorded for this session.');
  if (metrics.externalWrites > 0) risks.push(`${metrics.externalWrites} external write event(s) occurred; replay must stay dry-run until explicitly approved.`);
  if (metrics.approvalsRequested > metrics.approvalsResolved) risks.push('At least one approval request was not resolved in this trace.');
  if (metrics.failures > 0 || session.status === 'failed') risks.push('The run contains failure events; replay should compare behavior, not assume success.');
  if (metrics.guardrails > 0) risks.push(`${metrics.guardrails} guardrail/verdict event(s) should be checked for regressions.`);
  if (metrics.toolCalls > 0) risks.push(`${metrics.toolCalls} tool call(s) may depend on external state that has changed since the original run.`);
  let riskLevel: TraceRiskLevel = 'none';
  if (metrics.externalWrites > 0 || metrics.failures > 0 || session.status === 'failed') riskLevel = 'high';
  else if (metrics.guardrails > 0 || metrics.approvalsRequested > metrics.approvalsResolved) riskLevel = 'medium';
  else if (metrics.toolCalls > 0) riskLevel = 'low';
  return { ready: events.length > 0, mode: 'safe_prompt', riskLevel, risks };
}

function summaryFrom(session: SessionRow, events: EventRow[]): TraceSummary {
  const metrics = computeMetrics(events);
  return {
    sessionId: session.id,
    kind: session.kind,
    status: session.status,
    ...(session.title ? { title: session.title } : {}),
    ...(session.objective ? { objective: session.objective } : {}),
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(events[0]?.createdAt ? { firstEventAt: events[0].createdAt } : {}),
    ...(events.at(-1)?.createdAt ? { lastEventAt: events.at(-1)!.createdAt } : {}),
    metrics,
    replay: replayStatus(session, events, metrics),
  };
}

function buildEdges(nodes: TraceNode[]): TraceEdge[] {
  const edges: TraceEdge[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const toolCalls = new Map<string, TraceNode>();
  const approvals = new Map<string, TraceNode>();
  let prior: TraceNode | null = null;
  let priorByTurn = new Map<number, TraceNode>();

  for (const node of nodes) {
    if (prior) {
      edges.push({ id: `temporal:${prior.seq}:${node.seq}`, from: prior.id, to: node.id, kind: 'temporal', label: 'next' });
    }
    prior = node;

    const turnPrior = priorByTurn.get(node.turn);
    if (turnPrior && turnPrior.id !== node.id) {
      edges.push({ id: `turn:${turnPrior.seq}:${node.seq}`, from: turnPrior.id, to: node.id, kind: 'turn', label: `turn ${node.turn}` });
    }
    priorByTurn = new Map(priorByTurn).set(node.turn, node);

    if (node.parentId && byId.has(node.parentId)) {
      edges.push({ id: `parent:${node.parentId}:${node.id}`, from: node.parentId, to: node.id, kind: 'parent', label: 'parent' });
    }
    if (node.type === 'tool_called' && node.callId) toolCalls.set(node.callId, node);
    if (node.type === 'tool_returned' && node.callId) {
      const call = toolCalls.get(node.callId);
      if (call) edges.push({ id: `tool:${node.callId}`, from: call.id, to: node.id, kind: 'tool_result', label: node.callId });
    }
    if (node.type === 'approval_requested' && node.callId) approvals.set(node.callId, node);
    if (node.type === 'approval_resolved' && node.callId) {
      const approval = approvals.get(node.callId);
      if (approval) edges.push({ id: `approval:${node.callId}`, from: approval.id, to: node.id, kind: 'approval_resolution', label: node.callId });
    }
  }
  return edges;
}

export function buildTraceDetail(sessionId: string, opts: { nodeLimit?: number } = {}): TraceDetail | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const events = listEvents(sessionId);
  const nodeLimit = Math.max(1, Math.min(opts.nodeLimit ?? DEFAULT_NODE_LIMIT, 2000));
  const visibleEvents = events.length > nodeLimit ? events.slice(events.length - nodeLimit) : events;
  const nodes = visibleEvents.map(nodeFromEvent);
  return {
    ...summaryFrom(session, events),
    nodes,
    edges: buildEdges(nodes),
    truncated: visibleEvents.length !== events.length,
  };
}

export function listTraceSummaries(opts: ListTraceOptions = {}): TraceSummary[] {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 50), 200));
  const sessions = listSessions({
    kind: opts.kind,
    status: opts.status ?? 'any',
    limit,
  });
  return sessions.map((session) => summaryFrom(session, listEvents(session.id)));
}

function keyEventsForPrompt(nodes: TraceNode[]): TraceNode[] {
  return nodes.filter((node) => (
    node.type === 'user_input_received'
    || node.type === 'tool_called'
    || node.type === 'tool_returned'
    || node.type === 'guardrail_tripped'
    || node.type === 'approval_requested'
    || node.type === 'approval_resolved'
    || node.type === 'external_write'
    || node.type === 'external_write_failed'
    || node.type === 'external_write_orphaned'
    || node.type === 'conversation_completed'
    || node.type === 'run_failed'
    || node.type === 'brain_fallover'
  )).slice(-80);
}

function renderReplayPrompt(detail: TraceDetail): string {
  const lines = keyEventsForPrompt(detail.nodes).map((node) => {
    const bits = [`#${node.seq}`, node.type, node.label];
    if (node.detail) bits.push(node.detail);
    return `- ${bits.join(' | ')}`;
  });
  return [
    'Replay this Clementine harness run as a SAFE regression/debugging exercise.',
    '',
    'Do not perform external writes, sends, deletes, deployments, or irreversible actions during this replay unless I explicitly approve them in this new chat. First reconstruct what happened, identify likely divergence from today\'s code/model/tool state, and propose the smallest safe verification path.',
    '',
    `Session: ${detail.sessionId}`,
    `Kind/status: ${detail.kind}/${detail.status}`,
    detail.title ? `Title: ${detail.title}` : '',
    detail.objective ? `Objective: ${detail.objective}` : '',
    `Events: ${detail.metrics.events}; tools: ${detail.metrics.toolCalls}; guardrails: ${detail.metrics.guardrails}; approvals: ${detail.metrics.approvalsRequested}/${detail.metrics.approvalsResolved}; external writes: ${detail.metrics.externalWrites}; failures: ${detail.metrics.failures}`,
    `Replay risk: ${detail.replay.riskLevel}`,
    ...(detail.replay.risks.length ? ['Risks:', ...detail.replay.risks.map((risk) => `- ${risk}`)] : ['Risks: none recorded']),
    '',
    'Key timeline:',
    ...(lines.length ? lines : ['- No key events were captured.']),
    '',
    'Return: (1) what the original run did, (2) where today\'s replay could diverge, (3) which regression test or dry-run should be added, and (4) whether it is safe to continue the task.',
  ].filter(Boolean).join('\n');
}

export function buildTraceReplayPreview(sessionId: string, opts: { nodeLimit?: number } = {}): TraceReplayPreview | null {
  const detail = buildTraceDetail(sessionId, opts);
  if (!detail) return null;
  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    mode: 'safe_prompt',
    ready: detail.replay.ready,
    riskLevel: detail.replay.riskLevel,
    risks: detail.replay.risks,
    prompt: renderReplayPrompt(detail),
    source: {
      events: detail.metrics.events,
      nodesIncluded: detail.nodes.length,
      truncated: detail.truncated,
    },
  };
}
