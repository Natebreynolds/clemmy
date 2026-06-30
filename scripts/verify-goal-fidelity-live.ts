/**
 * Live bounce-only verification for the goal-fidelity gate (design §7).
 *
 * Exercises the REAL Codex judge (gpt-5.5 via the OAuth wallet) and the REAL
 * gate code against the real home — but calls evaluateGoalFidelity DIRECTLY.
 * No send tool, no publish, no agent turn → ZERO real outbound. It only seeds
 * a couple of throwaway chat sessions in the eventlog and asks the gate whether
 * it would bounce.
 *
 *   - SCORPION: scorpion-outbound skill (per-firm research REQUIRED) + a 3rd
 *     byte-identical generic opening across distinct firms → expect the real
 *     judge to BOUNCE. Control: a distinct, researched opening → expect ALLOW.
 *   - LUNAR: lunar-local-audit skill prescribes scripts/generate-html.js and it
 *     never ran → expect a DETERMINISTIC renderer bounce (judge not called).
 *
 * Run: npx tsx scripts/verify-goal-fidelity-live.ts
 */
process.env.CLEMENTINE_HOME = process.env.CLEMENTINE_HOME || '/Users/nathan.reynolds/.clementine-next';

const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.js');
const { createSession, appendEvent, writeToolOutput } = await import('../src/runtime/harness/eventlog.js');
const { evaluateGoalFidelity } = await import('../src/runtime/harness/goal-fidelity-gate.js');

const cfg = await configureHarnessRuntime();
console.log(`harness runtime: ${cfg.ok ? 'OK — Codex/brain provider registered (real judge live)' : `NOT READY → ${cfg.reason}`}`);
if (!cfg.ok) {
  console.log('Cannot exercise the real judge without the brain provider. The scorpion case will fail-open (allow).');
}

let seq = 0;
function seedSkill(sid: string, name: string, body: string): void {
  const callId = `verify_skill_${name}_${seq++}`;
  appendEvent({ sessionId: sid, turn: 0, role: 'orchestrator', type: 'tool_called', data: { tool: 'skill_read', callId, arguments: JSON.stringify({ name }) } });
  writeToolOutput({ sessionId: sid, callId, tool: 'skill_read', output: `SKILL: ${name}\n(manifest)\n---\n${body}` });
}
function seedGoal(sid: string, text: string): void {
  appendEvent({ sessionId: sid, turn: 0, role: 'user', type: 'user_input_received', data: { text } });
}
function seedSend(sid: string, slug: string, to: string, body: string): void {
  const callId = `verify_send_${to}_${seq++}`;
  appendEvent({ sessionId: sid, turn: 0, role: 'orchestrator', type: 'tool_called', data: { tool: 'composio_execute_tool', callId, arguments: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify({ to_email: to, subject: 's', body }) }) } });
}
function sendArgs(slug: string, to: string, body: string): unknown {
  return { tool_slug: slug, arguments: JSON.stringify({ to_email: to, subject: 's', body }) };
}

const GENERIC = 'Our agency helps law firms dominate local search with SEO, paid media, and conversion-focused websites that turn searchers into signed clients. I would love to show you what we can do for your practice.';

// ─── SCORPION (real judge) ────────────────────────────────────────────────
const s1 = createSession({ kind: 'chat' });
seedGoal(s1.id, 'Email each firm a personalized outreach note that references our specific per-firm SEO research findings for that firm.');
seedSkill(s1.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nBefore writing ANY email, research that SPECIFIC firm — its practice areas, recent wins, and current local-search gaps — and weave at least one firm-specific finding into the opening. NEVER reuse a generic opening across firms. Generic, identical outreach is a failure of this skill.');
seedSend(s1.id, 'OUTLOOK_OUTLOOK_SEND_EMAIL', 'a@firm-a.com', GENERIC);
seedSend(s1.id, 'OUTLOOK_OUTLOOK_SEND_EMAIL', 'b@firm-b.com', GENERIC);

console.log('\n── SCORPION (real judge): 3rd byte-identical generic opening to a distinct firm ──');
const scorpion = await evaluateGoalFidelity(s1.id, 'composio_execute_tool', sendArgs('OUTLOOK_OUTLOOK_SEND_EMAIL', 'c@firm-c.com', GENERIC));
console.log(JSON.stringify(scorpion, null, 2));
console.log(scorpion.action === 'block'
  ? `✅ BOUNCED — ${scorpion.mode} mode; gap: ${scorpion.reason}`
  : `❌ ALLOWED — the real judge did not catch the generic-across-firms send (reason: ${scorpion.reason})`);

console.log('\n── SCORPION control: a distinct, researched opening (should ALLOW) ──');
const scorpionOk = await evaluateGoalFidelity(s1.id, 'composio_execute_tool', sendArgs('OUTLOOK_OUTLOOK_SEND_EMAIL', 'd@firm-d.com',
  'I read about your firm\'s recent $4.2M mesothelioma verdict in the Birmingham Business Journal, and noticed your new asbestos-litigation page is not yet ranking for "Birmingham mesothelioma lawyer" despite that win — that specific gap is why I reached out.'));
console.log(`${scorpionOk.action === 'allow' ? '✅' : '⚠️'} ${scorpionOk.action} — ${scorpionOk.reason}`);

// ─── LUNAR (deterministic renderer floor) ─────────────────────────────────
const s2 = createSession({ kind: 'chat' });
seedGoal(s2.id, 'Run the lunar local audit for Revill Law and publish the report.');
seedSkill(s2.id, 'lunar-local-audit', '## Render\nAfter gathering the data, run scripts/generate-html.js to produce the report, then publish dist/index.html.');

console.log('\n── LUNAR (deterministic): publish attempted, generate-html.js never ran ──');
const lunar = await evaluateGoalFidelity(s2.id, 'composio_execute_tool', sendArgs('NETLIFY_DEPLOY_SITE_PUBLISH', 'ignored@x.com', 'publish dist/index.html'));
console.log(JSON.stringify(lunar, null, 2));
console.log(lunar.action === 'block' && lunar.mode === 'renderer'
  ? `✅ BOUNCED deterministically — ${lunar.reason}`
  : `❌ ${lunar.action}/${lunar.mode} — expected a renderer bounce`);

console.log('\nNo send tool was invoked and no publish ran — the gate was called directly. Zero real outbound.');
console.log(`(Seeded throwaway verify sessions: ${s1.id}, ${s2.id})`);
process.exit(0);
