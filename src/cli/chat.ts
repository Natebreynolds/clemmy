import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ClementineAssistant } from '../assistant/core.js';
import { SessionStore } from '../memory/session-store.js';
import { PlanStore } from '../planning/plan-store.js';
import { buildDeepTaskPrompt, extractSteps, saveDeepTaskPlan } from '../planning/deep-task.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { LOCAL_MCP_ENABLED } from '../config.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';
import { formatAuthStatus } from '../runtime/auth-store.js';
import { createRuntimeFromConfig } from '../runtime/factory.js';

function printHelp(): void {
  console.log([
    '',
    'Commands:',
    '  /help                 Show commands',
    '  /approvals            List pending approvals',
    '  /approve <id>         Approve a pending action',
    '  /reject <id>          Reject a pending action',
    '  /history              Show recent session transcript',
    '  /working              Show current working memory',
    '  /tools                Show local and external MCP tooling',
    '  /auth                 Show current auth status',
    '  /plans                List saved plans',
    '  /plan <id>            Show plan details',
    '  /done <planId> <stepId>  Mark a plan step done',
    '  /deep <task>          Run a more deliberate planning pass and save a plan',
    '  /session <id>         Switch session',
    '  /exit                 Quit',
    '',
  ].join('\n'));
}

export async function startChatCli(): Promise<void> {
  const runtime = createRuntimeFromConfig();
  const assistant = new ClementineAssistant(runtime);
  const sessions = new SessionStore();
  const plans = new PlanStore();
  const rl = readline.createInterface({ input, output });

  let sessionId = assistant.createSessionId();

  console.log(`Clementine CLI ready. Session: ${sessionId}`);
  printHelp();

  while (true) {
    const line = (await rl.question('\nYou> ')).trim();
    if (!line) continue;

    if (line === '/exit') break;
    if (line === '/help') {
      printHelp();
      continue;
    }
    if (line === '/approvals') {
      const approvals = runtime.listPendingApprovals();
      if (approvals.length === 0) {
        console.log('No pending approvals.');
        continue;
      }
      for (const approval of approvals) {
        console.log(`${approval.id} | ${approval.toolName} | session ${approval.sessionId} | ${approval.createdAt}`);
      }
      continue;
    }
    if (line.startsWith('/approve ')) {
      const id = line.slice('/approve '.length).trim();
      const result = await runtime.resolveApproval(id, true);
      console.log(`Clementine> ${result.text}`);
      continue;
    }
    if (line.startsWith('/reject ')) {
      const id = line.slice('/reject '.length).trim();
      const result = await runtime.resolveApproval(id, false);
      console.log(`Clementine> ${result.text}`);
      continue;
    }
    if (line.startsWith('/session ')) {
      sessionId = line.slice('/session '.length).trim();
      console.log(`Switched to session ${sessionId}`);
      continue;
    }
    if (line === '/history') {
      const history = sessions.recentTranscript(sessionId, 20);
      console.log(history || 'No history yet.');
      continue;
    }
    if (line === '/working') {
      const history = sessions.get(sessionId);
      console.log(history.turns.length === 0 ? 'No activity in this session yet.' : 'Working memory is being maintained automatically. Check ~/.clementine-next/working-memory.md');
      continue;
    }
    if (line === '/tools') {
      console.log('Local MCP server:');
      console.log(`- ${LOCAL_MCP_ENABLED ? 'enabled' : 'disabled'}`);
      if (LOCAL_MCP_ENABLED) {
        for (const toolName of LOCAL_MCP_TOOL_NAMES) {
          console.log(`  - ${toolName}`);
        }
      }

      const externalServers = discoverMcpServers();
      console.log('\nExternal MCP servers:');
      if (externalServers.length === 0) {
        console.log('- none discovered');
      } else {
        for (const server of externalServers) {
          const state = server.enabled ? 'enabled' : 'disabled';
          console.log(`- ${server.name} [${server.type}, ${state}, ${server.source}]`);
        }
      }
      continue;
    }
    if (line === '/auth') {
      console.log(formatAuthStatus());
      continue;
    }
    if (line === '/plans') {
      const items = plans.list(10);
      if (items.length === 0) {
        console.log('No plans yet.');
        continue;
      }
      for (const plan of items) {
        const done = plan.steps.filter((step) => step.status === 'done').length;
        console.log(`${plan.id} | ${plan.title} | ${done}/${plan.steps.length} complete`);
      }
      continue;
    }
    if (line.startsWith('/plan ')) {
      const id = line.slice('/plan '.length).trim();
      const plan = plans.get(id);
      if (!plan) {
        console.log('Plan not found.');
        continue;
      }
      console.log(`${plan.id} | ${plan.title}`);
      for (const step of plan.steps) {
        console.log(`- ${step.id} [${step.status}] ${step.text}`);
      }
      continue;
    }
    if (line.startsWith('/done ')) {
      const [, planId, stepId] = line.split(/\s+/);
      if (!planId || !stepId) {
        console.log('Usage: /done <planId> <stepId>');
        continue;
      }
      const plan = plans.updateStep(planId, stepId, 'done');
      if (!plan) {
        console.log('Plan or step not found.');
        continue;
      }
      console.log(`Updated ${stepId} in ${plan.title}.`);
      continue;
    }
    if (line.startsWith('/deep ')) {
      const task = line.slice('/deep '.length).trim();
      if (!task) {
        console.log('Usage: /deep <task>');
        continue;
      }

      const response = await assistant.respond({
        sessionId,
        channel: 'cli',
        message: buildDeepTaskPrompt(task),
        model: 'gpt-5.4',
      });

      const steps = extractSteps(response.text);
      if (steps.length > 0) {
        const planId = saveDeepTaskPlan(task, steps);
        console.log(`Plan saved as ${planId}`);
      }
      console.log(`Clementine> ${response.text}`);
      continue;
    }

    const response = await assistant.respond({
      sessionId,
      channel: 'cli',
      message: line,
    });

    console.log(`Clementine> ${response.text}`);
  }

  rl.close();
}
