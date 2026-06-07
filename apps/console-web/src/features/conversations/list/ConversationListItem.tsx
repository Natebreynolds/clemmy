import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Pin, MoreVertical, Pencil, Tag, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { originMeta } from '../lib/origin';
import type { Session } from '../types';

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface Actions {
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onTags: (id: string, tags: string[]) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
}

export function ConversationListItem({ session, actions }: { session: Session; actions: Actions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = originMeta(session.origin);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== session.title) actions.onRename(session.id, next);
    else setDraft(session.title);
  };

  const editTags = () => {
    setMenuOpen(false);
    const input = window.prompt('Tags (comma-separated). Use folder:Name for a folder.', session.tags.join(', '));
    if (input === null) return;
    const tags = input.split(',').map((t) => t.trim()).filter(Boolean);
    actions.onTags(session.id, tags);
  };

  return (
    <div className="group relative">
      <NavLink
        to={`/chat/${encodeURIComponent(session.id)}`}
        className={({ isActive }) =>
          cn(
            'block rounded-md px-3 py-2 transition-colors',
            isActive ? 'bg-primary-tint' : 'hover:bg-hover',
          )
        }
      >
        <div className="flex items-center gap-2">
          {session.pinned && <Pin className="h-3 w-3 shrink-0 fill-primary text-primary" aria-hidden />}
          {renaming ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.preventDefault()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { setRenaming(false); setDraft(session.title); }
              }}
              className="min-w-0 flex-1 rounded-sm bg-canvas px-1.5 py-0.5 text-small text-fg outline-none ring-1 ring-border-strong"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">
              {session.title || 'New chat'}
            </span>
          )}
          <span className="shrink-0 text-caption text-faint">{relativeTime(session.updatedAt)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 pr-6">
          <span className="min-w-0 flex-1 truncate text-caption text-muted">
            {session.preview || (session.origin !== 'desktop' ? meta.label : 'No messages yet')}
          </span>
        </div>
        {session.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {session.tags.map((t) => (
              <span key={t} className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption text-muted">{t}</span>
            ))}
          </div>
        )}
      </NavLink>

      {/* Kebab */}
      <div ref={menuRef} className="absolute right-1.5 top-1.5">
        <button
          type="button"
          aria-label="Conversation actions"
          onClick={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}
          className="rounded-sm p-1 text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg">
            <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenuOpen(false); setRenaming(true); }} />
            <MenuItem
              icon={Pin}
              label={session.pinned ? 'Unpin' : 'Pin'}
              onClick={() => { setMenuOpen(false); actions.onPin(session.id, !session.pinned); }}
            />
            <MenuItem icon={Tag} label="Edit tags…" onClick={editTags} />
            <MenuItem
              icon={session.archived ? ArchiveRestore : Archive}
              label={session.archived ? 'Unarchive' : 'Archive'}
              onClick={() => { setMenuOpen(false); actions.onArchive(session.id, !session.archived); }}
            />
            <MenuItem
              icon={Trash2}
              label="Delete"
              danger
              onClick={() => {
                setMenuOpen(false);
                if (window.confirm('Delete this conversation? This cannot be undone.')) actions.onDelete(session.id);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon: Icon, label, onClick, danger,
}: { icon: typeof Pin; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-small transition-colors hover:bg-hover',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}
