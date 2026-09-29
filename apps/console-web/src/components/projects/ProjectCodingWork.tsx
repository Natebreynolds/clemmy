/**
 * Coding work started from this project's conversations: what each run is
 * for, which local project it works in, where it stands, and the
 * conversation it came from. It is a list to read; a coding run is followed
 * and stopped where it already is, so nothing here controls one. With no
 * runs, nothing is drawn.
 */
import { Link } from 'react-router-dom';
import { projectCodingRunPhase, projectCodingRunPlace } from '@clem/chat-engine';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { relativeTime } from '@/lib/inbox';
import { conversationPath, type ProjectCodingRunView } from '@/lib/projects';

const PILL_TONE: Record<ReturnType<typeof projectCodingRunPhase>['tone'], Tone> = {
  neutral: 'neutral', live: 'live', info: 'info', success: 'success',
};

export function ProjectCodingWork({ runs }: { runs: readonly ProjectCodingRunView[] }) {
  if (runs.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1.5 text-label text-faint">Coding work</h4>
      <ul className="overflow-hidden rounded-lg border border-border bg-surface">
        {runs.map((run) => {
          const phase = projectCodingRunPhase(run.phase);
          const changed = relativeTime(run.updatedAt);
          return (
            <li key={run.runId} className="border-t border-border px-5 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusPill tone={PILL_TONE[phase.tone]}>{phase.label}</StatusPill>
                <span className="min-w-0 flex-1 text-body font-semibold text-fg">
                  <span className="line-clamp-2">{run.objective?.trim() || 'Coding work'}</span>
                </span>
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
                <span>
                  {projectCodingRunPlace(run)}
                  {changed ? ` · ${changed === 'now' ? 'just now' : `${changed} ago`}` : ''}
                </span>
                {run.originSessionId && (
                  <Link to={conversationPath(run.originSessionId)} className="font-semibold text-primary hover:underline">
                    Open the conversation it came from
                  </Link>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
