import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * Temporary screen placeholder for the staged migration. Each real screen
 * replaces its stub in a later phase; until then this keeps the IA
 * navigable and on-brand instead of showing a blank route.
 */
export function Stub({ title, subtitle, blurb }: { title: string; subtitle: string; blurb: string }) {
  return (
    <Page title={title} subtitle={subtitle}>
      <Card>
        <EmptyState title="Coming together" description={blurb} />
      </Card>
    </Page>
  );
}
