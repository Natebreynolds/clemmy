/** Actual approval resume, isolated stores and a scripted runner; no provider. */
import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, type Runner } from '@openai/agents';

if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Use scripts/run-tests-isolated.mjs');
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-resume-learning-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
const events = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { HostInterruptState } = await import('./host-turn-runner.js');
const { resumePendingApproval } = await import('./loop.js');
const consent = await import('./host-interactive-consent.js');
const approvals = await import('./approval-registry.js');
const { rememberFact, getFact } = await import('../../memory/facts.js');
const { recordRecallRun } = await import('../../memory/recall-usage.js');
const { closeMemoryDb } = await import('../../memory/db.js');
const { readTurnLearningPolicyForSource } = await import('../../memory/turn-learning-policy.js');
const excluded = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network in approval resume fixture'); });
after(() => { mock.restoreAll(); events.closeEventLog(); closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

for (const mode of ['exact-excluded', 'historical-unbound', 'exact-ordinary'] as const) {
  test(`approval resume learning ${mode} follows original proof rather than a newer sibling`, async () => {
    const session = HarnessSession.create({ id: `approval-learning-${mode}`, kind: 'chat', title: 'Controlled approval learning' });
    const a = events.beginRunAttempt(session.id);
    const sourceA = events.recordRunAttemptUserInput(a, { turn: 1, role: 'user', data: {
      text: 'Report this controlled fixture constraint after the exact approval.',
      ...(mode === 'exact-ordinary' ? {} : { learningPolicy: excluded }),
    } });
    const fact = rememberFact({ kind: 'project', content: `Controlled fixture constraint for ${mode}: sentinel R472 is read-only.` });
    assert.equal(getFact(fact.id)?.utilityCount, 0);
    const args = JSON.stringify({ requirement_id: 'fixture-read', name: 'read_file', args_json: '{"path":"fixture-only"}' });
    const subject = { version: 1 as const, sessionId: session.id, sourceUserSeq: sourceA.seq,
      acceptedTaskId: `task:${session.id}#${sourceA.seq}`, logicalToolCallId: `fixture-call-${mode}`,
      decisionSubjectDigest: hash(`decision:${mode}`), callDigest: hash(`call:${mode}`),
      coverageDigest: hash(`coverage:${mode}`), riskDigest: hash(`risk:${mode}`) };
    const historical = mode === 'historical-unbound';
    const cardInput = { sessionId: session.id, subject: 'Approve the controlled fixture read.',
      tool: 'work_call', args: JSON.parse(args) };
    const resumeKey = consent.hostInteractiveConsentApprovalResumeKey(subject);
    assert.ok(resumeKey);
    // A historical pause has no nominal resume key. Its existing exact
    // tool/arguments card must use the legacy registration path as well.
    const card = historical ? approvals.register(cardInput)
      : approvals.registerResumable({ ...cardInput, resumeKey }).row;
    session.saveInterruptState(new HostInterruptState([], [{ callId: subject.logicalToolCallId, name: 'work_call',
      rawItem: { name: 'work_call', arguments: args, callId: subject.logicalToolCallId },
      ...(historical ? {} : { consentSubject: subject }),
    }], undefined, 'host_v1').toString());
    // A later accepted attempt is deliberately the current/latest owner. Its
    // policy is the opposite of A, so choosing a session-wide latest row fails.
    const b = events.beginRunAttempt(session.id);
    const sourceB = events.recordRunAttemptUserInput(b, { turn: 2, role: 'user', data: {
      text: 'An unrelated newer controlled task.', ...(mode === 'exact-ordinary' ? { learningPolicy: excluded } : {}),
    } });
    assert.equal(events.getLatestRunAttempt(session.id)?.sourceUserSeq, sourceB.seq);
    let resumes = 0, recallId: string | undefined;
    try {
      const outcome = await resumePendingApproval({ sessionId: session.id, sourceUserSeq: sourceB.seq,
        approvalId: card.approvalId, decision: 'approve', resolver: 'isolated-fixture', judgeCompletion: false,
        agent: new Agent({ name: 'ApprovalLearningFixture', instructions: 'Controlled offline fixture.', tools: [] }),
        makeRunner: () => new EventEmitter() as unknown as Runner,
        runRunner: async (_runner, _agent, saved) => {
          resumes++;
          assert.ok(saved instanceof HostInterruptState);
          assert.equal(saved.pending[0]?.decision, 'approved');
          recallId = recordRecallRun({ objective: 'controlled fixture constraint', surface: 'memory_search_facts',
            answerability: 'partial', candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
            sessionId: session.id, nowIso: new Date().toISOString() }).id;
          return { history: [], lastResponseId: undefined,
            finalOutput: `The controlled fixture constraint is recorded at [fact:${fact.id}].` };
        },
      });
      assert.equal(outcome.status, 'completed', 'optional learning cannot stop the approved resume');
      assert.equal(resumes, 1); assert.ok(recallId);
      assert.equal(approvals.get(card.approvalId)?.resolution, 'approved');
      const credited = events.listEvents(session.id, { types: ['recall_auto_credit'] });
      if (mode === 'exact-ordinary') {
        assert.equal(getFact(fact.id)?.utilityCount, 1, 'the proved ordinary original earns actual credit');
        assert.equal(credited.length, 1);
        const runs = credited[0]!.data.runs as Array<{ recallId: string }>;
        assert.ok(runs.some(run => run.recallId === recallId));
      } else {
        assert.equal(getFact(fact.id)?.utilityCount, 0, 'excluded or unproved original cannot borrow ordinary B');
        assert.equal(credited.length, 0);
      }
      assert.equal(readTurnLearningPolicyForSource({ sessionId: session.id, sourceUserSeq: sourceA.seq }).status,
        mode === 'exact-ordinary' ? 'allowed' : 'excluded');
      assert.equal(readTurnLearningPolicyForSource({ sessionId: session.id, sourceUserSeq: sourceB.seq }).status,
        mode === 'exact-ordinary' ? 'excluded' : 'allowed');
      assert.equal(events.listEvents(session.id, { types: ['user_input_received'] }).length, 2, 'resume accepts no replacement task');
    } finally { events.finishRunAttempt(b, 'completed'); }
  });
}
