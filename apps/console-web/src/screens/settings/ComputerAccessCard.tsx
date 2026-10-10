import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HardDrive, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import {
  getComputerAccess,
  openComputerAccessPage,
  requestFolderAccess,
  setComputerAccess,
  type ComputerAccessChoice,
  type ComputerAccessStatus,
  type FolderAccessResult,
} from '@/lib/settings';

const CHOICES: { id: ComputerAccessChoice; title: string; body: string; recommended?: boolean }[] = [
  {
    id: 'full',
    title: 'Full access',
    body: 'Open, read and edit any of your files, look at pictures anywhere in your folders, and run commands in any folder.',
    recommended: true,
  },
  {
    id: 'standard',
    title: 'Standard',
    body: 'Works in your files the same way, but looks at pictures only when you attach them.',
  },
];

/**
 * The owner decides once what Clem can reach on this computer, so a task never
 * stops halfway on a system prompt. The choice sets Clem's own rules; the
 * rows below show the operating system's gates and open the page that grants
 * them, because no app can grant those itself.
 */
export function ComputerAccessCard() {
  const qc = useQueryClient();
  const query = usePoll(['computer-access'], getComputerAccess, 0);
  const access = query.data?.access;
  const [saving, setSaving] = useState(false);

  const choose = async (choice: ComputerAccessChoice) => {
    if (!access || access.choice === choice) return;
    setSaving(true);
    try {
      const next = await setComputerAccess(choice);
      qc.setQueryData(['computer-access'], next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-start gap-3">
        <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">What Clem can reach</h3>
          <p className="text-small text-muted">Decide once, so a task never stops halfway to ask for a folder.</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Computer access" className="grid gap-3 sm:grid-cols-2">
        {CHOICES.map((option) => {
          const selected = access?.choice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!access || saving}
              onClick={() => void choose(option.id)}
              className={cn(
                'flex flex-col gap-1 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-60',
                selected ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:bg-subtle',
              )}
            >
              <span className="flex items-center gap-2">
                <span className={cn('h-3.5 w-3.5 shrink-0 rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-border')} aria-hidden />
                <span className="text-body font-semibold text-fg">{option.title}</span>
                {option.recommended && <span className="text-caption font-semibold uppercase tracking-widest text-faint">Recommended</span>}
              </span>
              <span className="text-small text-muted">{option.body}</span>
            </button>
          );
        })}
      </div>

      <p className="flex items-start gap-2 text-small text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        Either way, passwords and keys stay off-limits, and anything that leaves your computer still asks you first.
      </p>

      {access?.platform === 'mac' && <MacGates access={access} onChanged={() => void query.refetch()} />}
      {access?.platform === 'windows' && <WindowsGates access={access} onChanged={() => void query.refetch()} />}
      {query.isError && <p className="text-small text-danger">Could not read this computer's access settings. Try again in a moment.</p>}
    </Card>
  );
}

function GateRow({ title, body, status, children }: {
  title: string;
  body: string;
  status?: { tone: Tone; label: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold text-fg">{title}</span>
          {status && <StatusPill tone={status.tone}>{status.label}</StatusPill>}
        </div>
        <p className="text-small text-muted">{body}</p>
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function MacGates({ access, onChanged }: { access: ComputerAccessStatus; onChanged: () => void }) {
  const [opened, setOpened] = useState(false);
  const [folders, setFolders] = useState<FolderAccessResult[] | null>(null);
  const [asking, setAsking] = useState(false);
  const fullDisk = access.mac?.fullDiskAccess ?? 'unknown';

  const open = async () => {
    const result = await openComputerAccessPage('full_disk_access');
    setOpened(result.opened);
  };
  const askFolders = async () => {
    setAsking(true);
    try {
      setFolders((await requestFolderAccess()).folders);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="-mb-2 text-caption font-semibold uppercase tracking-widest text-faint">On this Mac</p>
      <GateRow
        title="Full Disk Access"
        body={opened && fullDisk !== 'granted'
          ? 'In the list that just opened, turn on Clementine, then check again here.'
          : 'Lets Clem open Desktop, Documents, Downloads and the rest without macOS stopping to ask.'}
        status={fullDisk === 'granted'
          ? { tone: 'success', label: 'On' }
          : fullDisk === 'not_granted' ? { tone: 'warning', label: 'Not turned on' } : { tone: 'neutral', label: 'Could not check' }}
      >
        {fullDisk !== 'granted' && (
          <>
            <Button variant="secondary" size="sm" onClick={() => void open()}>Open System Settings</Button>
            {opened && <Button variant="ghost" size="sm" onClick={onChanged}>Check again</Button>}
          </>
        )}
      </GateRow>
      {fullDisk !== 'granted' && (
        <GateRow
          title="Desktop, Documents and Downloads"
          body="Rather not turn on Full Disk Access? Allow these three now, so macOS asks you here instead of in the middle of a task."
        >
          <Button variant="secondary" size="sm" disabled={asking} onClick={() => void askFolders()}>{asking ? 'Waiting for macOS…' : 'Allow now'}</Button>
        </GateRow>
      )}
      {folders && (
        <ul className="flex flex-wrap gap-2" aria-label="Folder access">
          {folders.filter((folder) => folder.state !== 'missing').map((folder) => (
            <li key={folder.folder}>
              <StatusPill tone={folder.state === 'allowed' ? 'success' : folder.state === 'denied' ? 'warning' : 'neutral'}>
                {folder.label}: {folder.state === 'allowed' ? 'allowed' : folder.state === 'denied' ? 'not allowed — turn it on in System Settings' : 'could not check'}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WindowsGates({ access, onChanged }: { access: ComputerAccessStatus; onChanged: () => void }) {
  const [opened, setOpened] = useState(false);
  const mode = access.windows?.controlledFolderAccess ?? 'unknown';
  const blocked = mode === 'on' && access.windows?.appAllowed !== true;
  const open = async () => {
    const result = await openComputerAccessPage('controlled_folders');
    setOpened(result.opened);
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="-mb-2 text-caption font-semibold uppercase tracking-widest text-faint">On this PC</p>
      <GateRow
        title="Controlled folder access"
        body={blocked
          ? (opened
            ? 'In Windows Security, choose "Allow an app through Controlled folder access" and add Clementine, then check again here.'
            : 'Windows Security stops apps from changing files in your protected folders unless you allow them.')
          : mode === 'unknown'
            ? 'Could not read Windows Security. If Clem cannot save into Documents or Desktop, allow Clementine under Ransomware protection.'
            : 'Windows Security is not blocking Clem from your folders.'}
        status={mode === 'off' || (mode === 'on' && access.windows?.appAllowed === true)
          ? { tone: 'success', label: mode === 'off' ? 'Off' : 'Clementine allowed' }
          : mode === 'audit' ? { tone: 'info', label: 'Watching only' }
            : blocked ? { tone: 'warning', label: 'Blocking apps' } : { tone: 'neutral', label: 'Could not check' }}
      >
        {(blocked || mode === 'unknown') && (
          <>
            <Button variant="secondary" size="sm" onClick={() => void open()}>Open Windows Security</Button>
            {opened && <Button variant="ghost" size="sm" onClick={onChanged}>Check again</Button>}
          </>
        )}
      </GateRow>
    </div>
  );
}
