import { useCallback, useEffect, useRef } from 'react';
import { createConversationSendScope } from './conversation-send-scope';

/** Capture before agent/project preparation and assert immediately before POST. */
export function useConversationSendScope(routeKey: string, session: { current: string | null }) {
  const scope = useRef(createConversationSendScope(routeKey));
  scope.current.update(routeKey);
  useEffect(() => {
    const owner = scope.current;
    owner.activate();
    return () => owner.dispose();
  }, []);
  return useCallback(() => scope.current.capture(() => session.current), [session]);
}
