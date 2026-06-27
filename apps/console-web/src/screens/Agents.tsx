/**
 * Multi-agent workspace (slice 1, read-only). Surfaces the team-agent
 * system that already runs under the hood: the roster, the canMessage
 * graph with live message pulses, a comms/delegation timeline, and a
 * click-into per-agent run trace. Pure reads over /api/console/agents.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Users, MessageSquare, ArrowRight, Send, Inbox, Repeat, Clock, Plus, BookOpen, Workflow, Route, Share2, CheckCircle2, XCircle, Sparkles, ClipboardList } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { relativeTime } from '@/lib/inbox';
import { AgentGraph } from '@/components/agents/AgentGraph';
import { AgentTraceDrawer } from '@/components/agents/AgentTraceDrawer';
import { AgentForm } from '@/components/agents/AgentForm';
import {
  listAgents, getAgentGraph, getAgentComms, getAgentCatalog, latestCommsKey,
  listAgentProposals, approveAgentProposal, rejectAgentProposal,
  type AgentSummary, type TeamMessage, type Delegation, type AgentProposal,
} from '@/lib/agents';
import {
  getAgentSystemMetrics,
  type AgentScorecard,
  type AgentSystemRecommendation,
  type AgentSystemTrendSnapshot,
  type CoordinationPolicySnapshot,
  type SwarmEffectivenessSnapshot,
  type SwarmReadinessSnapshot,
  type SwarmTopologySnapshot,
} from '@/lib/advanced';

function statusTone(status: AgentSummary['status']): Tone {
  if (status === 'active') return 'live';
  if (status === 'blocked') return 'danger';
  return 'neutral';
}

function AgentCard({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 text-left shadow-xs transition-all duration-fast hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-body-lg font-semibold text-fg">{agent.name}</div>
          {agent.role && <div className="text-caption text-muted">{agent.role}</div>}
        </div>
        <StatusPill tone={statusTone(agent.status)}>{agent.status}</StatusPill>
      </div>

      <p className="line-clamp-2 text-small text-muted">{agent.description || agent.personality}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
        {agent.model && <span>{agent.model}</span>}
        {agent.proactive && agent.cadenceMinutes && (
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> every {agent.cadenceMinutes}m</span>
        )}
        {agent.allowedTools.length > 0 && <span>{agent.allowedTools.length} tools</span>}
        {agent.pendingInbox > 0 && (
          <span className="inline-flex items-center gap-1 text-warning"><Inbox className="h-3 w-3" /> {agent.pendingInbox}</span>
        )}
      </div>

      {agent.canMessage.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Send className="h-3 w-3 text-faint" aria-hidden />
          {agent.canMessage.map((slug) => (
            <span key={slug} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">{slug}</span>
          ))}
        </div>
      )}

      {agent.skills.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <BookOpen className="h-3 w-3 text-info" aria-hidden />
          {agent.skills.map((s) => (
            <span key={s} className="rounded-full bg-info-tint px-2 py-0.5 text-caption text-info">{s}</span>
          ))}
        </div>
      )}

      {agent.workflows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Workflow className="h-3 w-3 text-success" aria-hidden />
          {agent.workflows.map((w) => (
            <span key={w} className="rounded-full bg-success-tint px-2 py-0.5 text-caption text-success">{w}</span>
          ))}
        </div>
      )}

      {agent.lastSummary && (
        <p className="line-clamp-2 border-t border-border pt-2 text-caption text-faint">
          {agent.lastRunAt && <span className="font-medium text-muted">{relativeTime(agent.lastRunAt)}: </span>}
          {agent.lastSummary}
        </p>
      )}
    </button>
  );
}

interface TimelineItem {
  key: string;
  kind: 'message' | 'request' | 'response' | 'delegation';
  from: string;
  to: string;
  text: string;
  time: string;
  status?: string;
}

function buildTimeline(messages: TeamMessage[], delegations: Delegation[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({
      key: `m-${m.id}`, kind: m.protocol, from: m.fromAgent, to: m.toAgent, text: m.content, time: m.timestamp,
    })),
    ...delegations.map((d) => ({
      key: `d-${d.id}`, kind: 'delegation' as const, from: d.fromAgent, to: d.toAgent, text: d.task, time: d.updatedAt, status: d.status,
    })),
  ];
  return items.sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 60);
}

function kindBadge(item: TimelineItem): { tone: Tone; label: string } {
  if (item.kind === 'delegation') {
    if (item.status === 'completed') return { tone: 'success', label: 'delegation' };
    return { tone: 'info', label: 'delegation' };
  }
  if (item.kind === 'request') return { tone: 'warning', label: 'request' };
  if (item.kind === 'response') return { tone: 'success', label: 'response' };
  return { tone: 'neutral', label: 'message' };
}

function recommendationTone(severity: AgentSystemRecommendation['severity']): Tone {
  if (severity === 'critical') return 'danger';
  if (severity === 'warn') return 'warning';
  return 'info';
}

function scorecardTone(status: AgentScorecard['status']): Tone {
  if (status === 'blocked') return 'danger';
  if (status === 'watch') return 'warning';
  if (status === 'healthy') return 'success';
  return 'neutral';
}

function capRateTone(rate: number): Tone {
  if (rate >= 20) return 'danger';
  if (rate > 0) return 'warning';
  return 'success';
}

function topologyTone(topology: SwarmTopologySnapshot): Tone {
  if (topology.unknownTargets.length > 0) return 'danger';
  if (topology.kind === 'isolated') return 'warning';
  if (topology.kind === 'mesh') return 'success';
  if (topology.kind === 'hub-and-spoke') return 'info';
  return 'neutral';
}

function readinessTone(status: SwarmReadinessSnapshot['status']): Tone {
  if (status === 'ready') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'blocked') return 'danger';
  return 'neutral';
}

function coordinationTone(status: CoordinationPolicySnapshot['status']): Tone {
  if (status === 'expand') return 'success';
  if (status === 'repair' || status === 'constrain') return 'danger';
  if (status === 'learn') return 'info';
  return 'warning';
}

function fanoutPostureTone(posture: CoordinationPolicySnapshot['fanoutPosture']): Tone {
  if (posture === 'allow') return 'success';
  if (posture === 'soft') return 'info';
  if (posture === 'constrain') return 'warning';
  return 'danger';
}

function trendTone(status: AgentSystemTrendSnapshot['status']): Tone {
  if (status === 'improving') return 'success';
  if (status === 'regressing') return 'danger';
  if (status === 'stable') return 'warning';
  return 'neutral';
}

function decisionTone(kind: AgentProposal['decision']['kind']): Tone {
  if (kind === 'agent' || kind === 'workflow_with_agent') return 'success';
  if (kind === 'workflow') return 'info';
  return 'warning';
}

function decisionLabel(kind: AgentProposal['decision']['kind']): string {
  if (kind === 'workflow_with_agent') return 'fit: workflow + agent';
  if (kind === 'one_off') return 'fit: one-off';
  return `fit: ${kind}`;
}

function CreationModes({ onNewAgent }: { onNewAgent: () => void }) {
  return (
    <div className="mb-5 grid gap-3 md:grid-cols-3">
      <button
        type="button"
        onClick={onNewAgent}
        className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-4 text-left transition-colors hover:border-border-strong hover:bg-hover"
      >
        <span className="flex items-center gap-2 text-small font-semibold text-fg">
          <Users className="h-4 w-4 text-primary" aria-hidden /> New agent
        </span>
        <ArrowRight className="h-4 w-4 text-faint" aria-hidden />
      </button>
      <Link
        to="/automate"
        className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-4 text-left transition-colors hover:border-border-strong hover:bg-hover"
      >
        <span className="flex items-center gap-2 text-small font-semibold text-fg">
          <Workflow className="h-4 w-4 text-success" aria-hidden /> New workflow
        </span>
        <ArrowRight className="h-4 w-4 text-faint" aria-hidden />
      </Link>
      <Link
        to="/chat"
        className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-4 text-left transition-colors hover:border-border-strong hover:bg-hover"
      >
        <span className="flex items-center gap-2 text-small font-semibold text-fg">
          <MessageSquare className="h-4 w-4 text-info" aria-hidden /> One-off task
        </span>
        <ArrowRight className="h-4 w-4 text-faint" aria-hidden />
      </Link>
    </div>
  );
}

function AgentProposals({
  proposals,
  busyId,
  onApprove,
  onReject,
  error,
}: {
  proposals: AgentProposal[];
  busyId: string | null;
  onApprove: (proposal: AgentProposal) => void;
  onReject: (proposal: AgentProposal) => void;
  error?: string | null;
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="mb-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Agent drafts
        </div>
        <StatusPill tone="info">{proposals.length} pending</StatusPill>
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-small text-danger">
          {error}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {proposals.map((proposal) => {
          const busy = busyId === proposal.id;
          return (
            <div key={proposal.id} className="rounded-md border border-border bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-small font-semibold text-fg">{proposal.agent.name}</div>
                  <div className="truncate text-caption text-faint">{proposal.agent.role ?? proposal.proposedByAgent}</div>
                </div>
                <StatusPill tone={decisionTone(proposal.decision.kind)}>
                  {decisionLabel(proposal.decision.kind)} · {proposal.decision.confidence}/100
                </StatusPill>
              </div>
              <p className="line-clamp-2 text-small text-muted">{proposal.agent.description}</p>
              <p className="mt-2 line-clamp-2 text-caption text-faint">{proposal.rationale}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {proposal.agent.model && <span className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">{proposal.agent.model}</span>}
                {proposal.agent.allowedTools.length > 0 && <span className="rounded-full bg-info-tint px-2 py-0.5 text-caption text-info">{proposal.agent.allowedTools.length} tools</span>}
                {proposal.evalCriteria.length > 0 && <span className="rounded-full bg-success-tint px-2 py-0.5 text-caption text-success">{proposal.evalCriteria.length} checks</span>}
                {proposal.memoryScope && <span className="rounded-full bg-primary-tint px-2 py-0.5 text-caption text-primary">memory scoped</span>}
              </div>
              {proposal.suggestedWorkflows.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ClipboardList className="mt-0.5 h-3.5 w-3.5 text-faint" aria-hidden />
                  {proposal.suggestedWorkflows.slice(0, 3).map((workflow) => (
                    <span key={workflow} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">{workflow}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => onReject(proposal)} disabled={busy}>
                  <XCircle className="h-4 w-4" /> Reject
                </Button>
                <Button size="sm" onClick={() => onApprove(proposal)} disabled={busy}>
                  <CheckCircle2 className="h-4 w-4" /> Create agent
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CoordinationPolicyCard({ policy, trend }: { policy?: CoordinationPolicySnapshot; trend?: AgentSystemTrendSnapshot }) {
  if (!policy) return null;
  const reasons = policy.reasons.slice(0, 3);
  const guardrails = policy.guardrails.slice(0, 3);
  return (
    <Card className="mb-5 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
            <Route className="h-3.5 w-3.5" aria-hidden /> Coordination policy
          </div>
          <p className="mt-1 text-small text-muted">{policy.nextAction}</p>
        </div>
        <StatusPill tone={coordinationTone(policy.status)}>
          {policy.mode} · {policy.confidence}/100
        </StatusPill>
        <StatusPill tone={fanoutPostureTone(policy.fanoutPosture)}>fanout {policy.fanoutPosture}</StatusPill>
        <StatusPill tone={policy.recommendedWorkerWaveSize >= 8 ? 'success' : policy.recommendedWorkerWaveSize > 0 ? 'info' : 'danger'}>
          wave {policy.recommendedWorkerWaveSize}
        </StatusPill>
      </div>
      {trend && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-caption">
          <StatusPill tone={trendTone(trend.status)}>trend {trend.status}</StatusPill>
          {trend.recent.length > 0 && (
            <span className="rounded-full bg-primary-tint px-2 py-0.5 text-primary">
              health {trend.recent[trend.recent.length - 1]?.healthScore}/100
            </span>
          )}
          {trend.signals.slice(0, 3).map((signal) => (
            <span key={signal} className="rounded-full bg-subtle px-2 py-0.5 text-muted">{signal}</span>
          ))}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Why</div>
          {reasons.length > 0 ? (
            <ul className="space-y-1">
              {reasons.map((reason) => <li key={reason} className="text-small text-muted">{reason}</li>)}
            </ul>
          ) : (
            <p className="text-small text-muted">No policy reasons recorded yet.</p>
          )}
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Guardrails</div>
          {guardrails.length > 0 ? (
            <ul className="space-y-1">
              {guardrails.map((guardrail) => <li key={guardrail} className="text-small text-warning">{guardrail}</li>)}
            </ul>
          ) : (
            <p className="text-small text-muted">No extra guardrails for this mode.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function SwarmGuidance({ recommendations }: { recommendations: AgentSystemRecommendation[] }) {
  if (recommendations.length === 0) return null;
  return (
    <Card className="mb-5 p-4">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
        <Users className="h-3.5 w-3.5" aria-hidden /> Swarm guidance
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {recommendations.slice(0, 4).map((rec) => (
          <div key={rec.id} className="rounded-md border border-border bg-surface p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <StatusPill tone={recommendationTone(rec.severity)}>{rec.target}</StatusPill>
              <span className="text-small font-semibold text-fg">{rec.title}</span>
            </div>
            <p className="text-small text-muted">{rec.detail}</p>
            <p className="mt-1 text-caption text-faint">{rec.action}</p>
            <Link
              to={rec.href}
              className="mt-2 inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-small font-semibold text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
            >
              {rec.cta}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SwarmReadiness({ readiness }: { readiness?: SwarmReadinessSnapshot }) {
  if (!readiness) return null;
  const risks = readiness.risks.slice(0, 3);
  const strengths = readiness.strengths.slice(0, 3);
  return (
    <Card className="mb-5 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
            <Users className="h-3.5 w-3.5" aria-hidden /> Swarm readiness
          </div>
          <p className="mt-1 text-small text-muted">{readiness.recommendation}</p>
        </div>
        <StatusPill tone={readinessTone(readiness.status)}>{readiness.score}/100 · {readiness.status}</StatusPill>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Risks</div>
          {risks.length > 0 ? (
            <ul className="space-y-1">
              {risks.map((risk) => <li key={risk} className="text-small text-warning">{risk}</li>)}
            </ul>
          ) : (
            <p className="text-small text-muted">No readiness risks flagged.</p>
          )}
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Strengths</div>
          {strengths.length > 0 ? (
            <ul className="space-y-1">
              {strengths.map((strength) => <li key={strength} className="text-small text-success">{strength}</li>)}
            </ul>
          ) : (
            <p className="text-small text-muted">Run a small swarm task to build evidence.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function AgentScorecards({ scorecards, onOpen }: { scorecards: AgentScorecard[]; onOpen: (slug: string) => void }) {
  if (scorecards.length === 0) return null;
  return (
    <Card className="mb-5 p-4">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
        <Users className="h-3.5 w-3.5" aria-hidden /> Agent scorecards
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {scorecards.slice(0, 4).map((scorecard) => (
          <button
            key={scorecard.slug}
            type="button"
            onClick={() => onOpen(scorecard.slug)}
            className="rounded-md border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-hover"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-small font-semibold text-fg">{scorecard.name}</div>
                <div className="truncate text-caption text-faint">{scorecard.role ?? scorecard.slug}</div>
              </div>
              <StatusPill tone={scorecardTone(scorecard.status)}>{scorecard.score}/100</StatusPill>
            </div>
            <div className="mb-2 grid grid-cols-3 gap-2 text-caption">
              <span className="truncate text-muted">{scorecard.autonomyRuns.successRatePct}% runs</span>
              <span className="truncate text-muted">{scorecard.comms24h.sent + scorecard.comms24h.received} comms</span>
              <span className="truncate text-muted">{scorecard.pendingInbox} inbox</span>
            </div>
            <p className="line-clamp-2 text-caption text-faint">{scorecard.recommendation}</p>
          </button>
        ))}
      </div>
    </Card>
  );
}

function FanoutEffectiveness({ effectiveness }: { effectiveness?: SwarmEffectivenessSnapshot }) {
  if (!effectiveness) return null;
  const topModels = effectiveness.modelSpread.slice(0, 3);
  const topTransports = effectiveness.transportSpread.slice(0, 2);
  const topPostures = effectiveness.postureSpread.slice(0, 3);
  const averageWave = effectiveness.averageRecommendedWaveSize ?? '—';
  return (
    <Card className="mb-5 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
            <Route className="h-3.5 w-3.5" aria-hidden /> Fanout effectiveness
          </div>
          <p className="mt-1 text-small text-muted">{effectiveness.recommendation}</p>
        </div>
        <StatusPill tone={capRateTone(effectiveness.capRatePct)}>
          {effectiveness.capRatePct}% cap rate
        </StatusPill>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Routes</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{effectiveness.workerRoutes}</div>
          <div className="text-caption text-muted">{effectiveness.sampleSessions} session samples</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Policy decisions</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{effectiveness.policyDecisions}</div>
          <div className="text-caption text-muted">{effectiveness.fanoutOffered} offered · {effectiveness.fanoutBlockedByPolicy} blocked</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Policy block rate</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{effectiveness.fanoutSuppressedByPolicyPct}%</div>
          <div className="text-caption text-muted">avg wave {averageWave}</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Intent matches</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{effectiveness.intentMatchRatePct}%</div>
          <div className="text-caption text-muted">{effectiveness.intentMatches}/{effectiveness.intentRoutes} routed</div>
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Models</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {topModels.length > 0 ? topModels.map((model) => (
              <span key={model.modelId} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">
                {model.modelId} · {model.count}
              </span>
            )) : <span className="text-caption text-faint">No model routes</span>}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Postures</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {topPostures.length > 0 ? topPostures.map((row) => (
              <span key={row.posture} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">
                {row.posture} · {row.count}
              </span>
            )) : <span className="text-caption text-faint">No policy data</span>}
          </div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Transports</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {topTransports.length > 0 ? topTransports.map((transport) => (
              <span key={transport.transport} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">
                {transport.transport} · {transport.count}
              </span>
            )) : <span className="text-caption text-faint">No transport data</span>}
          </div>
        </div>
      </div>
      {effectiveness.recentCappedItems.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-faint">
          <span className="font-semibold text-muted">Capped items</span>
          {effectiveness.recentCappedItems.map((item) => (
            <span key={item} className="rounded-full bg-danger-tint px-2 py-0.5 text-danger">{item}</span>
          ))}
        </div>
      )}
    </Card>
  );
}

function TopologyHealth({ topology }: { topology?: SwarmTopologySnapshot }) {
  if (!topology) return null;
  const problemTargets = topology.unknownTargets.slice(0, 3);
  const isolatedAgents = topology.isolatedAgents.slice(0, 4);
  return (
    <Card className="mb-5 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
            <Share2 className="h-3.5 w-3.5" aria-hidden /> Topology health
          </div>
          <p className="mt-1 text-small text-muted">{topology.recommendation}</p>
        </div>
        <StatusPill tone={topologyTone(topology)}>{topology.kind}</StatusPill>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Message edges</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{topology.configuredEdges}</div>
          <div className="text-caption text-muted">{topology.densityPct}% density</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Reciprocity</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{topology.reciprocityPct}%</div>
          <div className="text-caption text-muted">{topology.reciprocalEdges}/{topology.configuredEdges} edges</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Request response</div>
          <div className="mt-1 text-title-sm font-semibold text-fg">{topology.requestResponsePct}%</div>
          <div className="text-caption text-muted">{topology.recentResponses}/{topology.recentRequests} recent</div>
        </div>
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="text-caption text-faint">Hub agents</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {topology.hubAgents.length > 0 ? topology.hubAgents.slice(0, 3).map((hub) => (
              <span key={hub.slug} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">
                {hub.slug} · {hub.outgoing}/{hub.incoming}
              </span>
            )) : <span className="text-caption text-faint">No hub concentration</span>}
          </div>
        </div>
      </div>
      {(problemTargets.length > 0 || isolatedAgents.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-faint">
          {problemTargets.length > 0 && <span className="font-semibold text-danger">Missing targets</span>}
          {problemTargets.map((edge) => (
            <span key={`${edge.from}->${edge.to}`} className="rounded-full bg-danger-tint px-2 py-0.5 text-danger">
              {`${edge.from} -> ${edge.to}`}
            </span>
          ))}
          {isolatedAgents.length > 0 && <span className="font-semibold text-warning">Isolated</span>}
          {isolatedAgents.map((slug) => (
            <span key={slug} className="rounded-full bg-warning-tint px-2 py-0.5 text-warning">{slug}</span>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Agents() {
  const qc = useQueryClient();
  const agentsQ = usePoll(['agents'], listAgents, 4000);
  const graphQ = usePoll(['agents', 'graph'], getAgentGraph, 4000);
  const commsQ = usePoll(['agents', 'comms'], () => getAgentComms(60), 4000);
  const catalogQ = usePoll(['agents', 'catalog'], getAgentCatalog, 30000);
  const proposalsQ = usePoll(['agents', 'proposals'], () => listAgentProposals('pending', 20), 5000);
  const systemQ = usePoll(['agent-system-metrics'], getAgentSystemMetrics, 15000);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; slug?: string } | null>(null);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);

  const agents = agentsQ.data ?? [];
  const proposals = proposalsQ.data ?? [];
  const swarmRecommendations = (systemQ.data?.recommendations ?? []).filter((rec) => rec.kind === 'swarm');
  const scorecards = systemQ.data?.swarm.scorecards ?? [];
  const fanoutEffectiveness = systemQ.data?.swarm.effectiveness;
  const topology = systemQ.data?.swarm.topology;
  const readiness = systemQ.data?.swarm.readiness;
  const coordination = systemQ.data?.coordination;
  const trend = systemQ.data?.trend;
  const openAgent = agents.find((a) => a.slug === openSlug) ?? null;
  const formAgent = form?.slug ? agents.find((a) => a.slug === form.slug) : undefined;

  const refetchAgents = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['agents', 'graph'] });
  };
  const refetchProposals = () => { void qc.invalidateQueries({ queryKey: ['agents', 'proposals'] }); };

  const approveProposal = async (proposal: AgentProposal) => {
    setProposalBusyId(proposal.id);
    setProposalError(null);
    try {
      const result = await approveAgentProposal(proposal.id);
      refetchAgents();
      refetchProposals();
      setOpenSlug(result.agent.slug);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : String(error));
    } finally {
      setProposalBusyId(null);
    }
  };

  const rejectProposal = async (proposal: AgentProposal) => {
    setProposalBusyId(proposal.id);
    setProposalError(null);
    try {
      await rejectAgentProposal(proposal.id);
      refetchProposals();
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : String(error));
    } finally {
      setProposalBusyId(null);
    }
  };

  // Pulse the edge for the newest message between polls.
  const pulseKey = latestCommsKey(commsQ.data);
  const pulseEdge = useMemo(() => {
    const m = commsQ.data?.messages[0];
    return m ? { source: m.fromAgent, target: m.toAgent } : null;
  }, [pulseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeline = useMemo(
    () => buildTimeline(commsQ.data?.messages ?? [], commsQ.data?.delegations ?? []),
    [commsQ.data],
  );

  const loading = agentsQ.isLoading && agents.length === 0;

  return (
    <Page
      title="Agents"
      subtitle="Your specialized team and how they work together"
      actions={
        <Button size="sm" onClick={() => setForm({ mode: 'create' })}>
          <Plus className="h-4 w-4" /> New agent
        </Button>
      }
    >
      <CreationModes onNewAgent={() => setForm({ mode: 'create' })} />
      <AgentProposals
        proposals={proposals}
        busyId={proposalBusyId}
        onApprove={approveProposal}
        onReject={rejectProposal}
        error={proposalError}
      />
      <SwarmGuidance recommendations={swarmRecommendations} />
      <CoordinationPolicyCard policy={coordination} trend={trend} />
      <SwarmReadiness readiness={readiness} />
      <TopologyHealth topology={topology} />
      <FanoutEffectiveness effectiveness={fanoutEffectiveness} />
      <AgentScorecards scorecards={scorecards} onOpen={setOpenSlug} />

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Specialized agents — each with its own persona, tools, and the ability to message the others. Create one here, or ask Clementine to “create an agent.”"
          action={<Button size="sm" onClick={() => setForm({ mode: 'create' })}><Plus className="h-4 w-4" /> New agent</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* Graph */}
          <section>
            <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
              <Users className="h-3.5 w-3.5" aria-hidden /> Team map
              <span className="font-normal normal-case text-faint">· arrows show who can message whom · edges pulse on a live message</span>
            </div>
            {graphQ.data && (
              <AgentGraph data={graphQ.data} pulseEdge={pulseEdge} pulseKey={pulseKey} onSelect={setOpenSlug} />
            )}
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Roster */}
            <section className="lg:col-span-2">
              <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Roster</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {agents.map((agent) => (
                  <AgentCard key={agent.slug} agent={agent} onOpen={() => setOpenSlug(agent.slug)} />
                ))}
              </div>
            </section>

            {/* Comms timeline */}
            <section>
              <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Activity
              </div>
              <div className="rounded-2xl border border-border bg-surface p-3">
                {timeline.length === 0 ? (
                  <p className="px-1 py-6 text-center text-body text-faint">No messages or delegations yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {timeline.map((item) => {
                      const badge = kindBadge(item);
                      return (
                        <li key={item.key} className="border-b border-border pb-3 last:border-0 last:pb-0">
                          <div className="flex items-center justify-between gap-2 text-caption">
                            <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                              {item.kind === 'delegation' ? <Repeat className="h-3 w-3 text-faint" /> : <ArrowRight className="h-3 w-3 text-faint" />}
                              {item.from} <ArrowRight className="h-3 w-3 text-faint" /> {item.to}
                            </span>
                            <span className="text-faint">{relativeTime(item.time)}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-small text-muted">{item.text}</p>
                          <div className="mt-1">
                            <StatusPill tone={badge.tone}>{item.status ? `${badge.label} · ${item.status}` : badge.label}</StatusPill>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {openAgent && (
        <AgentTraceDrawer
          agent={openAgent}
          onClose={() => setOpenSlug(null)}
          onEdit={() => setForm({ mode: 'edit', slug: openAgent.slug })}
          onChanged={refetchAgents}
        />
      )}

      {form && (
        <AgentForm
          mode={form.mode}
          agent={formAgent}
          allAgents={agents}
          catalog={catalogQ.data}
          onClose={() => setForm(null)}
          onSaved={(saved) => { refetchAgents(); setForm(null); setOpenSlug(saved.slug); }}
        />
      )}
    </Page>
  );
}
