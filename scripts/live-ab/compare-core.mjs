/**
 * Live A/B comparison over whole observations.
 *
 * One observation is one real pass of one test: its terminal, its own
 * assertions, the work it took and whether the daemon was quiet while it ran.
 * Nothing here composes a "best" run out of the best metric from different
 * passes, and a failing baseline is never permission for a failing candidate:
 * both failing is reported as unresolved, not as a match.
 *
 * Time is reported as the turn's wall time and the cumulative model work the
 * receipt certifies. Their difference is not host overhead (calls overlap), so
 * it is not computed. Timing is judged only between passes that ran on a
 * quiet daemon on both sides.
 */

const median = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const range = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
};

/** One pass, from the runner's row and (when present) the proof receipt it wrote. */
export function observationFrom(row, receipt) {
  const turn = receipt?.turns?.[0] ?? null;
  const m = turn?.measurement ?? {};
  const receiptFailures = Array.isArray(turn?.assertions?.failures) ? turn.assertions.failures : null;
  const failures = receiptFailures ?? [
    ...(row.repairs ? [`argument repairs: ${row.repairs}`] : []),
    ...(Array.isArray(row.otherFailures) ? row.otherFailures : []),
  ];
  const repairMatch = failures.map((f) => /^argument repairs: (\d+)/.exec(f)).find(Boolean);
  const terminal = turn?.terminal?.turnOutcome?.status ?? m.terminalStatus ?? row.terminal ?? null;
  const assertionsPassed = typeof turn?.assertions?.passed === 'boolean'
    ? turn.assertions.passed
    : receiptFailures === null && row.otherFailures === undefined ? null : failures.length === 0;
  const busyAtStart = Array.isArray(row.busyAtStart) ? row.busyAtStart : null;
  const busyAtEnd = Array.isArray(row.busyAtEnd) ? row.busyAtEnd : null;
  return {
    id: row.id,
    pass: row.pass,
    terminal,
    assertionsPassed,
    failures,
    rounds: turn?.modelRequests ?? row.modelRequests ?? null,
    repairs: repairMatch ? Number(repairMatch[1]) : (typeof row.repairs === 'number' ? row.repairs : null),
    promptTokens: m.promptTokens ?? row.promptTokens ?? null,
    uncachedInputTokens: m.uncachedInputTokens ?? row.uncachedInputTokens ?? null,
    outputTokens: m.outputTokens ?? row.outputTokens ?? null,
    wallMs: m.turnWallMs ?? row.wallMs ?? null,
    /** Cumulative model work as the receipt certifies it; overlapping calls are summed. */
    modelWorkMs: m.sdkDurationMs ?? null,
    usage: {
      certified: typeof m.usageAttributionCertified === 'boolean' ? m.usageAttributionCertified : null,
      uncertifiedCalls: typeof m.uncertifiedUsageCalls === 'number' ? m.uncertifiedUsageCalls : null,
      invalidCalls: typeof m.invalidUsageCalls === 'number' ? m.invalidUsageCalls : null,
    },
    /** Quiet is a measurement, not a default: unknown liveness counts as contended. */
    contended: row.liveness === 'unknown' || busyAtStart === null
      || busyAtStart.length > 0 || (busyAtEnd !== null && busyAtEnd.length > 0),
    reply: String(turn?.terminal?.reply ?? row.reply ?? ''),
  };
}

const failed = (o) => o.terminal !== 'done' || o.assertionsPassed !== true;
const failureKinds = (obs) => new Set(obs.flatMap((o) => [
  ...(o.terminal !== 'done' ? [`terminal ${o.terminal ?? 'unknown'}`] : []),
  ...(o.assertionsPassed === null ? ['assertions unknown'] : []),
  ...o.failures.map((f) => f.replace(/\d+/g, 'N')),
]));

