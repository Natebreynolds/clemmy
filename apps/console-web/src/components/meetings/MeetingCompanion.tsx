import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, Clock3, Pause, RefreshCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { ConversationThread } from '@/features/conversations/chat/ConversationThread';
import { MeetingResearchControls } from './MeetingResearchControls';
import { checkMeetingHelp, decideMeetingHelp, getMeetingHelp, meetingHelpNotice, setMeetingHelp, startMeetingHelp,
  type MeetingHelpOffer } from '@/lib/meeting-assistance';

/** Owner-facing companion. Automatic private research needs saved, scoped
 * permission; accepted work keeps the ordinary thread, review and Stop. */
export function MeetingCompanion({ meetingId, active }: { meetingId: string; active: boolean }) {
  const qc = useQueryClient();
  const key = ['meeting-assistance', meetingId];
  const state = useQuery({ queryKey: key, queryFn: () => getMeetingHelp(meetingId),
    refetchInterval: query => active || query.state.data?.checking ? 3000 : false, staleTime: 0, retry: 1 });
  useEffect(() => { if (!active) void state.refetch(); }, [active, meetingId, state.refetch]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<string | null>(null);
  const ownedAction = useRef(false);
  const view = state.data;
  const act = async (work: () => Promise<void>) => {
    if (ownedAction.current) return;
    ownedAction.current = true; setPending(true); setError(null);
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That choice could not be saved. Try again.'); }
    finally { ownedAction.current = false; setPending(false); void state.refetch(); }
  };
  const decide = (offer: MeetingHelpOffer, decision: 'lookup' | 'dismiss' | 'defer') => act(async () => {
    if (!view || state.isError) throw new Error('Refresh meeting suggestions before choosing.');
    const result = await decideMeetingHelp(meetingId, offer, view.version, decision);
    qc.setQueryData(key, result.state);
    if (decision === 'lookup') {
      if (!result.lookup) throw new Error('The lookup did not prepare. Refresh this meeting and try again.');
      await startMeetingHelp(result.lookup);
      setConversation(result.lookup.privateOriginSessionId);
    }
  });
  const kept = view?.keptOffers ?? view?.recentOffers.filter(o => o.state === 'deferred' || o.state === 'lookup_prepared') ?? [];
  return <section aria-labelledby="meeting-companion-title" className="mb-5 min-w-0 rounded-xl bg-subtle p-4 sm:p-5 max-sm:[&_button]:min-h-11">
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 sm:flex sm:flex-wrap">
      <DogMark size={32} aria-hidden />
      <div className="min-w-0 flex-1">
        <h2 id="meeting-companion-title" className="text-h3 text-fg">Clem, alongside your meeting</h2>
        <p className="mt-1 max-w-prose text-small text-muted">Suggestions and answers stay here in Clem. Nothing is sent to the meeting.</p>
      </div>
      {view && (active || view.enabled) && <Button className="col-start-2 justify-self-start sm:shrink-0" size="sm" variant="secondary" disabled={pending || state.isError}
        onClick={() => void act(async () => { qc.setQueryData(key, await setMeetingHelp(meetingId, !view.enabled, view.version)); })}>
        {view.enabled ? <><Pause size={15} aria-hidden />Pause suggestions</> : 'Turn on suggestions'}
      </Button>}
    </div>
    {state.isLoading && !view ? <p role="status" className="mt-4 text-small text-muted">Loading meeting suggestions…</p>
      : state.isError ? <div className="mt-4 flex flex-wrap items-center gap-3" role="status"><p className="text-small text-warning">Suggestions couldn’t refresh. The last view may be out of date.</p><Button size="sm" variant="ghost" onClick={() => void state.refetch()}><RefreshCw size={14} aria-hidden />Refresh</Button></div>
      : view && !view.offer && <p className="mt-4 text-small text-muted" role={view.checking ? 'status' : undefined}>{meetingHelpNotice(view)}</p>}
    {view?.offer && <div className="mt-5 border-t border-border pt-4">
      <h3 className="max-w-prose text-body font-semibold text-fg">{view.offer.question}</h3>
      <p className="mt-1 max-w-prose text-small text-muted">{view.offer.why}</p>
      <details className="mt-3 text-small"><summary className="cursor-pointer text-muted">Heard in the meeting</summary><blockquote className="mt-2 max-w-prose whitespace-pre-wrap break-words text-fg">“{view.offer.quote}”</blockquote></details>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || state.isError} onClick={() => void decide(view.offer!, 'lookup')}><BookOpen size={15} aria-hidden />Look it up</Button>
        <Button size="sm" variant="secondary" disabled={pending || state.isError} onClick={() => void decide(view.offer!, 'defer')}><Clock3 size={15} aria-hidden />After the meeting</Button>
        <Button size="sm" variant="ghost" disabled={pending || state.isError} onClick={() => void decide(view.offer!, 'dismiss')}>Not now</Button>
      </div>
    </div>}
    {view?.status === 'unavailable' && view.enabled && <Button className="mt-3" size="sm" variant="ghost" disabled={pending}
      onClick={() => void act(async () => { qc.setQueryData(key, await checkMeetingHelp(meetingId)); })}><RefreshCw size={14} aria-hidden />Try checking again</Button>}
    {error && <p className="mt-3 text-small text-danger" role="alert">{error}</p>}
    {kept.length > 0 && <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-small font-semibold text-fg">Questions you kept</h3>
      <ul className="mt-2 divide-y divide-border">{kept.map(offer => <li key={offer.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        <span className="min-w-0 flex-1 break-words text-small text-fg">{offer.question}</span>
        {offer.lookup?.accepted === true ? <Button size="sm" variant="ghost" onClick={() => setConversation(offer.lookup!.sessionId)}>Open lookup<ArrowUpRight size={14} aria-hidden /></Button>
          : <Button size="sm" variant="ghost" disabled={pending || state.isError} onClick={() => void decide(offer, 'lookup')}>{offer.lookup ? 'Start or reconnect lookup' : 'Look it up'}</Button>}
      </li>)}</ul>
      {!!view?.omittedOfferCount && <p className="mt-2 text-caption text-muted">Showing recent suggestions; {view.omittedOfferCount} earlier suggestions are retained.</p>}
    </div>}
    {conversation && <div className="mt-5 min-w-0 border-t border-border pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-small font-semibold text-fg">Your lookup with Clem</h3>
        <Link className="inline-flex min-h-10 items-center gap-1 text-small text-primary hover:underline" to={`/chat/${encodeURIComponent(conversation)}`}>Continue in chat<ArrowUpRight size={14} aria-hidden /></Link>
      </div>
      <div className="flex h-[min(40rem,70dvh)] min-h-80 min-w-0 flex-col overflow-hidden rounded-lg bg-surface">
        <ConversationThread key={conversation} sessionIdOverride={conversation} />
      </div>
    </div>}
    <MeetingResearchControls key={`research-${meetingId}`} meetingId={meetingId} active={active} />
    {view?.skippedFinalSegments ? <p className="mt-3 text-caption text-muted">Some transcript lines were outside the live check. Suggestions are not a complete meeting review.</p> : null}
  </section>;
}
