/**
 * Build Home: "describe it and Clem builds it" as a journey that ends in a
 * Space on the Home, not in a chat message someone has to go and read.
 *
 * Nothing here decides what happened. The request is an ordinary chat turn
 * (POST /api/harness/chat); its progress and outcome are read from that
 * turn's durable events — the accepted input, the tool steps, and the ONE
 * `conversation_completed` whose `sourceUserSeq` is that input — and the
 * resulting Space is the one whose `originSessionId` names the session
 * (`space_save` stamps it). The Home placement goes through the same layout
 * contract as every other tile.
 *
 * The only thing this file keeps is a pointer per build (which session, what
 * was asked), in this window's storage so a relaunch picks the builds back
 * up; the state behind the pointer is always re-read from the daemon.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { apiGet, type ApiError } from './api';
import { postChat } from './chat';
import { progressLabel } from './useChat';
import type { HarnessEvent } from './types';
import { changeHomeLayout, HOME_LAYOUT_KEY, type HomeLayout } from './home-layout';
import type { SpaceRecord } from './spaces';

export interface HomeBuild {
  /** Also the chat request's clientRequestId: a replay of the same POST
   *  (a relaunch before the daemon answered) lands on the same turn. */
  id: string;
  /** What the person asked, without the framework's placement note. */
  prompt: string;
  startedAt: string;
  sessionId?: string;
  dismissed?: boolean;
  /** Set once this build's Space was placed on Home. A person who removes
   *  it afterwards has decided; it is never placed a second time. */
  placedSpaceId?: string;
  /** The request never reached Clem (the daemon was down or refused it). */
  sendError?: string;
}

const STORE_KEY = 'clem.home.builds.v1';
const MAX_KEPT = 8;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function readBuilds(storage: Pick<Storage, 'getItem'> | null = safeStorage()): HomeBuild[] {
  try {
    const raw = storage?.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((b): b is HomeBuild => Boolean(b && typeof b.id === 'string' && typeof b.prompt === 'string' && typeof b.startedAt === 'string'))
      .filter((b) => now - Date.parse(b.startedAt) < KEEP_MS);
  } catch {
    return [];
  }
}

function writeBuilds(builds: HomeBuild[]): void {
  try { safeStorage()?.setItem(STORE_KEY, JSON.stringify(builds.slice(0, MAX_KEPT))); } catch { /* private window: this session only */ }
}

function safeStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** The request Clem receives. Placement is done here through the layout
 *  contract, so the turn never has to read or rewrite the Home. */
export function buildRequestText(prompt: string): string {
  return `${prompt.trim()}\n\nBuild this as a Space: create a new one, or update the Space I already have for it. `
    + 'It will be placed on my Home for me, so leave my Home layout as it is. '
    + 'Use my connected tools and preferences, and ask me only for decisions you cannot make.';
}

export function samePrompt(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

// ─── What the turn's events say ──────────────────────────────────────────────

export interface BuildFacts {
  /** Seq of the accepted request; the turn's terminal names it. */
  userSeq: number | null;
  lastSeq: number;
  progress: string | null;
  waitingOnApproval: boolean;
  terminal: { reason: string; reply: string } | null;
}

export const NO_FACTS: BuildFacts = { userSeq: null, lastSeq: 0, progress: null, waitingOnApproval: false, terminal: null };

export function reduceBuildEvents(prev: BuildFacts, events: readonly HarnessEvent[]): BuildFacts {
  let next = { ...prev };
  for (const ev of events) {
    const seq = typeof ev.seq === 'number' ? ev.seq : next.lastSeq;
    next.lastSeq = Math.max(next.lastSeq, seq);
    if (next.terminal) continue;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === 'user_input_received' && next.userSeq === null && data.synthetic !== true) {
      next.userSeq = seq;
    } else if (ev.type === 'tool_called') {
      next.progress = progressLabel(ev) ?? next.progress;
    } else if (ev.type === 'approval_requested') {
      next.waitingOnApproval = true;
    } else if (ev.type === 'approval_resolved') {
      next.waitingOnApproval = false;
    } else if (ev.type === 'conversation_completed' && next.userSeq !== null && data.sourceUserSeq === next.userSeq) {
      const reply = typeof data.reply === 'string' ? data.reply : typeof data.summary === 'string' ? data.summary : '';
      next = { ...next, waitingOnApproval: false, terminal: { reason: typeof data.reason === 'string' ? data.reason : 'unknown', reply } };
    }
  }
  return next;
}

// ─── What the card says ──────────────────────────────────────────────────────

