/**
 * The agents roster. An agent is a specialized working context you open and
 * work in — a name, what it handles, standing instructions, and what it
 * reaches for first. Each card opens that agent's workspace (/agents/:id).
 * Drafts Clem proposed in conversation wait here until you create or dismiss
 * them.
 */
import { modelDisplayName } from '@clem/chat-engine';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, CheckCircle2, XCircle, ChevronRight } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { AgentForm } from '@/components/agents/AgentForm';
import {
  listAgents, getAgentCatalog, agentReachSummary,
  listAgentProposals, approveAgentProposal, rejectAgentProposal,
  type AgentRecord, type AgentCatalog, type AgentProposal,
} from '@/lib/agents';

function modelLabel(catalog: AgentCatalog | undefined, model: string | null): string | null {
  if (!model) return null;
  return catalog?.models?.find((m) => m.id === model)?.label ?? modelDisplayName(model);
}

function AgentCard({ agent, catalog }: { agent: AgentRecord; catalog?: AgentCatalog }) {
  const chips = agentReachSummary(agent, modelLabel(catalog, agent.model));
  return (
    <Link
      to={`/agents/${encodeURIComponent(agent.id)}`}
      className="flex flex-col gap-2 rounded-2xl border border-border-raised bg-raised p-4 text-left transition-colors duration-base hover:border-border-strong hover:bg-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-body-lg font-semibold text-fg">{agent.name}</div>
          <p className="line-clamp-2 text-small text-muted">{agent.handles || 'No description yet.'}</p>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-faint" aria-hidden />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.length === 0
          ? <span className="text-caption text-faint">Reaches for whatever Clem would</span>
          : chips.map((chip) => (
            <span key={chip} className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">{chip}</span>
          ))}
      </div>
    </Link>
  );
}

/** Agents Clem proposed mid-conversation. Compact: name, why, create or dismiss. */
function Drafts({
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
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold text-faint">
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Drafts from Clem
        <StatusPill tone="info" className="ml-1">{proposals.length}</StatusPill>
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-small text-danger" role="alert">
          {error}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {proposals.map((proposal) => {
          const busy = busyId === proposal.id;
          const summary = proposal.agent.handles || proposal.agent.description || '';
          return (
            <div key={proposal.id} className="rounded-md border border-border bg-surface p-3">
              <div className="truncate text-small font-semibold text-fg">{proposal.agent.name}</div>
              {summary && <p className="mt-0.5 line-clamp-2 text-small text-muted">{summary}</p>}
              <p className="mt-1 line-clamp-2 text-caption text-faint">{proposal.rationale}</p>
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => onReject(proposal)} disabled={busy}>
                  <XCircle className="h-4 w-4" /> Not now
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

export function Agents() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const agentsQ = usePoll(['agents'], listAgents, 10_000);
  const catalogQ = usePoll(['agents', 'catalog'], getAgentCatalog, 30_000);
  const proposalsQ = usePoll(['agents', 'proposals'], () => listAgentProposals('pending', 20), 15_000);
  const [creating, setCreating] = useState(false);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);

  const agents = agentsQ.data ?? [];
  const proposals = proposalsQ.data ?? [];

  const refetchAgents = () => { void qc.invalidateQueries({ queryKey: ['agents'] }); };
  const refetchProposals = () => { void qc.invalidateQueries({ queryKey: ['agents', 'proposals'] }); };

  const approveProposal = async (proposal: AgentProposal) => {
    setProposalBusyId(proposal.id);
    setProposalError(null);
    try {
      const result = await approveAgentProposal(proposal.id);
      refetchAgents();
      refetchProposals();
      if (result.agent?.id) navigate(`/agents/${encodeURIComponent(result.agent.id)}`);
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

  const loading = agentsQ.isLoading && agents.length === 0;
  const newAgent = (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus className="h-4 w-4" /> New agent
    </Button>
  );

  return (
    <Page
      title="Agents"
      subtitle="Specialized places to work: each one starts every thread with its own instructions and the skills, workflows and tools it reaches for first."
      actions={newAgent}
    >
      <Drafts
        proposals={proposals}
        busyId={proposalBusyId}
        onApprove={approveProposal}
        onReject={rejectProposal}
        error={proposalError}
      />

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      ) : agentsQ.isError && !agentsQ.data ? (
        <QueryUnavailable
          title="Your agents are unavailable"
          description="Clementine couldn’t load them just now. Nothing has been removed."
          onRetry={() => { void agentsQ.refetch(); }}
        />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="An agent is a working context you open for one kind of work — it starts every thread with your standing instructions and reaches for the skills and workflows you chose."
          action={newAgent}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => <AgentCard key={agent.id} agent={agent} catalog={catalogQ.data} />)}
        </div>
      )}

      {creating && (
        <AgentForm
          mode="create"
          catalog={catalogQ.data}
          onClose={() => setCreating(false)}
          onSaved={(saved) => {
            refetchAgents();
            setCreating(false);
            navigate(`/agents/${encodeURIComponent(saved.id)}`);
          }}
        />
      )}
    </Page>
  );
}
