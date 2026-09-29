/**
 * What the project uses: the local projects its work happens in, the
 * accounts that work goes through, and the Spaces, workflows and links that
 * belong to it.
 *
 * An account is bound only from what is connected right now, and says
 * whether that was checked. Everything else is a pointer the owner attached.
 * Attaching and removing change the project's record and nothing else: no
 * account is connected or disconnected from here.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleDashed, FolderGit2, Plus } from 'lucide-react';
import {
  groupProjectResources, projectResourceApp, projectResourceKindLabel, projectResourceName, projectResourceVerification,
} from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { listWorkflows } from '@/lib/automate';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import {
  attachResource, bindAccount, getConnectedApps, projectKeys, refusalText, removeResource,
  type ProjectAccountChoice, type ProjectConnectedApp, type ProjectOverview, type ProjectResourceKind, type ProjectResourceView,
} from '@/lib/projects';
import { listSpaces } from '@/lib/spaces';
import { LinkLocalProject, LocalProjectRow } from './LocalProjects';
import { ProjectSection, QuietNote } from './ProjectSection';

const KINDS: ProjectResourceKind[] = ['folder', 'account', 'space', 'workflow', 'link'];

function appName(toolkit: string | null, apps: readonly ProjectConnectedApp[]): string {
  if (!toolkit) return '';
  return apps.find((app) => app.toolkit.toLowerCase() === toolkit.toLowerCase())?.name || toolkit;
}

function checkedOn(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

function ResourceRow({ projectId, resource, readOnly, onSaved }: {
  projectId: string;
  resource: ProjectResourceView;
  readOnly: boolean;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = projectResourceName(resource);
  const verification = projectResourceVerification(resource);
  const isLink = resource.kind === 'link' && /^https?:\/\//i.test(resource.ref ?? '');
  // An account says which app it belongs to, by the app's written name.
  const sub = resource.kind === 'account'
    ? projectResourceApp(resource)
    : resource.ref && resource.ref !== name ? resource.ref : '';

  const remove = async () => {
    setBusy(true);
    setError('');
    try { onSaved(await removeResource(projectId, resource.id)); }
    catch (failure) { setError(refusalText(failure, 'It could not be removed. Try again.')); setBusy(false); }
  };

  return (
    <li className="border-t border-border px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {resource.kind === 'space' && resource.ref ? (
              <Link to={`/workspaces/${encodeURIComponent(resource.ref)}`} className="truncate text-body font-semibold text-fg hover:text-primary hover:underline">{name}</Link>
            ) : resource.kind === 'workflow' && resource.ref ? (
              <Link to={`/automate/${encodeURIComponent(resource.ref)}`} className="truncate text-body font-semibold text-fg hover:text-primary hover:underline">{name}</Link>
            ) : isLink ? (
              <a href={resource.ref ?? undefined} target="_blank" rel="noreferrer noopener" className="truncate text-body font-semibold text-fg hover:text-primary hover:underline">{name}</a>
            ) : (
              <span className="truncate text-body font-semibold text-fg">{name}</span>
            )}
            {verification && (
              <span
                className={`inline-flex items-center gap-1 text-caption font-semibold ${verification.verified ? 'text-success' : 'text-warning'}`}
                title={verification.verified
                  ? `Checked against your connected accounts${checkedOn(resource.verifiedAt) ? ` on ${checkedOn(resource.verifiedAt)}` : ''}`
                  : 'Nobody has checked this against your connected accounts, so it is not used to pick an account'}
              >
                {verification.verified
                  ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
                {verification.label}
              </span>
            )}
          </div>
          {sub && <p className="truncate text-caption text-muted">{sub}</p>}
        </div>
        {!readOnly && !confirming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Remove ${name} from this project`}>Remove</Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm removing ${name}`}>
          <span className="text-small text-fg">
            {resource.kind === 'account'
              ? 'Stop using this account in this project? The account stays connected.'
              : `Remove this ${projectResourceKindLabel(resource.kind).toLowerCase()} from the project? It is not deleted.`}
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? 'Removing…' : 'Remove'}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-caption text-danger">{error}</p>}
    </li>
  );
}

type BindStep =
  | { step: 'pick' }
  | { step: 'not_connected' }
  | { step: 'conflict'; bound: ProjectAccountChoice; accountId: string };

function AddAccount({ projectId, onSaved, onClose }: {
  projectId: string;
  onSaved: (overview: ProjectOverview) => void;
  onClose: () => void;
}) {
  // Every app with an account connected right now, read each time this opens.
  const connected = usePoll(projectKeys.connectedApps, getConnectedApps, 0);
  const apps = connected.data ?? [];
  const appsLoading = connected.isLoading;
  const [toolkit, setToolkit] = useState('');
  const [accountId, setAccountId] = useState('');
  // Choices the server sent back when it needed one chosen; they are the
  // live list, so they replace whatever was read before.
  const [offered, setOffered] = useState<ProjectAccountChoice[] | null>(null);
  const [state, setState] = useState<BindStep>({ step: 'pick' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const accounts = offered ?? apps.find((row) => row.toolkit === toolkit)?.accounts ?? [];
  const chosen = accounts.find((account) => account.accountId === accountId) ?? (accounts.length === 1 ? accounts[0] : undefined);
  const app = appName(toolkit, apps);

  const pickApp = (slug: string) => {
    setToolkit(slug);
    setAccountId('');
    setOffered(null);
    setState({ step: 'pick' });
    setError('');
  };

  const bind = async (replace: boolean) => {
    if (!toolkit || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await bindAccount(projectId, { toolkit, ...(chosen ? { accountId: chosen.accountId } : {}), ...(replace ? { replace: true } : {}) });
      if (result.kind === 'bound') { onSaved(result.overview); onClose(); return; }
      if (result.kind === 'choose') { setOffered(result.accounts); setAccountId(''); setState({ step: 'pick' }); setError('Choose which account this project uses.'); }
      if (result.kind === 'not_connected') setState({ step: 'not_connected' });
      if (result.kind === 'conflict') setState({ step: 'conflict', bound: result.bound, accountId: chosen?.accountId ?? '' });
    } catch (failure) {
      setError(refusalText(failure, 'The account could not be added. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (connected.isError && !connected.data) {
    return (
      <p role="alert" className="text-small text-danger">
        Your connected apps could not be read.{' '}
        <button type="button" className="font-semibold text-primary hover:underline cursor-pointer" onClick={() => { void connected.refetch(); }}>Try again</button>
      </p>
    );
  }
  if (!appsLoading && apps.length === 0) {
    return (
      <p className="text-small text-muted">
        No apps are connected yet. <Link to="/connect" className="font-semibold text-primary hover:underline">Connect one</Link>, then choose its account here.
      </p>
    );
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void bind(false); }}>
      <Field label="App">
        {(id) => (
          <Select id={id} value={toolkit} onChange={(event) => pickApp(event.target.value)} disabled={busy || appsLoading}>
            <option value="">{appsLoading ? 'Loading your apps…' : 'Choose an app'}</option>
            {apps.map((row) => <option key={row.toolkit} value={row.toolkit}>{row.name}</option>)}
          </Select>
        )}
      </Field>

      {toolkit && state.step !== 'conflict' && (
        accounts.length === 0 || state.step === 'not_connected' ? (
          <p className="mb-4 text-small text-muted" role="status">
            No account is connected for {app} right now.{' '}
            <Link to="/connect" className="font-semibold text-primary hover:underline">Connect one</Link>, then come back.
          </p>
        ) : accounts.length === 1 ? (
          <p className="mb-4 text-small text-fg">
            <span className="text-muted">Account: </span><span className="font-semibold">{accounts[0].label}</span>
          </p>
        ) : (
          <fieldset className="mb-4">
            <legend className="mb-1.5 text-label text-fg">Which account</legend>
            <div className="space-y-1">
              {accounts.map((account) => (
                <label key={account.accountId} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-small text-fg transition-colors hover:bg-hover has-[:checked]:border-primary has-[:checked]:bg-primary-tint">
                  <input
                    type="radio"
                    name="project-account"
                    value={account.accountId}
                    checked={accountId === account.accountId}
                    onChange={() => { setAccountId(account.accountId); setError(''); }}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="min-w-0 truncate">{account.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )
      )}

      {state.step === 'conflict' && (
        <div className="mb-4 rounded-md border border-warning/50 bg-warning-tint px-3 py-2.5" role="alertdialog" aria-label="Replace the account this project uses">
          <p className="text-small text-fg">
            This project already uses <span className="font-semibold">{state.bound.label}</span> for {app}.
            {chosen ? <> Replace it with <span className="font-semibold">{chosen.label}</span>?</> : ' Replace it?'}
          </p>
          <p className="mt-0.5 text-caption text-muted">Work in this project will use the new account from then on. Both accounts stay connected.</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => { void bind(true); }}>{busy ? 'Replacing…' : 'Replace'}</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setState({ step: 'pick' })}>Keep {state.bound.label}</Button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
      {state.step !== 'conflict' && (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !toolkit || accounts.length === 0 || (accounts.length > 1 && !chosen)}>
            {busy ? 'Adding…' : 'Use this account'}
          </Button>
        </div>
      )}
    </form>
  );
}

function AddPointer({ projectId, kind, taken, onSaved, onClose }: {
  projectId: string;
  kind: Exclude<ProjectResourceKind, 'account' | 'folder'>;
  /** What the project already lists of this kind. */
  taken: ReadonlySet<string>;
  onSaved: (overview: ProjectOverview) => void;
  onClose: () => void;
}) {
  const [ref, setRef] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const spaces = usePoll(['spaces'], listSpaces, 30_000, { enabled: kind === 'space' });
  const workflows = usePoll(['workflows'], listWorkflows, 30_000, { enabled: kind === 'workflow' });

  const options: Array<{ ref: string; label: string }> = kind === 'space'
    ? (spaces.data ?? []).filter((space) => space.status !== 'archived').map((space) => ({ ref: space.id, label: space.title }))
    : kind === 'workflow'
      ? (workflows.data?.workflows ?? []).map((workflow) => ({ ref: workflow.name, label: workflow.name }))
      : [];
  const open = options.filter((option) => !taken.has(option.ref));
  const listed = kind === 'space' || kind === 'workflow';
  const source = kind === 'space' ? spaces : workflows;
  const noun = projectResourceKindLabel(kind).toLowerCase();

  const attach = async () => {
    const value = ref.trim();
    if (!value || busy) return;
    if (kind === 'link' && !/^https?:\/\/\S+$/i.test(value)) { setError('A link starts with http:// or https://'); return; }
    setBusy(true);
    setError('');
    try {
      const name = listed ? options.find((option) => option.ref === value)?.label : label.trim();
      onSaved(await attachResource(projectId, { kind, ref: value, ...(name ? { label: name } : {}) }));
      onClose();
    } catch (failure) {
      setError(refusalText(failure, `The ${noun} could not be added. Try again.`));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void attach(); }}>
      {listed ? (
        source.isLoading ? <Skeleton className="mb-4 h-11 w-full" />
          : source.isError && !source.data ? (
            <p role="alert" className="mb-4 text-small text-danger">
              Your {noun}s could not be read.{' '}
              <button type="button" className="font-semibold text-primary hover:underline cursor-pointer" onClick={() => { void source.refetch(); }}>Try again</button>
            </p>
          ) : open.length === 0 ? (
            <p className="mb-4 text-small text-muted">
              {options.length === 0 ? `You have no ${noun}s yet.` : `Every ${noun} you have is already in this project.`}
            </p>
          ) : (
            <Field label={projectResourceKindLabel(kind)}>
              {(id) => (
                <Select id={id} value={ref} onChange={(event) => setRef(event.target.value)} disabled={busy}>
                  <option value="">Choose a {noun}</option>
                  {open.map((option) => <option key={option.ref} value={option.ref}>{option.label}</option>)}
                </Select>
              )}
            </Field>
          )
      ) : (
        <>
          <Field label="Address">
            {(id) => (
              <Input
                id={id}
                value={ref}
                onChange={(event) => { setRef(event.target.value); setError(''); }}
                placeholder="https://"
                disabled={busy}
                autoFocus
                inputMode="url"
              />
            )}
          </Field>
          <Field label="Name" hint="Optional. How you would refer to it.">
            {(id) => <Input id={id} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} disabled={busy} />}
          </Field>
        </>
      )}
      {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !ref.trim()}>{busy ? 'Adding…' : 'Add'}</Button>
      </div>
    </form>
  );
}

