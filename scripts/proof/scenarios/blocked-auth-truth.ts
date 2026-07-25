/**
 * Regression proof for the Railway run that motivated the harness changes:
 * useful local work exists, the only remaining dependency is CLI auth, and the
 * user must hear both facts—not a generic "background task wasn't completed."
 *
 * Provisioning shadows `railway` with a proof-only unauthorized shim, so this
 * scenario cannot touch a real Railway account.
 */
import path from 'node:path';

import { narrationCheck, openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import {
  dispatchBackground,
  getBoardCards,
  localArtifactText,
  proofSessionId,
  waitForOutcomeEvents,
  waitForTerminal,
} from './background-proof-helpers.js';

export const blockedAuthTruth: ScenarioDef = {
  name: 'blocked-auth-truth',
  summary: 'local work done + Railway auth missing → truthful resumable report',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const originSessionId = proofSessionId('blocked-auth-origin');
    const artifactPath = path.join(daemon.home, 'proof-artifacts', 'railway-app.txt');
    const prompt = [
      'Build the local preparation for a fictional Railway app, then verify Railway CLI authentication.',
      `First call write_file to create this exact artifact: ${artifactPath}`,
      'The file must contain: LOCAL RAILWAY APP PREPARATION COMPLETE',
      'Then call run_shell_command with command `railway whoami` and cwd null.',
      'Do not call Railway through any other path, do not browse, and do not make any external write.',
      `If the CLI reports unauthorized, do not discard or redo the local artifact. Call ask_user_question with purpose "clarification", options null, and this precise useful question: "Local Railway app preparation is complete at ${artifactPath}. Deployment is the only unfinished step because Railway CLI authentication is missing. Run railway login, then reply continue so I can resume this same task."`,
      'Do not finish the task after asking that question; the task must remain parked for the answer.',
      'Never replace those facts with a generic background-task failure message.',
    ].join('\n');
    const dispatched = await dispatchBackground(daemon, originSessionId, prompt);
    const settled = await waitForTerminal(daemon, dispatched.taskId, 20 * 60_000);
    const task = settled.detail.task;
    const artifact = localArtifactText(artifactPath);
    const result = task.resultFull ?? task.result ?? task.pendingQuestion ?? task.error ?? '';
    const factualText = [
      task.resultFull,
      task.result,
      task.pendingQuestion,
      task.error,
    ].filter((value): value is string => typeof value === 'string').join('\n');
    const outcomes = await waitForOutcomeEvents(
      daemon,
      dispatched.turn.sessionId,
      task.id,
      (outcomeRows) => outcomeRows.some((event) => event.data.status === 'needs_input'),
    );
    const needsInput = outcomes.filter((event) => event.data.status === 'needs_input');
    const terminalOutcomes = outcomes.filter((event) => ['done', 'blocked', 'failed'].includes(String(event.data.status)));
    const card = (await getBoardCards(daemon)).find((candidate) => candidate.id === task.id);

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, task.runSessionId);
      db.close();
    } catch { /* checks below surface missing evidence */ }

    const genericOnly = /(?:this )?background task (?:was not|wasn't|did not) completed?.{0,120}(?:do not|don't) retr/i.test(factualText)
      && !/local (?:railway app )?preparation complete|proof-artifacts|railway login/i.test(factualText);
    const checks: Check[] = [
      {
        name: 'local work survived the auth blocker',
        pass: artifact.includes('LOCAL RAILWAY APP PREPARATION COMPLETE'),
        detail: artifact ? `${artifactPath}: ${artifact.trim().slice(0, 160)}` : `missing ${artifactPath}`,
      },
      {
        name: 'task parked as a resumable user dependency',
        pass: task.status === 'awaiting_input',
        detail: `${task.status}: ${task.pendingQuestion ?? task.error ?? result.slice(0, 260)}`,
      },
      {
        name: 'report tells the whole useful truth',
        pass: /local (?:railway app )?preparation (?:is )?complete|local work (?:is )?(?:done|complete)|LOCAL RAILWAY APP PREPARATION COMPLETE/i.test(factualText)
          && factualText.includes(artifactPath)
          && /railway login/i.test(factualText)
          && /deploy|deployment|authenticate|authentication|unauthoriz/i.test(factualText),
        detail: factualText.slice(0, 600),
      },
      {
        name: 'evidence-first snapshot survives independently of model prose',
        pass: task.outcomeSnapshot?.version === 1
          && Boolean(task.outcomeSnapshot.evidence?.artifacts?.some((entry: { ref?: string }) => entry.ref === artifactPath))
          && /railway login/i.test(task.outcomeSnapshot.nextAction ?? ''),
        detail: JSON.stringify({
          artifacts: task.outcomeSnapshot?.evidence?.artifacts,
          nextAction: task.outcomeSnapshot?.nextAction,
          resumable: task.outcomeSnapshot?.resumable,
        }).slice(0, 800),
      },
      {
        name: 'no generic harness-only non-answer',
        pass: !genericOnly,
        detail: genericOnly ? factualText.slice(0, 400) : undefined,
      },
      {
        name: 'cockpit puts the precise blocker in Needs You',
        pass: card?.column === 'needs_you'
          && card.status === 'awaiting_input'
          && /railway login|authenticate|reconnect/i.test(`${card.progressHint ?? ''}\n${card.raw?.pendingQuestion ?? ''}`),
        detail: JSON.stringify({ column: card?.column, status: card?.status, progressHint: card?.progressHint }),
      },
      {
        name: 'one needs-input outcome and no false terminal outcome',
        pass: needsInput.length === 1 && terminalOutcomes.length === 0,
        detail: JSON.stringify(outcomes.map((event) => event.data.status)),
      },
      {
        name: 'proof made no external write',
        pass: (metrics?.externalWrites ?? 0) === 0,
        detail: `${metrics?.externalWrites ?? 0} external_write event(s); tools=${JSON.stringify(metrics?.toolCalls ?? {})}`,
      },
      narrationCheck(result),
      stormCheck(daemon.log()),
    ];

    return {
      checks,
      latency: [{
        wallMs: dispatched.turn.wallMs,
        ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null,
      }],
      sessionId: task.runSessionId,
      metrics: {
        status: task.status,
        artifactPath,
        toolCalls: metrics?.toolCalls,
        tokensUsed: metrics?.tokensUsed,
        outcomeStatuses: outcomes.map((event) => event.data.status),
      },
    };
  },
};