export type BuildState =
  | { kind: 'sending' }
  | { kind: 'unsent'; error: string }
  | { kind: 'working'; progress: string | null }
  | { kind: 'waiting' }
  | { kind: 'checking' }
  | { kind: 'ready'; space: SpaceRecord }
  | { kind: 'no_space'; reply: string }
  | { kind: 'stopped'; reply: string }
  | { kind: 'failed'; reply: string }
  | { kind: 'lost' };

const STOPPED = new Set(['cancelled', 'canceled', 'stopped', 'interrupted', 'aborted']);

export function buildState(input: {
  build: HomeBuild;
  facts: BuildFacts | undefined;
  lost: boolean;
  spaces: readonly SpaceRecord[] | undefined;
  /** The Spaces list was read after the turn ended (a Space saved in the
   *  last step may not be in an older read). */
  spacesFresh: boolean;
}): BuildState {
  const { build, facts } = input;
  if (!build.sessionId) return build.sendError ? { kind: 'unsent', error: build.sendError } : { kind: 'sending' };
  if (input.lost) return { kind: 'lost' };
  const space = input.spaces?.find((s) => s.originSessionId === build.sessionId && s.status !== 'archived');
  const terminal = facts?.terminal;
  if (!terminal) return facts?.waitingOnApproval ? { kind: 'waiting' } : { kind: 'working', progress: facts?.progress ?? null };
  if (terminal.reason === 'success') {
    if (space) return { kind: 'ready', space };
    return input.spacesFresh ? { kind: 'no_space', reply: terminal.reply } : { kind: 'checking' };
  }
  if (STOPPED.has(terminal.reason)) return { kind: 'stopped', reply: terminal.reply };
  return { kind: 'failed', reply: terminal.reply };
}

export function isSettled(state: BuildState): boolean {
  return state.kind === 'ready' || state.kind === 'no_space' || state.kind === 'stopped' || state.kind === 'failed'
    || state.kind === 'lost' || state.kind === 'unsent';
}

// ─── The hook ────────────────────────────────────────────────────────────────

interface EventsPage { events: HarnessEvent[]; latestSeq: number; page?: { hasMore?: boolean; scannedThroughSeq?: number } }

const factsBySession = new Map<string, BuildFacts>();

async function readFacts(sessionId: string): Promise<BuildFacts> {
  let facts = factsBySession.get(sessionId) ?? NO_FACTS;
  // Page forward from where the last read stopped; a long build is several pages.
  for (let i = 0; i < 6; i += 1) {
    const page = await apiGet<EventsPage>(`/api/sessions/${encodeURIComponent(sessionId)}/events/recent?sinceSeq=${facts.lastSeq}&limit=500`);
    facts = reduceBuildEvents(facts, page.events ?? []);
    if (page.page?.scannedThroughSeq) facts = { ...facts, lastSeq: Math.max(facts.lastSeq, page.page.scannedThroughSeq) };
    if (!page.page?.hasMore || facts.terminal) break;
  }
  factsBySession.set(sessionId, facts);
  return facts;
}

