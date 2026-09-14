import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { withFileLockSyncStrict } from './atomic-json.js';
import { writeWorkspaceSnapshotFile } from '../spaces/workspace-snapshot.js';
import { withHostLocalWriteCommitFromFile } from './harness/host-local-write-commit.js';

export const HOME_LAYOUT_PATH = path.join(BASE_DIR, 'state', 'home-layout.json');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
const width = z.enum(['small', 'medium', 'wide']);
const zone = z.enum(['now', 'watching']);
const layoutSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
  tiles: z.array(z.object({ spaceId: slug, width, zone }).strict()),
}).strict().refine(value => new Set(value.tiles.map(tile => tile.spaceId)).size === value.tiles.length,
  'A Space can appear on Home only once');

export const HOME_LAYOUT_CHANGE_PARAMETERS = {
  operation: z.enum(['pin', 'update', 'remove']).describe('Pin an existing Space, edit its placement, or remove only its Home tile.'),
  space_id: slug.describe('Exact existing Space slug. Create the Space with space_save first when needed.'),
  expected_revision: z.number().int().nonnegative().describe('Current Home revision from home_get. Protects simultaneous owner edits; a conflict returns the current layout.'),
  width: width.nullish().describe('Tile width; omitted preserves the existing width, or uses medium for a new tile.'),
  zone: zone.nullish().describe('Now for immediate work, Watching for ongoing information. Omitted preserves it, or uses watching for a new tile.'),
  position: z.enum(['keep', 'start', 'end', 'before']).nullish().describe('Position among tiles. Omitted keeps an existing position or appends a new tile.'),
  before_space_id: slug.nullish().describe('Required only for position=before; names an existing Home tile.'),
};
export const homeLayoutChangeSchema = z.object(HOME_LAYOUT_CHANGE_PARAMETERS).strict();
export type HomeLayout = z.infer<typeof layoutSchema>;
export type HomeLayoutChange = z.infer<typeof homeLayoutChangeSchema>;

export class HomeLayoutError extends Error {
  constructor(public code: 'layout_conflict' | 'invalid_placement', message: string, public current?: HomeLayout) {
    super(message);
  }
}

/** Missing is a fresh Home. Unreadable or corrupt is an error, never an empty
 * layout that a later save could overwrite. Reading creates no state. */
export function loadHomeLayout(file = HOME_LAYOUT_PATH): HomeLayout {
  if (!existsSync(file)) return { version: 1, revision: 0, updatedAt: null, tiles: [] };
  return layoutSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function applyHomeLayoutChange(current: HomeLayout, change: HomeLayoutChange): HomeLayout['tiles'] {
  const existing = current.tiles.find(tile => tile.spaceId === change.space_id);
  if (change.operation === 'update' && !existing) {
    throw new HomeLayoutError('invalid_placement', 'This Space is not on Home. Use pin to add it.', current);
  }
  if (change.operation === 'remove') return current.tiles.filter(tile => tile.spaceId !== change.space_id);
  const tile = {
    spaceId: change.space_id,
    width: change.width ?? existing?.width ?? 'medium',
    zone: change.zone ?? existing?.zone ?? 'watching',
  };
  const position = change.position ?? 'keep';
  if (position !== 'before' && change.before_space_id != null) {
    throw new HomeLayoutError('invalid_placement', 'before_space_id requires position=before.', current);
  }
  if (position === 'keep' && existing) return current.tiles.map(item => item.spaceId === tile.spaceId ? tile : item);
  const tiles = current.tiles.filter(item => item.spaceId !== tile.spaceId);
  let index = position === 'start' ? 0 : tiles.length;
  if (position === 'before') {
    index = tiles.findIndex(item => item.spaceId === change.before_space_id);
    if (index < 0) throw new HomeLayoutError('invalid_placement', 'Choose another existing Home tile for before_space_id.', current);
  }
  tiles.splice(index, 0, tile);
  return tiles;
}

/** Both the UI and tool use this locked, durable commit. The current revision
 * is checked inside the cross-process lock. Exact no-op replays reuse the
 * saved receipt; they never duplicate a tile or rewrite a newer placement. */
export function updateHomeLayout(input: unknown, options: {
  spaceExists: (id: string) => boolean;
  file?: string;
  rootDir?: string;
}): { layout: HomeLayout; changed: boolean; receipt: string } {
  const change = homeLayoutChangeSchema.parse(input);
  const file = options.file ?? HOME_LAYOUT_PATH;
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSyncStrict(file, () => {
    const current = loadHomeLayout(file);
    if (change.operation !== 'remove' && !options.spaceExists(change.space_id)) {
      throw new HomeLayoutError('invalid_placement', 'The Space does not exist. Create or find it before adding it to Home.', current);
    }
    const tiles = applyHomeLayoutChange(current, change);
    const changed = JSON.stringify(tiles) !== JSON.stringify(current.tiles);
    if (changed && change.expected_revision !== current.revision) {
      throw new HomeLayoutError('layout_conflict', 'Home changed since you read it. Use the current layout to apply only the requested change.', current);
    }
    const layout: HomeLayout = changed
      ? { version: 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), tiles }
      : current;
    // Even an initial no-op remove has an explicit, readable empty layout.
    if (changed || !existsSync(file)) writeWorkspaceSnapshotFile(file, JSON.stringify(layout, null, 2) + '\n');
    return { layout, changed, receipt: withHostLocalWriteCommitFromFile({
      createdId: 'home', committedPath: file, rootDir: options.rootDir,
      result: JSON.stringify({ ok: true, changed, layout, url: '/console/home' }),
    }) };
  });
}
