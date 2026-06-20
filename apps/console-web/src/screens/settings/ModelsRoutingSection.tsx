import type { ReactNode } from 'react';
import { ChevronRight, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { usePoll } from '@/lib/poll';
import { getSettings } from '@/lib/settings';
import { ModelRolesCard } from './ModelRolesCard';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { CodexLoginForm } from './CodexLoginForm';
import { ConnectedModelsStrip } from './ConnectedModelsStrip';

/**
 * The ONE model section. Everything model-related lives here so the Settings
 * page has a single place to "outline the models" instead of 4–5 overlapping
 * cards. The routing rows (brain/worker/judge) are the visible core — the
 * "available models for routing"; provider connection (Claude login + an
 * alternative backend) and fusion are tucked into disclosures because they feed
 * routing rather than being it. The brain is set ONCE (in the routing rows);
 * the old duplicate brain pickers in fusion/backend are gone.
 */
function Disclosure({ summary, hint, children }: { summary: string; hint?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-canvas">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-label text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
        <span>{summary}</span>
        {hint && <span className="truncate text-caption text-muted">· {hint}</span>}
      </summary>
      <div className="space-y-6 border-t border-border p-4">{children}</div>
    </details>
  );
}

export function ModelsRoutingSection() {
  const settings = usePoll(['settings'], getSettings, 0);
  const available = settings.data?.modelRoles?.available ?? [];

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Models &amp; routing</h3>
      <p className="mb-4 text-small text-muted">
        Your available models for routing — pick which one is the brain and which serve workers and the
        judge/checker. You can also just tell Clementine in chat (“use DeepSeek for the workers”, “make
        the judge Opus”). Applies on the next message; no restart.
      </p>

      {available.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
          <span className="text-fg">Connected:</span>
          {available.map((p) => (
            <span key={p.provider} className="inline-flex items-center gap-1">
              <Check className="h-3.5 w-3.5 text-success" aria-hidden />
              {p.label || p.provider}
            </span>
          ))}
        </div>
      )}

      <ModelRolesCard embedded />

      <div className="mt-5 space-y-4">
        {/* API-key models, surfaced (no longer buried in a disclosure) — add one
            and it lands in the pickers above with instant status feedback. */}
        <ConnectedModelsStrip />

        <Disclosure summary="Sign in to Codex / Claude" hint="subscription logins (OAuth)">
          <CodexLoginForm embedded />
          <ClaudeLoginForm embedded />
        </Disclosure>
      </div>
    </Card>
  );
}
