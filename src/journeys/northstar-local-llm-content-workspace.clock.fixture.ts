/** One test-only reference day, inherited by fresh-process recovery fixtures.
 * Never replace Date or timers: the real host still owns accepted timestamps,
 * deadlines, leases and recovery. Only authored fixture content moves with time. */
export const WORKSPACE_FIXTURE_AS_OF = process.env.CLEM_NORTHSTAR_FIXTURE_AS_OF
  ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(WORKSPACE_FIXTURE_AS_OF))) throw new Error('Invalid Workspace fixture reference time');
process.env.CLEM_NORTHSTAR_FIXTURE_AS_OF = WORKSPACE_FIXTURE_AS_OF;

export function workspaceFixtureDay(offset: number): string {
  const day = Date.parse(`${WORKSPACE_FIXTURE_AS_OF.slice(0, 10)}T00:00:00.000Z`);
  return new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
}
