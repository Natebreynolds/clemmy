import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PROVIDER_DOT } from '@/components/chat/ActivityFeed';
import { PROVIDER_LABEL, useModelRoles } from '@/lib/model-roles';
import { ModelRolesCard } from './ModelRolesCard';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { CodexLoginForm } from './CodexLoginForm';
import { XaiLoginForm } from './XaiLoginForm';
import { ConnectedModelsStrip } from './ConnectedModelsStrip';

/** Settings › Models: who thinks, who does the legwork, who checks. */
export function ModelsSection({ sessionId }: { sessionId?: string } = {}) {
  return (
    <section id="models" className="scroll-mt-16">
      <h2 className="mb-1 text-h2 text-fg">Models</h2>
      <p className="mb-3 text-small text-muted">Who thinks, who does the legwork, who checks. Change any of these mid-conversation from the chip beside the composer.</p>
      <ModelRolesCard sessionId={sessionId} />
    </section>
  );
}

/** Settings › Connected: one chip per account; sign-ins and keys behind one disclosure. */
export function ConnectedSection() {
  const r = useModelRoles();
  const [open, setOpen] = useState(false);
  const mr = r.mr;
  const groups = mr?.available ?? [];
  const claude = r.claudeAuth;
  const chips: Array<{ key: string; provider: string; label: string; detail: string; on: boolean }> = [];
  const claudeModels = groups.find((g) => g.provider === 'claude')?.models ?? [];
  chips.push({ key: 'claude', provider: 'claude', label: 'Claude', on: Boolean(claude?.configured), detail: claude?.configured ? (claudeModels.length ? claudeModels.slice(0, 2).map((m) => m.label).join(', ') : 'signed in') : 'not signed in' });
  const codexModels = groups.find((g) => g.provider === 'codex')?.models ?? [];
  chips.push({ key: 'codex', provider: 'codex', label: 'Codex', on: codexModels.length > 0, detail: codexModels.length ? `${codexModels.length} model${codexModels.length === 1 ? '' : 's'}` : 'not signed in' });
  for (const g of groups) {
    if (g.provider === 'claude' || g.provider === 'codex') continue;
    chips.push({ key: `${g.provider}:${g.label}`, provider: g.provider, label: g.label, on: g.models.length > 0, detail: g.models.length ? `API key · ${g.models.slice(0, 2).map((m) => m.label).join(', ')}` : 'no models' });
  }
  return (
    <section id="connected" className="scroll-mt-16">
      <h2 className="mb-1 text-h2 text-fg">Connected</h2>
      <p className="mb-3 text-small text-muted">Sign in once; every model from that account shows up above.</p>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <span key={c.key} className={cn('inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-2.5 pr-3 text-small', !c.on && 'text-faint')}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PROVIDER_DOT[(c.provider as keyof typeof PROVIDER_DOT)] ?? PROVIDER_DOT.unknown, opacity: c.on ? 1 : 0.4 }} aria-hidden />
            <span className="font-semibold text-fg">{c.label}</span>
            <span className="text-caption">{c.detail}</span>
          </span>
        ))}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-small text-muted hover:text-fg">
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
          {open ? 'Hide sign-ins and keys' : 'Sign in, add a key, or manage'}
        </button>
      </div>
      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-canvas p-4"><CodexLoginForm embedded /></div>
            <div className="rounded-lg border border-border bg-canvas p-4"><ClaudeLoginForm embedded /></div>
            <div className="rounded-lg border border-border bg-canvas p-4"><XaiLoginForm embedded /></div>
          </div>
          <ConnectedModelsStrip />
        </div>
      )}
      <p className="mt-2 text-caption text-faint">{groups.length} provider{groups.length === 1 ? '' : 's'} · {PROVIDER_LABEL.byo} models come from Connect › Keys</p>
    </section>
  );
}
