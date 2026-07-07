/**
 * "Agents" panel — every specialized agent a workflow run spawned via fan-out,
 * across ALL three brains (Claude / Codex / GLM-BYO), read from the provider-
 * agnostic subagent-runs store. Shows WHO ran (provider + role + model), their
 * OUTCOME, and — on click — WHAT they did (the persisted work-product).
 *
 * "Agents you can't see are agents you can't manage": this is where a workflow's
 * swarm becomes inspectable after the fact, not just a live rail.
 */
import { useState } from 'react';
import { usePoll } from '@/lib/poll';
import { listRunAgents, getRunAgentOutput, type RunAgent } from '@/lib/board';
import { cn } from '@/lib/cn';

const PROVIDER_LABEL: Record<RunAgent['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  glm: 'GLM',
  unknown: 'Agent',
};
// Provider identity via an inline-styled dot so it renders regardless of the
// Tailwind palette; status uses semantic tokens.
const PROVIDER_DOT: Record<RunAgent['provider'], string> = {
  claude: '#d97757',
  codex: '#10a37f',
  glm: '#7c6cf0',
  unknown: '#8a8f98',
};
const STATUS: Record<RunAgent['status'], { glyph: string; className: string; title: string }> = {
  ok: { glyph: '✓', className: 'text-success', title: 'completed' },
  error: { glyph: '✕', className: 'text-danger', title: 'failed' },
  capped: { glyph: '⏳', className: 'text-warning', title: 'hit its turn cap' },
};

export function RunAgentsPanel({ slug, runId }: { slug: string; runId: string }) {
  const poll = usePoll(['run-agents', slug, runId], () => listRunAgents(slug, runId), 4000);
  const agents = poll.data?.agents ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [output, setOutput] = useState<Record<string, string>>({});

  if (agents.length === 0) return null;

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

  return (
    <section className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-muted">Agents · {agents.length}</h3>
        {Object.entries(poll.data?.byProvider ?? {}).map(([p, n]) => (
          <span key={p} className="inline-flex items-center gap-1 text-caption text-faint">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_DOT[p as RunAgent['provider']] ?? PROVIDER_DOT.unknown }} aria-hidden />
            {PROVIDER_LABEL[p as RunAgent['provider']] ?? p} {n}
          </span>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5">
        {agents.map((a) => {
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
                  <span className="block truncate text-body text-fg">{a.role ? `${a.role}: ` : ''}{a.task}</span>
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
        })}
      </ul>
    </section>
  );
}
