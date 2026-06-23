/**
 * Multi-agent workspace (slice 1, read-only). Surfaces the team-agent
 * system that already runs under the hood: the roster, the canMessage
 * graph with live message pulses, a comms/delegation timeline, and a
 * click-into per-agent run trace. Pure reads over /api/console/agents.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Users, MessageSquare, ArrowRight, Send, Inbox, Repeat, Clock, Plus, BookOpen, Workflow } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
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
  type AgentSummary, type TeamMessage, type Delegation,
} from '@/lib/agents';

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

export function Agents() {
  const qc = useQueryClient();
  const agentsQ = usePoll(['agents'], listAgents, 4000);
  const graphQ = usePoll(['agents', 'graph'], getAgentGraph, 4000);
  const commsQ = usePoll(['agents', 'comms'], () => getAgentComms(60), 4000);
  const catalogQ = usePoll(['agents', 'catalog'], getAgentCatalog, 30000);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; slug?: string } | null>(null);

  const agents = agentsQ.data ?? [];
  const openAgent = agents.find((a) => a.slug === openSlug) ?? null;
  const formAgent = form?.slug ? agents.find((a) => a.slug === form.slug) : undefined;

  const refetchAgents = () => { void qc.invalidateQueries({ queryKey: ['agents'] }); };

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