export function useHomeBuilds(input: {
  spaces: readonly SpaceRecord[] | undefined;
  spacesUpdatedAt: number;
  refetchSpaces: () => void;
  layout: HomeLayout | undefined;
}) {
  const qc = useQueryClient();
  const [builds, setBuilds] = useState<HomeBuild[]>(() => readBuilds());
  const [submitting, setSubmitting] = useState(false);
  const settledAt = useRef(new Map<string, number>());
  const placing = useRef(new Set<string>());

  const update = useCallback((fn: (prev: HomeBuild[]) => HomeBuild[]) => {
    setBuilds((prev) => {
      const next = fn(prev);
      writeBuilds(next);
      return next;
    });
  }, []);

  const visible = useMemo(() => builds.filter((b) => !b.dismissed), [builds]);

  const factQueries = useQueries({
    queries: visible.filter((b) => b.sessionId).map((b) => ({
      queryKey: ['home-build', b.sessionId],
      queryFn: () => readFacts(b.sessionId!),
      refetchInterval: (query: { state: { data?: BuildFacts; error?: unknown } }) => {
        const status = (query.state.error as ApiError | undefined)?.status;
        return query.state.data?.terminal || status === 404 ? false : 3000;
      },
      retry: (count: number, err: unknown) => (err as ApiError)?.status !== 404 && count < 2,
    })),
  });

  const states = useMemo(() => {
    let i = 0;
    return visible.map((build) => {
      const q = build.sessionId ? factQueries[i++] : undefined;
      const facts = q?.data;
      const lost = (q?.error as ApiError | undefined)?.status === 404;
      const ended = facts?.terminal ? settledAt.current.get(build.id) : undefined;
      const state = buildState({
        build,
        facts,
        lost,
        spaces: input.spaces,
        spacesFresh: typeof ended === 'number' && input.spacesUpdatedAt > ended,
      });
      return { build, state };
    });
  }, [visible, factQueries, input.spaces, input.spacesUpdatedAt]);

  // A turn that just ended: read the Spaces again so a Space saved in its
  // last step is seen (the Home's own Spaces poll is minutes apart).
  useEffect(() => {
    for (const { build, state } of states) {
      if (state.kind === 'checking' && !settledAt.current.has(build.id)) {
        settledAt.current.set(build.id, Date.now());
        input.refetchSpaces();
      }
    }
  }, [states, input]);

  // Place a built Space on Home once, at the end, keeping every other tile.
  useEffect(() => {
    const layout = input.layout;
    if (!layout) return;
    for (const { build, state } of states) {
      if (state.kind !== 'ready' || build.placedSpaceId || placing.current.has(build.id)) continue;
      const spaceId = state.space.id;
      if (layout.tiles.some((t) => t.spaceId === spaceId)) {
        update((prev) => prev.map((b) => (b.id === build.id ? { ...b, placedSpaceId: spaceId } : b)));
        continue;
      }
      placing.current.add(build.id);
      void changeHomeLayout({ operation: 'pin', space_id: spaceId, expected_revision: layout.revision })
        .then((next) => {
          qc.setQueryData(HOME_LAYOUT_KEY, next);
          update((prev) => prev.map((b) => (b.id === build.id ? { ...b, placedSpaceId: spaceId } : b)));
        })
        .catch(() => { void qc.invalidateQueries({ queryKey: HOME_LAYOUT_KEY }); })
        .finally(() => { placing.current.delete(build.id); });
    }
  }, [states, input.layout, qc, update]);

  const send = useCallback(async (build: HomeBuild): Promise<HomeBuild> => {
    const accepted = await postChat(buildRequestText(build.prompt), null, [], build.id);
    const withSession: HomeBuild = { ...build, sessionId: accepted.sessionId, sendError: undefined };
    update((prev) => prev.map((b) => (b.id === build.id ? withSession : b)));
    return withSession;
  }, [update]);

  // A build saved before the daemon answered (the window closed mid-send) is
  // sent again under the same request id, which the daemon answers with the
  // same turn rather than a second one.
  const resent = useRef(new Set<string>());
  useEffect(() => {
    for (const build of visible) {
      if (build.sessionId || build.sendError || resent.current.has(build.id)) continue;
      resent.current.add(build.id);
      void send(build).catch((err: unknown) => {
        const error = err instanceof Error && err.message ? err.message : 'Clem could not be reached.';
        update((prev) => prev.map((b) => (b.id === build.id ? { ...b, sendError: error } : b)));
      });
    }
  }, [visible, send, update]);

  const inFlight = useCallback((prompt: string) =>
    states.find(({ build, state }) => samePrompt(build.prompt, prompt) && !isSettled(state)), [states]);

  /** Starts a build. Resolves once the daemon accepted the turn; rejects with
   *  its error otherwise (the caller keeps the words the person typed). */
  const start = useCallback(async (prompt: string): Promise<{ build: HomeBuild; duplicate: boolean }> => {
    const existing = inFlight(prompt);
    if (existing) return { build: existing.build, duplicate: true };
    if (submitting) throw new Error('Clem is still receiving your last request.');
    const build: HomeBuild = {
      id: globalThis.crypto?.randomUUID?.() ?? `home-build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      prompt: prompt.trim(),
      startedAt: new Date().toISOString(),
    };
    resent.current.add(build.id);
    update((prev) => [build, ...prev]);
    setSubmitting(true);
    try {
      return { build: await send(build), duplicate: false };
    } catch (err) {
      update((prev) => prev.filter((b) => b.id !== build.id));
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [inFlight, submitting, send, update]);

  const dismiss = useCallback((id: string) => {
    update((prev) => prev.map((b) => (b.id === id ? { ...b, dismissed: true } : b)));
  }, [update]);

  const retry = useCallback(async (id: string) => {
    const old = builds.find((b) => b.id === id);
    if (!old) return;
    dismiss(id);
    await start(old.prompt);
  }, [builds, dismiss, start]);

  return { builds: states, submitting, start, retry, dismiss, inFlight };
}
