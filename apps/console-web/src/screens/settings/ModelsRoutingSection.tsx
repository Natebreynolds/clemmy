import { Card } from '@/components/ui/Card';
import { ModelRolesCard } from './ModelRolesCard';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { CodexLoginForm } from './CodexLoginForm';
import { ConnectedModelsStrip } from './ConnectedModelsStrip';

/**
 * The ONE model section, in two plain halves:
 *
 *   1. ASSIGN — the dropdowns ARE the controls. The Brain/Workers/Judge pickers
 *      (ModelRolesCard) are the single way to choose which connected model fills
 *      each lane. No separate "run on Claude" toggle anywhere.
 *   2. CONNECT — how a model becomes available to those dropdowns. Two ways,
 *      surfaced side by side: Codex + Claude sign in with your subscription
 *      (OAuth); everything else (GLM, DeepSeek, …) connects with an API key.
 *
 * Everything model-related lives here so Settings has one place to wire models
 * instead of 4–5 overlapping cards.
 */
export function ModelsRoutingSection() {
  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Models &amp; routing</h3>
      <p className="mb-4 text-small text-muted">
        Pick which connected model is the brain and which serve workers and the judge/checker — the
        dropdowns below are the only control. You can also just tell Clementine in chat (“use DeepSeek
        for the workers”, “make the judge Opus”). Applies on the next message; no restart.
      </p>

      <ModelRolesCard embedded />

      <div className="mt-6 border-t border-border pt-5">
        <h4 className="mb-1 text-label text-fg">Connect models</h4>
        <p className="mb-4 text-small text-muted">
          Codex and Claude sign in with your subscription (OAuth). Everything else connects with an API key.
          Whatever you connect here shows up in the dropdowns above.
        </p>

        <div className="space-y-4">
          {/* Subscriptions — OAuth sign-ins, side by side. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-canvas p-4">
              <CodexLoginForm embedded />
            </div>
            <div className="rounded-lg border border-border bg-canvas p-4">
              <ClaudeLoginForm embedded />
            </div>
          </div>

          {/* API-key models (GLM, DeepSeek, MiniMax, any OpenAI-compatible endpoint). */}
          <ConnectedModelsStrip />
        </div>
      </div>
    </Card>
  );
}
