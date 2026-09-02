/**
 * The one bound on a work id: operation ids, universe ids, plan ids, and the
 * capability refs a plan binding cites. The alphabet is shared by every
 * consumer (topology, plan contract, admission, no-progress projection, public
 * presentation). The length must admit every ref the HOST itself mints: live
 * 2026-09-02 a chat turn died because plan_task refused a 154-character
 * `cap:live:v1:…:reacquired:…` ref that tool_search had just disclosed — the
 * host handed out an id its own schema would not accept.
 */
export const WORK_ID_MAX_CHARS = 512;
export const WORK_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9:._/-]{0,${WORK_ID_MAX_CHARS - 1}}$`);
