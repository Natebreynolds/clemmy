/** A message prepared asynchronously still belongs to the route and server
 * session where Send was pressed, even if both old and new chats have no ID. */
export function createConversationSendScope(initialRoute: string) {
  let route = initialRoute;
  let generation = 0;
  let active = true;
  return {
    update(nextRoute: string) {
      if (nextRoute !== route) { route = nextRoute; generation += 1; }
    },
    activate() { active = true; },
    dispose() { active = false; generation += 1; },
    capture(readSession: () => string | null) {
      const capturedGeneration = generation;
      const session = readSession();
      const isCurrentRoute = () => active && capturedGeneration === generation;
      return {
        // Acceptance intentionally assigns the first session ID. Navigation
        // afterward checks only route ownership, not the pre-send null ID.
        isCurrentRoute,
        assertCurrent() {
          if (!isCurrentRoute() || session !== readSession()) {
            throw new Error('The conversation changed before this message was sent. Your draft stays with its original conversation.');
          }
        },
      };
    },
  };
}
