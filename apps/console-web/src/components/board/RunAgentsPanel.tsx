/**
 * "Agents" panel — every specialized agent a workflow run spawned via fan-out,
 * across ALL three brains (Claude / Codex / GLM-BYO), read from the provider-
 * agnostic subagent-runs store. Shows WHO ran (provider + role + model), their
 * OUTCOME, and — on click — WHAT they did (the persisted work-product).
 *
 * "Agents you can't see are agents you can't manage": this is where a workflow's
 * swarm becomes inspectable after the fact, not just a live rail.
 *
 * A step-per-agent run (one agent per step, each just echoing its stepId) is not
 * a real fan-out — it mirrors the step timeline above. We detect that shape and
 * collapse the whole panel behind a summary line so it doesn't read as noise;
 * a genuine fan-out (multiple agents on a step, or a distinct task) stays open.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import { listRunAgents, getRunAgentOutput, type RunAgent } from '@/lib/board';
import { cn } from '@/lib/cn';

const PROVIDER_LABEL: Record<RunAgent['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  byo: 'BYO',
  glm: 'GLM',
  unknown: 'Agent',
};
// Provider identity via an inline-styled dot so it renders regardless of the
// Tailwind palette; status uses semantic tokens.
const PROVIDER_DOT: Record<RunAgent['provider'], string> = {
  claude: '#d97757',
  codex: '#10a37f',
  byo: '#4f8fc0',
  glm: '#7c6cf0',
  unknown: '#8a8f98',
};
const STATUS: Record<RunAgent['status'], { glyph: string; className: string; title: string }> = {
  ok: { glyph: '✓', className: 'text-success', title: 'completed' },
  error: { glyph: '✕', className: 'text-danger', title: 'failed' },
  capped: { glyph: '⏳', className: 'text-warning', title: 'hit its turn cap' },
};

/** A row is a bare "step echo" when its task is just the stepId repeated
 *  (the degenerate 'seo_fanout: seo_fanout' label), i.e. no real work label. */
function isStepEcho(a: RunAgent): boolean {
  return Boolean(a.stepId) && a.task === a.stepId;
}

/** The agent's work label, dropping a role prefix that only echoes the task. */
function agentLabel(a: RunAgent): string {
  if (a.role && a.role !== a.task) return `${a.role}: ${a.task}`;
  return a.task;
}

interface AgentGroup {
  stepId?: string;
  agents: RunAgent[];
}

function groupByStep(agents: RunAgent[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  const index = new Map<string, number>();
  for (const a of agents) {
    // Agents without a stepId each stand alone (never merged under a header).
    const key = a.stepId ?? `__nostep__${a.id}`;
    let i = index.get(key);
    if (i === undefined) { i = groups.length; index.set(key, i); groups.push({ stepId: a.stepId, agents: [] }); }
    groups[i].agents.push(a);
  }
  return groups;
}

export function RunAgentsPanel({ slug, runId }: { slug: string; runId: string }) {
  const poll = usePoll(['run-agents', slug, runId], () => listRunAgents(slug, runId), 4000);
  const agents = poll.data?.agents ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [output, setOutput] = useState<Record<string, string>>({});
  // null = follow the default (open unless it's a pure mirror of the steps);
  // a boolean = the user explicitly toggled. Deriving avoids a stale initial
  // value when the agents arrive on a later poll.
  const [expandOverride, setExpandOverride] = useState<boolean | null>(null);

  if (agents.length === 0) return null;

  const groups = groupByStep(agents);
  // Pure step-echo: exactly one agent per step AND every agent just echoes its
  // stepId → the panel would duplicate the step timeline with degenerate labels.
  const stepEcho = groups.every((g) => g.agents.length === 1) && agents.every(isStepEcho);
  const expanded = expandOverride ?? !stepEcho;

  const toggle = async (a: RunAgent) => {
    if (openId === a.id) { setOpenId(null); return; }
    setOpenId(a.id);
    if (output[a.id] === undefined && a.outputRef) {
      try {
        const r = await getRunAgentOutput(slug, runId, a.id);
        setOutput((prev) => ({ ...prev, [a.id]: r.output }));
      } catch { setOutput((prev) => ({ ...prev, [a.id]: '(work-product unavailable)' })); }
    }
  };

  const renderAgent = (a: RunAgent, showLabel: boolean) => {
    const st = STATUS[a.status];
    const isOpen = openId === a.id;
    const body = a.outputRef ? (output[a.id] ?? 'Loading work-product…') : (a.outputPreview || 'No work-product recorded.');
    return (
      <li key={a.id} className="rounded-lg border border-border/60 bg-surface">
        <button type="button" onClick={() => void toggle(a)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_DOT[a.provider] ?? PROVIDER_DOT.unknown }} aria-hidden />
            <span className="text-caption font-medium text-muted">{PROVIDER_LABEL[a.provider] ?? 'Agent'}</span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-fg">{showLabel ? agentLabel(a) : a.task}</span>
            {a.model && <span className="block truncate text-caption text-faint">{a.model}</span>}
          </span>
          <span className={cn('shrink-0 text-body', st.className)} title={st.title} aria-label={st.title}>{st.glyph}</span>
        </button>
        {isOpen && (
          <div className="border-t border-border/60 px-3 py-2">
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-caption text-muted">{body}</p>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpandOverride(!expanded)}
          className="inline-flex items-center gap-1 text-caption font-semibold uppercase tracking-wide text-muted hover:text-fg"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} aria-hidden />
          Agents · {agents.length}{stepEcho ? ' — mirror of steps' : ''}
        </button>
        {expanded && Object.entries(poll.data?.byProvider ?? {}).map(([p, n]) => (
          <span key={p} className="inline-flex items-center gap-1 text-caption text-faint">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_DOT[p as RunAgent['provider']] ?? PROVIDER_DOT.unknown }} aria-hidden />
            {PROVIDER_LABEL[p as RunAgent['provider']] ?? p} {n}
          </span>
        ))}
      </div>
      {expanded && (
        <ul className="flex flex-col gap-1.5">
          {groups.map((g) =>
            // Real fan-out on a step (>1 agent): a single step header, rows nested.
            g.agents.length > 1 && g.stepId ? (
              <li key={g.stepId} className="rounded-lg border border-border/60 bg-surface/40 p-1.5">
                <div className="px-1.5 py-1 text-caption font-semibold text-muted">{g.stepId} · {g.agents.length}</div>
                <ul className="flex flex-col gap-1.5">
                  {g.agents.map((a) => renderAgent(a, true))}
                </ul>
              </li>
            ) : (
              g.agents.map((a) => renderAgent(a, !stepEcho))
            ),
          )}
        </ul>
      )}
    </section>
  );
}
