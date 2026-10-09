/**
 * Desktop chat column. Wide enough that the conversation fills the window and
 * her work (cards, tables, the thing she is building) has room, while your
 * message and her answer stay one glance apart (60rem). Tables inside an answer
 * scroll within it. `gap` not `space-y`: margin-top on justify-end flex
 * children is what opened a void between the last user turn and the reply.
 */
export const CHAT_COLUMN = 'mx-auto w-full max-w-[60rem]';
export const CHAT_THREAD = `${CHAT_COLUMN} flex min-h-full flex-col justify-end gap-7 px-8 py-8`;
export const CHAT_COMPOSER_WRAP = `${CHAT_COLUMN} px-8 pb-5 pt-2`;
