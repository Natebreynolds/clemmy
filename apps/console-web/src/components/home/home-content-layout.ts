import type { HomePaneId, HomeStyle } from '../../lib/home-prefs';

export type HomeContentBlock = { kind: 'spaces' } | { kind: 'panes'; panes: HomePaneId[] };

const immediate = new Set<HomePaneId>(['today', 'needs_you', 'running', 'while_away']);

/** Compose already-filtered panes without changing the owner's relative order.
 * Spaces has one fixed position per style; only adjacent immediate panes share
 * a row, and that row never straddles the Spaces insertion point. */
export function buildHomeContentLayout(visible: readonly HomePaneId[], style: HomeStyle): HomeContentBlock[] {
  const maxGroup = style === 'dashboard' ? 3 : 2;
  let insertAt = 0;
  if (style === 'briefing') {
    const needsYou = visible.indexOf('needs_you');
    if (needsYou >= 0) insertAt = needsYou + 1;
  } else {
    const firstImmediate = visible.findIndex(pane => immediate.has(pane));
    if (firstImmediate >= 0) {
      insertAt = firstImmediate;
      while (insertAt < visible.length && immediate.has(visible[insertAt])
        && insertAt - firstImmediate < maxGroup) insertAt += 1;
    }
  }

  const blocks: HomeContentBlock[] = [];
  for (let index = 0; index < visible.length;) {
    if (index === insertAt) blocks.push({ kind: 'spaces' });
    let end = index + 1;
    if (immediate.has(visible[index])) {
      while (end < visible.length && end !== insertAt && end - index < maxGroup
        && immediate.has(visible[end])) end += 1;
    }
    blocks.push({ kind: 'panes', panes: visible.slice(index, end) });
    index = end;
  }
  if (insertAt === visible.length) blocks.push({ kind: 'spaces' });
  return blocks;
}
