// refresh.reference.mjs — REUSABLE reference runner for a Salesforce deal-risk
// Workspace (skill: salesforce-deal-risk-workspace). Copy to a space's
// data/refresh.mjs and change ONLY the TEAM_LEAD line. READ-ONLY: SELECT
// queries only — never mutates Salesforce.
//
// It prints ONE JSON object to stdout: { found, teamLead, team, deals, summary,
// asOf, pulledAt }. The Workspace runner captures that as the view's data source.
import { execFileSync } from 'node:child_process';

// ── THE ONE THING TO SET ──────────────────────────────────────────────────
// The rep/team lead to build this for. Matched against active Salesforce Users.
// Use a distinctive substring of their name (resolved at runtime — never an ID).
const TEAM_LEAD = 'Example Team Lead';
// ──────────────────────────────────────────────────────────────────────────

function soql(query) {
  const out = execFileSync('sf', ['data', 'query', '--query', query, '--json'], { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  if (parsed.status !== 0) throw new Error(parsed.message || 'sf query failed');
  return parsed.result?.records ?? [];
}
const esc = (s) => String(s).replace(/'/g, "\\'");

const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const todayMs = Date.parse(todayStr + 'T00:00:00Z');
const DAY = 86400000;
const dayDiff = (laterStr, earlierMs) => Math.floor((Date.parse(laterStr.slice(0, 10) + 'T00:00:00Z') - earlierMs) / DAY);
const daysSince = (s) => (s ? Math.floor((todayMs - Date.parse(String(s).slice(0, 10) + 'T00:00:00Z')) / DAY) : null);

try {
  // 1. Resolve the team lead at runtime (no hardcoded IDs).
  const lastTok = TEAM_LEAD.trim().split(/\s+/).pop();
  const candidates = soql(`SELECT Id, Name, Email FROM User WHERE Name LIKE '%${esc(lastTok)}%' AND IsActive = true`);
  const lead = candidates.find((u) => u.Name.toLowerCase().includes(TEAM_LEAD.toLowerCase())) || candidates[0];
  if (!lead) {
    process.stdout.write(JSON.stringify({ found: false, message: `${TEAM_LEAD} was not found as an active Salesforce user.`, pulledAt: new Date().toISOString() }));
    process.exit(0);
  }

  // 2. Team = lead + active direct reports.
  const reports = soql(`SELECT Id, Name, Email, Title FROM User WHERE ManagerId = '${esc(lead.Id)}' AND IsActive = true ORDER BY Name`);
  const team = [{ Id: lead.Id, Name: lead.Name, Email: lead.Email, Title: 'Team lead' }, ...reports];
  const idList = team.map((u) => `'${esc(u.Id)}'`).join(',');

  // 3. Open opportunities (read-only). NextStep included for the "why".
  const opps = soql(
    `SELECT Id, Name, Account.Name, Owner.Name, Amount, StageName, CloseDate, Probability, CreatedDate, LastActivityDate, NextStep ` +
    `FROM Opportunity WHERE OwnerId IN (${idList}) AND IsClosed = false ORDER BY CloseDate ASC`
  );
  const oppIds = opps.map((o) => `'${esc(o.Id)}'`).join(',');

  // 3b. Concrete communications — logged Tasks (emails + calls) per opp.
  const commsByOpp = new Map();
  if (oppIds) {
    const tasks = soql(`SELECT WhatId, TaskSubtype, Type, ActivityDate, CreatedDate FROM Task WHERE WhatId IN (${oppIds}) ORDER BY ActivityDate DESC NULLS LAST`);
    for (const t of tasks) {
      const wid = t.WhatId; if (!wid) continue;
      const when = t.ActivityDate || (t.CreatedDate ? String(t.CreatedDate).slice(0, 10) : null);
      const isEmail = t.TaskSubtype === 'Email' || /email/i.test(t.Type || '');
      const rec = commsByOpp.get(wid) || { lastEmail: null, emailCount: 0, lastTouch: null, touchCount: 0 };
      rec.touchCount += 1;
      if (when && (!rec.lastTouch || when > rec.lastTouch)) rec.lastTouch = when;
      if (isEmail) { rec.emailCount += 1; if (when && (!rec.lastEmail || when > rec.lastEmail)) rec.lastEmail = when; }
      commsByOpp.set(wid, rec);
    }
  }

  // 3c. Notes (ContentNotes) per opp — sparse but real when present; fail-open.
  const notesByOpp = new Map();
  try {
    if (oppIds) for (const l of soql(`SELECT LinkedEntityId FROM ContentDocumentLink WHERE LinkedEntityId IN (${oppIds})`)) {
      notesByOpp.set(l.LinkedEntityId, (notesByOpp.get(l.LinkedEntityId) || 0) + 1);
    }
  } catch { /* notes optional */ }

  const thisMonth = todayStr.slice(0, 7);
  const nm = new Date(todayMs); nm.setUTCMonth(nm.getUTCMonth() + 1);
  const nextMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(nm).slice(0, 7);

  const deals = opps.map((o) => {
    const amount = o.Amount == null ? null : Number(o.Amount);
    const prob = o.Probability == null ? null : Number(o.Probability);
    const stage = o.StageName || '—';
    const ageDays = Math.floor((todayMs - Date.parse(o.CreatedDate)) / DAY);
    const daysToClose = dayDiff(o.CloseDate, todayMs);
    const overdue = daysToClose < 0 ? -daysToClose : 0;
    const nextStep = (o.NextStep || '').trim() || null;
    const comms = commsByOpp.get(o.Id) || { lastEmail: null, emailCount: 0, lastTouch: null, touchCount: 0 };
    const daysSinceEmail = daysSince(comms.lastEmail);
    const daysSinceTouch = daysSince(comms.lastTouch);
    const notesCount = notesByOpp.get(o.Id) || 0;
    const isEarly = prob != null && prob <= 25;
    const isLate = prob != null && prob >= 90;
    const big = amount != null && amount >= 20000;

    const slip = [];
    if (overdue > 0) slip.push(`Close date passed ${overdue}d ago, still open`);
    else if (daysToClose <= 7 && isEarly) slip.push(`Closes in ${daysToClose}d but only ${stage} (${prob}%)`);

    const engagement = [];
    if (comms.emailCount === 0 && comms.touchCount === 0) engagement.push('No emails or calls ever logged');
    else if (comms.emailCount === 0) engagement.push(daysSinceTouch != null ? `No email thread (calls only, last touch ${daysSinceTouch}d ago)` : 'No email thread logged');
    else if (daysSinceEmail != null && daysSinceEmail > 30) engagement.push(`No email in ${daysSinceEmail}d`);
    else if (daysSinceEmail != null && daysSinceEmail > 14) engagement.push(`Last email ${daysSinceEmail}d ago`);
    if (!nextStep && notesCount === 0) engagement.push('No next step or notes on file');
    else if (!nextStep) engagement.push('No next step set');
    if (ageDays > 120 && !isLate) engagement.push(`${ageDays}d old, still ${stage}`);

    const shape = [];
    if (daysToClose >= 0 && daysToClose <= 7 && prob != null && prob > 25 && prob < 90) shape.push(`Closes in ${daysToClose}d, still ${stage}`);
    if (isEarly) shape.push(`Low probability ${prob}% in ${stage}`);
    if (big && !isLate) shape.push(`$${amount.toLocaleString()} stuck in ${stage}`);

    const signals = [...engagement, ...shape];
    const staleEng = comms.emailCount === 0 || (daysSinceEmail != null && daysSinceEmail > 30) || (!nextStep && notesCount === 0);
    let tier, reason;
    if (slip.length) { tier = 'Likely to Slip'; reason = engagement[0] ? `${slip[0]}; ${engagement[0]}` : slip[0]; }
    else if (signals.length >= 2 || (signals.length === 1 && (staleEng || (big && !isLate)))) { tier = 'At Risk'; reason = signals.slice(0, 2).join('; '); }
    else {
      tier = 'On Track';
      const bits = [stage]; if (prob != null) bits.push(`${prob}%`); bits.push(`closes in ${daysToClose}d`);
      if (daysSinceEmail != null && daysSinceEmail <= 14) bits.push(`emailed ${daysSinceEmail}d ago`);
      if (nextStep) bits.push('next step set');
      reason = bits.join(', ');
    }
    const closeMonth = o.CloseDate.slice(0, 7);
    return {
      id: o.Id, name: o.Name, account: o.Account?.Name || '—', owner: o.Owner?.Name || '—',
      amount, stage, closeDate: o.CloseDate, probability: prob, ageDays, daysToClose, overdue,
      lastActivityDate: o.LastActivityDate || null, daysSinceActivity: daysSince(o.LastActivityDate),
      nextStep, lastEmailDate: comms.lastEmail, daysSinceEmail, emailCount: comms.emailCount,
      lastTouchDate: comms.lastTouch, touchCount: comms.touchCount, notesCount,
      tier, reason, closesThisMonth: closeMonth === thisMonth, closesNextMonth: closeMonth === nextMonth,
    };
  });

  const sum = (arr, f) => arr.reduce((a, b) => a + (f(b) || 0), 0);
  const byStage = {}; for (const d of deals) { (byStage[d.stage] ||= { count: 0, value: 0 }); byStage[d.stage].count++; byStage[d.stage].value += d.amount || 0; }
  const byTier = { 'On Track': 0, 'At Risk': 0, 'Likely to Slip': 0 }; for (const d of deals) byTier[d.tier]++;
  const tierValue = { 'On Track': 0, 'At Risk': 0, 'Likely to Slip': 0 }; for (const d of deals) tierValue[d.tier] += d.amount || 0;

  process.stdout.write(JSON.stringify({
    found: true,
    teamLead: { name: lead.Name, email: lead.Email },
    team: team.map((u) => ({ name: u.Name, title: u.Title || '—', email: u.Email })),
    deals,
    summary: {
      totalOpen: deals.length, totalOpenValue: sum(deals, (d) => d.amount), valueAtRisk: sum(deals.filter((d) => d.tier !== 'On Track'), (d) => d.amount),
      byStage, byTier, tierValue,
      closingThisMonth: deals.filter((d) => d.closesThisMonth).length, closingThisMonthValue: sum(deals.filter((d) => d.closesThisMonth), (d) => d.amount),
      closingNextMonth: deals.filter((d) => d.closesNextMonth).length, closingNextMonthValue: sum(deals.filter((d) => d.closesNextMonth), (d) => d.amount),
      engagement: { noEmail: deals.filter((d) => d.emailCount === 0).length, staleEmail: deals.filter((d) => d.daysSinceEmail != null && d.daysSinceEmail > 30).length, noNextStep: deals.filter((d) => !d.nextStep).length },
      thisMonthLabel: thisMonth, nextMonthLabel: nextMonth,
    },
    asOf: todayStr, pulledAt: new Date().toISOString(),
  }));
} catch (e) {
  process.stderr.write(String(e?.message ?? e));
  process.exit(1);
}