export function ProjectResources({ overview, onSaved }: {
  overview: ProjectOverview;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const archived = overview.project.status === 'archived';
  const [adding, setAdding] = useState<ProjectResourceKind | null>(null);
  const groups = groupProjectResources(overview.resources);

  return (
    <ProjectSection
      title="Accounts and resources"
      hint="Where this project’s work happens, the accounts it goes through, and what else belongs to it."
      action={!archived && adding === null && (
        <>
          <Button variant="secondary" size="sm" onClick={() => setAdding('folder')}>
            <FolderGit2 className="h-4 w-4" aria-hidden /> Link a local project
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAdding('account')}>
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </>
      )}
    >
      {groups.length === 0 && adding === null && (
        <QuietNote>Nothing attached. Work here uses whichever account Clem would normally pick, and asks when it is not clear. Link a local project to say where its files and code are.</QuietNote>
      )}

      {groups.map((group) => (
        <div key={group.kind}>
          <div className={`text-label text-faint ${group.hint ? '' : 'mb-1.5'}`}>{group.label}</div>
          {group.hint && <p className="mb-1.5 text-caption text-muted">{group.hint}</p>}
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {group.items.map((resource) => (group.kind === 'folder' ? (
              <LocalProjectRow
                key={resource.id}
                projectId={overview.project.id}
                resource={resource}
                readOnly={archived}
                onSaved={onSaved}
              />
            ) : (
              <ResourceRow
                key={resource.id}
                projectId={overview.project.id}
                resource={resource}
                readOnly={archived}
                onSaved={onSaved}
              />
            )))}
          </ul>
        </div>
      ))}

      {adding !== null && (
        <div className="rounded-lg border border-border bg-surface px-5 py-4">
          <div role="radiogroup" aria-label="What to add" className="mb-4 flex flex-wrap gap-1.5">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={adding === kind}
                onClick={() => setAdding(kind)}
                className={cn(
                  'rounded-full border px-3 py-1 text-small font-semibold transition-colors cursor-pointer',
                  adding === kind ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg',
                )}
              >
                {projectResourceKindLabel(kind)}
              </button>
            ))}
          </div>
          {adding === 'folder' ? (
            <LinkLocalProject
              projectId={overview.project.id}
              resources={overview.resources}
              onSaved={onSaved}
              onClose={() => setAdding(null)}
            />
          ) : adding === 'account' ? (
            <AddAccount
              projectId={overview.project.id}
              onSaved={onSaved}
              onClose={() => setAdding(null)}
            />
          ) : (
            <AddPointer
              key={adding}
              projectId={overview.project.id}
              kind={adding}
              taken={new Set(overview.resources.filter((resource) => resource.kind === adding).map((resource) => resource.ref ?? ''))}
              onSaved={onSaved}
              onClose={() => setAdding(null)}
            />
          )}
        </div>
      )}
    </ProjectSection>
  );
}
