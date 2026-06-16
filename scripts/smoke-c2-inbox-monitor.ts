/**
 * smoke-c2-inbox-monitor.ts — live verification of the C2 ambient inbox monitor
 * against the REAL connected mailbox(es), READ-ONLY and SIDE-EFFECT-FREE.
 *
 *   CLEMMY_INBOX_MONITOR=on npx tsx scripts/smoke-c2-inbox-monitor.ts
 *
 * Confirms the one thing unit tests mock: that the real Composio/Graph response
 * parses correctly and the scorer surfaces sensible "needs-you" items. It injects
 * notify()/saveState() so it ONLY PRINTS what it WOULD surface — it never writes
 * to the notifications store and never persists dedup state. Uses real
 * listConnections + executeTool (read-only mail list).
 */
process.env.CLEMENTINE_HOME = process.env.CLEMENTINE_HOME || `${process.env.HOME}/.clementine-next`;
process.env.CLEMMY_INBOX_MONITOR = 'on';

const { processInboxMonitor } = await import('../src/agents/inbox-monitor.js');
const { listConnectedToolkits, executeComposioTool } = await import('../src/integrations/composio/client.js');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass++; };
const no = (m: string, d = '') => { console.log(`   \x1b[31m✗\x1b[0m ${m}${d ? ' — ' + d : ''}`); fail++; };

console.log('\n\x1b[1m== C2 inbox-monitor live smoke (READ-ONLY, no writes) ==\x1b[0m');

const surfaced: any[] = [];
const toolSlugs: string[] = [];
let firstRespKeys = '';
let firstMsgCount = -1;

const deps = {
  listConnections: listConnectedToolkits,
  executeTool: (async (slug: string, args: any, conn?: string) => {
    toolSlugs.push(slug);
    const r = await executeComposioTool(slug, args, conn);
    if (!firstRespKeys && r && typeof r === 'object') {
      firstRespKeys = Object.keys(r as any).join(',');
      const data = (r as any).data;
      const arr = data?.value ?? data?.messages ?? (r as any).value ?? (r as any).messages;
      firstMsgCount = Array.isArray(arr) ? arr.length : -1;
    }
    return r;
  }),
  notify: (n: any) => surfaced.push(n),          // collect, do NOT write to the store
  config: () => ({ enabled: true, intervalMs: 0, maxPerScan: 10, fetchTop: 25 }),
  proactiveWorkAllowed: () => true,
  now: () => Date.now(),
  loadState: () => ({ surfacedIds: [] as string[] }),
  saveState: (_s: any) => { /* no-op: never persist during the smoke */ },
};

try {
  const conns = await listConnectedToolkits();
  const mail = conns.filter((c) => c.status === 'ACTIVE' && /outlook|gmail/.test(c.slug));
  if (mail.length > 0) ok(`found ${mail.length} active mailbox connection(s): ${mail.map((m) => m.slug).join(', ')}`);
  else no('no active mailbox connections found');

  const n = await processInboxMonitor(deps as any);

  // The READ action ran and the real response parsed into a message array.
  if (toolSlugs.length > 0 && toolSlugs.every((s) => /LIST_MAIL_FOLDER_MESSAGES|FETCH_EMAILS/.test(s))) {
    ok(`read-only list action(s) called: ${[...new Set(toolSlugs)].join(', ')} (never a send/mutate slug)`);
  } else {
    no('unexpected tool slugs', toolSlugs.join(', '));
  }
  if (firstMsgCount >= 0) ok(`real response parsed: response keys=[${firstRespKeys}], ${firstMsgCount} unread message(s) read`);
  else no('could not locate the message array in the real response', `keys=[${firstRespKeys}] — parser may need a path tweak`);

  console.log(`\n   would surface ${n} needs-you card(s):`);
  for (const c of surfaced) {
    console.log(`     • ${c.title}`);
    console.log(`       ${(c.metadata?.reasons ?? []).join(', ')} | account: ${c.metadata?.account}`);
    if (c.silent !== true) no('card not dashboard-only (silent)', c.title);
  }
  if (surfaced.every((c) => c.metadata?.needsAttention === true && c.silent === true)) ok('all surfaced cards are needs-you + dashboard-only (silent)');
  ok(`live run completed cleanly (surfaced ${n}, no writes, no state persisted)`);
} catch (e) {
  no('live run threw', (e as Error)?.message?.slice(0, 200));
}

console.log(`\n\x1b[1m== ${pass} passed, ${fail} failed ==\x1b[0m\n`);
process.exit(fail ? 1 : 0);
