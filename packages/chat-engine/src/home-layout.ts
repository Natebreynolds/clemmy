/** A Home tile references one Space. Data, actions and refresh ownership stay
 * with that Space; placement carries no execution authority. */
export interface HomeTile {
  spaceId: string;
  width: 'small' | 'medium' | 'wide';
  zone: 'now' | 'watching';
}

export interface HomeLayout {
  version: 1;
  revision: number;
  updatedAt: string | null;
  tiles: HomeTile[];
}

export interface HomeLayoutChange {
  operation: 'pin' | 'update' | 'remove';
  space_id: string;
  expected_revision: number;
  width?: HomeTile['width'] | null;
  zone?: HomeTile['zone'] | null;
  position?: 'keep' | 'start' | 'end' | 'before' | null;
  before_space_id?: string | null;
}
