import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderGit2, FolderPlus, Trash2, Folder, FolderSearch, ChevronUp, Home, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getProjects, addWorkspace, removeWorkspace, browseFolders } from '@/lib/connect';

export function ProjectsPanel() {
  const qc = useQueryClient();
  const projects = usePoll(['projects'], getProjects, 30000);
  const dirs = projects.data?.workspaceDirs ?? [];
  const found = projects.data?.projects ?? [];
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const browse = usePoll(['browse', cwd ?? ''], () => browseFolders(cwd), 0, { enabled: browsing });
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const add = async (p?: string) => {
    const target = (p ?? path).trim();
    if (!target) return;
    setBusy(true);
    try { await addWorkspace(target); setPath(''); setBrowsing(false); } finally { setBusy(false); refresh(); }
  };

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <FolderGit2 className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Projects & folders</h3>
          <p className="text-small text-muted">Folders Clementine can read and work in on your machine</p>
        </div>
      </div>

      {/* Add a workspace — type a path or browse for one */}
      <div className="mb-3 flex gap-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Add a folder (e.g. ~/Projects/my-app)" aria-label="Workspace path" className="flex-1"
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <Button variant="secondary" onClick={() => { setBrowsing((v) => !v); setCwd(undefined); }} aria-expanded={browsing}><FolderSearch className="h-4 w-4" aria-hidden /> Browse</Button>
        <Button onClick={() => add()} disabled={busy || !path.trim()}><FolderPlus className="h-4 w-4" aria-hidden /> Add folder</Button>
      </div>

      {browsing && (
        <Card className="mb-3 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="Up one folder" title="Up" disabled={!browse.data?.parent} onClick={() => setCwd(browse.data?.parent ?? undefined)}><ChevronUp className="h-4 w-4" aria-hidden /></Button>
            <Button variant="ghost" size="icon" aria-label="Home" title="Home" onClick={() => setCwd(browse.data?.home)}><Home className="h-4 w-4" aria-hidden /></Button>
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted">{browse.data?.path ?? '…'}</span>
            <Button size="sm" onClick={() => add(browse.data?.path)} disabled={busy || !browse.data?.path}><Check className="h-4 w-4" aria-hidden /> Add this folder</Button>
          </div>
          <div className="max-h-56 overflow-auto rounded-md border border-border">
            {browse.isLoading ? <Skeleton className="m-2 h-24" />
              : (browse.data?.entries ?? []).length === 0 ? <p className="p-3 text-caption text-faint">No subfolders here.</p>
                : (browse.data?.entries ?? []).map((e) => (
                  <button key={e.path} type="button" onClick={() => setCwd(e.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-small text-fg hover:bg-hover cursor-pointer">
                    <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden /> <span className="truncate">{e.name}</span>
                  </button>
                ))}
          </div>
        </Card>
      )}

      {projects.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <>
          {dirs.length > 0 && (
            <div className="mb-4 space-y-1.5">
              {dirs.map((d) => (
                <div key={d} className="flex items-center gap-3 rounded-md border border-border bg-surface px-3.5 py-2.5">
                  <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-small text-fg">{d}</span>
                  <Button variant="ghost" size="icon" aria-label={`Remove ${d}`} title="Remove" onClick={async () => { await removeWorkspace(d); refresh(); }}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {found.length > 0 && (
            <>
              <p className="mb-2 text-label text-faint">Detected projects</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {found.map((p) => (
                  <Card key={p.path} className="p-3.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{p.name}</span>
                      {p.type && <StatusPill tone="neutral">{p.type}</StatusPill>}
                    </div>
                    {p.description && <p className="mt-0.5 line-clamp-1 text-caption text-muted">{p.description}</p>}
                    <p className="mt-1 truncate font-mono text-caption text-faint">{p.path}</p>
                  </Card>
                ))}
              </div>
            </>
          )}

          {dirs.length === 0 && found.length === 0 && (
            <Card className="p-4 text-body text-muted">No folders added yet. Add one above to let Clementine work with your local projects.</Card>
          )}
        </>
      )}
    </section>
  );
}
