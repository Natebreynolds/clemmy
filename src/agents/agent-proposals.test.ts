/**
 * Run: npx tsx --test src/agents/agent-proposals.test.ts
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-proposals-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  approveAgentProposal,
  getAgentProposal,
  listAgentProposals,
  proposeAgentDefinition,
  rejectAgentProposal,
  scoreAgentCreationNeed,
} = await import('./agent-proposals.js');
const { agentFilePath, loadTeamAgents } = await import('../tools/shared.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(`${TEST_HOME}/state`, { recursive: true });
});

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(`${TEST_HOME}/state/agent-proposals`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/Vault/00-System/agents`, { recursive: true, force: true });
});

test('scoreAgentCreationNeed distinguishes agent, workflow, hybrid, and one-off signals', () => {
  assert.equal(
    scoreAgentCreationNeed('Create a reusable researcher agent that always checks competitors', {}).kind,
    'agent',
  );
  assert.equal(
    scoreAgentCreationNeed('Create a workflow with steps, approvals, retries, inputs, and outputs', {}).kind,
    'workflow',
  );
  assert.equal(
    scoreAgentCreationNeed('Build a workflow that uses a reusable reviewer agent every time', {}).kind,
    'workflow_with_agent',
  );
  assert.equal(
    scoreAgentCreationNeed('Quickly summarize this once for now', {}).kind,
    'one_off',
  );
});

test('proposeAgentDefinition writes a pending proposal with decision metadata', () => {
  const proposal = proposeAgentDefinition({
    originatingRequest: 'Any time we do SEO work, use a durable SEO researcher agent.',
    name: 'SEO Researcher',
    description: 'Researches competitors, keywords, and ranking gaps.',
    role: 'research',
    rationale: 'The request describes repeated SEO work and a durable specialist role.',
    allowedTools: ['memory_search', 'browser_harness_run'],
    memoryScope: 'SEO projects only',
    approvalPolicy: 'Ask before paid external API calls.',
    evalCriteria: ['Cites sources', 'Returns competitors, keywords, and gaps'],
  });

  assert.match(proposal.id, /^agp-/);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.agent.name, 'SEO Researcher');
  assert.equal(proposal.decision.kind, 'agent');
  assert.ok(proposal.decision.confidence >= 50);
  assert.equal(listAgentProposals().length, 1);
  assert.equal(getAgentProposal(proposal.id)?.memoryScope, 'SEO projects only');
});

test('approveAgentProposal promotes the draft into the existing team-agent store', () => {
  const proposal = proposeAgentDefinition({
    originatingRequest: 'Create a reviewer agent we can reuse across workflows.',
    name: 'QA Reviewer',
    description: 'Reviews claims and checks evidence before publishing.',
    role: 'review',
    rationale: 'A reusable reviewer role should be available across workflows.',
    evalCriteria: ['Flags unsupported claims'],
  });

  const out = approveAgentProposal(proposal.id);
  assert.ok(out);
  assert.equal(out.agent.slug, 'qa-reviewer');
  assert.equal(getAgentProposal(proposal.id)?.status, 'approved');
  assert.equal(loadTeamAgents().some((agent) => agent.slug === 'qa-reviewer'), true);

  const body = readFileSync(agentFilePath('qa-reviewer'), 'utf-8');
  assert.match(body, /Evaluation criteria:/);
  assert.match(body, /Flags unsupported claims/);
});

test('rejectAgentProposal resolves without creating an agent', () => {
  const proposal = proposeAgentDefinition({
    originatingRequest: 'Maybe create a temporary analyst agent for this quick task.',
    name: 'Temporary Analyst',
    description: 'Looks at a single temporary analysis task.',
    rationale: 'Testing rejection path.',
  });

  const rejected = rejectAgentProposal(proposal.id, 'one-off only');
  assert.equal(rejected?.status, 'rejected');
  assert.equal(listAgentProposals().length, 0);
  assert.equal(listAgentProposals({ status: 'all' }).length, 1);
  assert.equal(loadTeamAgents().length, 0);
});

test('approveAgentProposal refuses to overwrite an existing agent slug', () => {
  const first = proposeAgentDefinition({
    originatingRequest: 'Create a durable researcher agent.',
    name: 'Researcher',
    description: 'Reusable research specialist.',
    rationale: 'The user asked for a durable researcher.',
  });
  approveAgentProposal(first.id);

  const second = proposeAgentDefinition({
    originatingRequest: 'Create another durable researcher agent.',
    name: 'Researcher',
    description: 'Another reusable research specialist.',
    rationale: 'The user asked again.',
  });
  assert.throws(() => approveAgentProposal(second.id), /agent already exists: researcher/);
  assert.equal(getAgentProposal(second.id)?.status, 'pending');
});
