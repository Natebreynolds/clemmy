import { ModelRolesCard } from './ModelRolesCard';
import { ModelAccountsCard } from './ModelAccountsCard';

/**
 * Settings › Models — the one place for models: the accounts Clem runs on
 * (sign-ins, API keys, what each costs and where to add credit), adding a
 * model, and who does which job. Everything opens inline, so the owner never
 * goes to a second screen to connect, top up, or assign.
 */
export function ModelsSection({ sessionId }: { sessionId?: string } = {}) {
  return (
    <section id="models" className="scroll-mt-16">
      <h2 className="mb-1 text-h2 text-fg">Models</h2>
      <p className="mb-4 text-small text-muted">The accounts Clem runs on, what each is doing, and how much is left. When one runs out, its button opens the provider’s billing page.</p>
      <h3 id="accounts" className="mb-2 scroll-mt-16 text-h3 text-fg">Accounts</h3>
      <ModelAccountsCard />
      <h3 id="who-does-what" className="mb-1 mt-8 scroll-mt-16 text-h3 text-fg">Who does what</h3>
      <p className="mb-3 text-small text-muted">Change any of these mid-conversation from the chip beside the composer.</p>
      <ModelRolesCard sessionId={sessionId} />
    </section>
  );
}
