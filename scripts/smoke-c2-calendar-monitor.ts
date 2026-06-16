/**
 * smoke-c2-calendar-monitor.ts — live verification of the C2 calendar monitor
 * against the REAL connected calendar(s), READ-ONLY and SIDE-EFFECT-FREE.
 *
 *   npx tsx scripts/smoke-c2-calendar-monitor.ts
 *
 * Confirms the real Composio/Graph calendar-view response parses and the scorer
 * behaves. Injects notify()/saveState() so it ONLY PRINTS what it WOULD surface —
 * never writes notifications, never persists state. Uses real listConnections +
 * executeTool (read-only calendar view).
 */
process.env.CLEMENTINE_HOME = process.env.CLEMENTINE_HOME || `${process.env.HOME}/.clementine-next`;
process.env.CLEMMY_CALENDAR_MONITOR = 'on';

const { processCalendarMonitor } = await import('../src/agents/calendar-monitor.js');
const { listConnectedToolkits, executeComposioTool } = await import('../src/integrations/composio/client.js');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass++; };
const no = (m: string, d = '') => { console.log(`   \x1b[31m✗\x1b[0m ${m}${d ? ' — ' + d : ''}`); fail++; };

console.log('\n\x1b[1m== C2 calendar-monitor live smoke (READ-ONLY, no writes) ==\x1b[0m');

const surfaced: any[] = [];
const toolSlugs: string[] = [];
let firstEventCount = -1;
let firstRespKeys = '';

const deps = {
  listConnections: listConnectedToolkits,
  executeTool: (async (slug: string, args: any, conn?: string) => {
    toolSlugs.push(slug);
    const r = await executeComposioTool(slug, args, conn);
    if (firstEventCount < 0 && r && typeof r === 'object') {
      firstRespKeys = Object.keys((r as any).data ?? r as any).join(',');
      const arr = (r as any).data?.value ?? (r as any).data?.events ?? (r as any).data?.items;
      firstEventCount = Array.isArray(arr) ? arr.length : ((r as any).successful === false ? -2 : 0);
      if ((r as any).successful === false) console.log('   (read error:', JSON.stringify((r as any).data).slice(0, 140), ')');
    }
    return r;
  }),
  notify: (n: any) => surfaced.push(n),
  config: () => ({ enabled: true, intervalMs: 0, maxPerScan: 10, fetchTop: 50 }),
  proactiveWorkAllowed: () => true,
  now: () => Date.now(),
  loadState: () => ({ surfacedIds: [] as string[] }),
  saveState: (_s: any) => { /* no-op */ },
};

try {
  const conns = await listConnectedToolkits();
  const cals = conns.filter((c) => /outlook|googlecalendar/.test(c.slug));
  if (cals.length > 0) ok(`found ${cals.length} calendar connection(s): ${[...new Set(cals.map((c) => c.slug))].join(', ')}`);
  else no('no calendar connections found');

  const n = await processCalendarMonitor(deps as any);

  if (toolSlugs.length > 0 && toolSlugs.every((s) => /GET_CALENDAR_VIEW|EVENTS_LIST/.test(s))) {
    ok(`read-only calendar action(s) called: ${[...new Set(toolSlugs)].join(', ')} (never a mutate slug)`);
  } else {
    no('unexpected tool slugs', toolSlugs.join(', '));
  }
  if (firstEventCount >= 0) ok(`real response parsed: keys=[${firstRespKeys}], ${firstEventCount} upcoming event(s) in window`);
  else if (firstEventCount === -2) no('calendar read returned an error (parser/args may need a tweak)');
  else no('could not locate events array in the real response', `keys=[${firstRespKeys}]`);

  console.log(`\n   would surface ${n} needs-you card(s):`);
  for (const c of surfaced) {
    console.log(`     • ${c.title} — ${(c.metadata?.reasons ?? []).join(', ')} | ${c.metadata?.account}`);
    if (c.silent !== true) no('card not dashboard-only', c.title);
  }
  ok(`live run completed cleanly (surfaced ${n}, no writes, no state persisted)`);
} catch (e) {
  no('live run threw', (e as Error)?.message?.slice(0, 200));
}

console.log(`\n\x1b[1m== ${pass} passed, ${fail} failed ==\x1b[0m\n`);
process.exit(fail ? 1 : 0);
