/**
 * Desktop chat column. 760px / max-w-3xl left a field of unused canvas on a
 * workstation; 64rem (max-w-5xl) spends the pane without turning Clem's
 * prose into a billboard. `gap` not `space-y`: margin-top on justify-end
 * flex children is what opened a void between the last user turn and the reply.
 */
export const CHAT_COLUMN = 'mx-auto w-full max-w-5xl';
export const CHAT_THREAD = `${CHAT_COLUMN} flex min-h-full flex-col justify-end gap-5 px-8 py-6`;
export const CHAT_COMPOSER_WRAP = `${CHAT_COLUMN} px-8 pb-5 pt-2`;
