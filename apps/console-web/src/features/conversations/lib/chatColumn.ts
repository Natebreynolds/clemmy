/**
 * Desktop chat column. It grows with the window: never narrower than 60rem
 * where there is room, and 90% of the chat pane on a wide screen, so the
 * conversation fills a large monitor instead of sitting in a strip (owner
 * 2026-10-19, on a wide Windows display). Tables inside an answer scroll
 * within it. `gap` not `space-y`: margin-top on justify-end flex children is
 * what opened a void between the last user turn and the reply.
 */
export const CHAT_COLUMN = 'mx-auto w-full max-w-[max(60rem,90%)]';
export const CHAT_THREAD = `${CHAT_COLUMN} flex min-h-full flex-col justify-end gap-7 px-8 py-8`;
export const CHAT_COMPOSER_WRAP = `${CHAT_COLUMN} px-4 pb-5 pt-2 sm:px-8`;
