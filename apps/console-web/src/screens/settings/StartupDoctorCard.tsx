import { Activity, AlertTriangle, CheckCircle2, RefreshCw, ServerCog, Terminal } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { getStartupDoctor, type NativeDependencyCheck, type StartupDoctor, type StartupDoctorIssue, type StartupDoctorStatus } from '@/lib/startup-doctor';

function toneForStatus(status: StartupDoctorStatus): Tone {
  if (status === 'ok') return 'success';
  if (status === 'warning') return 'warning';
  return 'danger';
}

function labelForStatus(status: StartupDoctorStatus) {
  if (status === 'ok') return 'Ready';
  if (status === 'warning') return 'Warning';
  return 'Fix needed';
}

function formatTime(value?: string) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function RuntimeFact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0 rounded-sm bg-subtle px-3 py-2">
      <div className="text-caption text-faint">{label}</div>
      <div className="truncate text-small font-semibold text-fg">{value || 'Not detected'}</div>
    </div>
  );
}

function NativeRow({ dep }: { dep: NativeDependencyCheck }) {
  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-small font-semibold text-fg">{dep.name}</div>
          <div className="truncate text-caption text-faint">
            {dep.version ? `v${dep.version}` : dep.installed ? 'Installed' : 'Missing'} · ABI check
          </div>
        </div>
        <StatusPill tone={toneForStatus(dep.status)}>{dep.loaded ? 'Loaded' : labelForStatus(dep.status)}</StatusPill>
      </div>
      {dep.issue?.command && (
        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-sm bg-subtle px-2.5 py-2 text-caption text-muted">
          <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <code className="truncate">{dep.issue.command}</code>
        </div>
      )}
    </li>
  );
}

function IssueRow({ issue }: { issue: StartupDoctorIssue }) {
  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-small font-semibold text-fg">{issue.title}</div>
          <div className="mt-0.5 text-caption text-muted">{issue.detail}</div>
          {issue.fix && <div className="mt-1 text-caption text-faint">{issue.fix}</div>}
        </div>
      </div>
    </li>
  );
}

function StartupDoctorBody({ data }: { data: StartupDoctor }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <RuntimeFact label="Node" value={`${data.runtime.node} · ABI ${data.runtime.nodeModuleVersion}`} />
        <RuntimeFact label="Electron" value={data.runtime.electron ?? data.package.electronVersion ?? 'Not in this process'} />
        <RuntimeFact label="Platform" value={`${data.runtime.platform}/${data.runtime.arch}`} />
        <RuntimeFact label="Package" value={`${data.package.name}@${data.package.version}`} />
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-small font-semibold text-fg">
          <ServerCog className="h-4 w-4 text-muted" aria-hidden /> Native modules
        </div>
        {data.nativeDependencies.length === 0 ? (
          <div className="rounded-md border border-border px-3 py-3 text-small text-muted">No native dependencies detected.</div>
        ) : (
          <ul className="space-y-2">
            {data.nativeDependencies.map((dep) => <NativeRow key={dep.name} dep={dep} />)}
          </ul>
        )}
      </div>

      {data.issues.length > 0 ? (
        <div>
          <div className="mb-2 text-small font-semibold text-fg">Startup blockers</div>
          <ul className="space-y-2">
            {data.issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
          </ul>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success-tint px-3 py-3 text-small text-success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Runtime and native module checks are passing.</span>
        </div>
      )}
    </div>
  );
}

export function StartupDoctorCard() {
  const doctor = usePoll(['startup-doctor'], getStartupDoctor, 15000);
  const data = doctor.data;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg">
            <Activity className="h-5 w-5 text-muted" aria-hidden /> Startup doctor
          </h3>
          <p className="text-small text-muted">Node, Electron, and native dependency readiness.</p>
          {data && <p className="mt-1 text-caption text-faint">Last checked {formatTime(data.generatedAt)}</p>}
        </div>
        <div className="flex items-center gap-2">
          {data && <StatusPill tone={toneForStatus(data.status)}>{labelForStatus(data.status)}</StatusPill>}
          <Button variant="secondary" size="sm" onClick={() => void doctor.refetch()} disabled={doctor.isFetching}>
            <RefreshCw className={doctor.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {doctor.isLoading && !data ? <Skeleton className="h-48 w-full" /> : data ? <StartupDoctorBody data={data} /> : null}
    </Card>
  );
}