export function summarize(obs) {
  const quiet = obs.filter((o) => !o.contended);
  return {
    passes: obs.length,
    failedPasses: obs.filter(failed).length,
    failures: obs.flatMap((o) => o.failures.map((f) => `p${o.pass}: ${f}`)),
    rounds: { median: median(obs.map((o) => o.rounds)), range: range(obs.map((o) => o.rounds)) },
    repairs: { median: median(obs.map((o) => o.repairs)), range: range(obs.map((o) => o.repairs)) },
    promptTokens: { median: median(obs.map((o) => o.promptTokens)), range: range(obs.map((o) => o.promptTokens)) },
    uncachedInputTokens: { median: median(obs.map((o) => o.uncachedInputTokens)) },
    wallMs: { median: median(obs.map((o) => o.wallMs)), range: range(obs.map((o) => o.wallMs)) },
    quietWallMs: { median: median(quiet.map((o) => o.wallMs)), passes: quiet.length },
    modelWorkMs: { median: median(obs.map((o) => o.modelWorkMs)) },
    usageComplete: obs.every((o) => o.usage.certified === true && o.usage.uncertifiedCalls === 0 && o.usage.invalidCalls === 0),
    usageUnknown: obs.some((o) => o.usage.certified === null || o.usage.uncertifiedCalls === null),
  };
}

/**
 * Verdict for one test. `regression` when B is worse on correctness, work or
 * quiet-measured time; `unresolved` when both sides fail (a defect to fix, not
 * a match); `incomparable` when B has no observation.
 */
export function compareTest(aObs, bObs) {
  if (bObs.length === 0) return { verdict: 'incomparable', reasons: ['no observation in B'] };
  const a = summarize(aObs);
  const b = summarize(bObs);
  const reasons = [];
  const aRate = a.passes ? a.failedPasses / a.passes : 0;
  const bRate = b.failedPasses / b.passes;
  if (bRate > aRate) reasons.push(`B failed ${b.failedPasses}/${b.passes} passes, A ${a.failedPasses}/${a.passes}`);
  const aKinds = failureKinds(aObs);
  const newKinds = [...failureKinds(bObs)].filter((k) => !aKinds.has(k));
  if (newKinds.length) reasons.push(`B failure not seen in A: ${newKinds.join('; ')}`);
  if (a.promptTokens.median && b.promptTokens.median && b.promptTokens.median > a.promptTokens.median * 1.2) {
    reasons.push(`median prompt tokens ${a.promptTokens.median}→${b.promptTokens.median}`);
  }
  if (a.rounds.median != null && b.rounds.median != null && b.rounds.median > a.rounds.median + 1) {
    reasons.push(`median rounds ${a.rounds.median}→${b.rounds.median}`);
  }
  if (a.repairs.median != null && b.repairs.median != null && b.repairs.median > a.repairs.median) {
    reasons.push(`median repairs ${a.repairs.median}→${b.repairs.median}`);
  }
  const notes = [];
  if (a.quietWallMs.passes && b.quietWallMs.passes) {
    const aw = a.quietWallMs.median; const bw = b.quietWallMs.median;
    if (bw > Math.max(aw * 1.5, aw + 5_000)) reasons.push(`median quiet wall ${aw}→${bw} ms`);
  } else {
    notes.push('timing not judged: no quiet pass on one side');
  }
  if (!a.usageComplete || !b.usageComplete) {
    notes.push(a.usageUnknown || b.usageUnknown ? 'usage completeness unknown' : 'usage incomplete (uncertified or invalid calls)');
  }
  const verdict = reasons.length ? 'regression' : (a.failedPasses > 0 && b.failedPasses > 0 ? 'unresolved' : 'ok');
  if (verdict === 'unresolved') reasons.push(`both fail: A ${a.failedPasses}/${a.passes}, B ${b.failedPasses}/${b.passes}`);
  return { verdict, reasons, notes, a, b };
}

/** Whole-run verdict: no regression and nothing unresolved or incomparable. */
export function compareRuns(aTests, bTests) {
  const ids = [...new Set([...aTests, ...bTests].map((o) => o.id))];
  const results = ids.map((id) => ({ id, ...compareTest(aTests.filter((o) => o.id === id), bTests.filter((o) => o.id === id)) }));
  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    results,
    regressions: count('regression'),
    unresolved: count('unresolved'),
    incomparable: count('incomparable'),
    verdict: count('regression') ? 'REGRESSION' : count('unresolved') || count('incomparable') ? 'NOT QUALIFIED' : 'NO REGRESSION',
  };
}
