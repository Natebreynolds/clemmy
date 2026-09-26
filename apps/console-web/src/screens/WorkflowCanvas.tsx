/**
 * The graph now lives on the workflow's own page (/automate/:name). This
 * screen keeps the two older addresses working: a workflow's old canvas link
 * forwards to its page, and /advanced/canvas still offers the list.
 */
import { Link, Navigate, useParams } from 'react-router-dom';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import { listWorkflows } from '@/lib/automate';

export function WorkflowCanvas() {
  const { name } = useParams<{ name: string }>();
  return name ? <Navigate to={`/automate/${encodeURIComponent(name)}`} replace /> : <CanvasPicker />;
}

/** Without a workflow in the path there is nothing to draw, so offer a list. */
function CanvasPicker() {
  const workflows = usePoll(['workflows'], listWorkflows, 10000);
  const rows = workflows.data?.workflows ?? [];

  return (
    <Page title="Canvas" subtitle="Open a workflow to see it as a graph and change how its steps depend on each other.">
      {workflows.isPending ? (
        <Skeleton className="h-40" />
      ) : workflows.isError ? (
        <QueryUnavailable
          title="Workflows are unavailable"
          description="Clementine couldn’t load your workflows, so this is not an empty list. Nothing has been deleted."
          onRetry={() => { void workflows.refetch(); }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description="Create one with Clementine first, then open it here to see its shape."
          action={
            <Link to="/automate/new">
              <Button>Create a workflow</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((w) => (
            <Link key={w.name} to={`/automate/${encodeURIComponent(w.name)}`}>
              <Card className="h-full p-4 transition-colors hover:bg-hover">
                <div className="text-body font-medium text-fg">{w.name}</div>
                {w.description ? (
                  <div className="mt-1 line-clamp-2 text-small text-muted">{w.description}</div>
                ) : null}
                <div className="mt-2 text-caption text-faint">
                  {w.stepCount ?? 0} {w.stepCount === 1 ? 'step' : 'steps'}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}
