import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ClementineAssistant } from '../assistant/core.js';
import { SessionStore } from '../memory/session-store.js';
import { PlanStore } from '../planning/plan-store.js';
import { buildDeepTaskPrompt, extractSteps, saveDeepTaskPlan } from '../planning/deep-task.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { LOCAL_MCP_ENABLED, ASSISTANT_NAME } from '../config.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';
import { formatAuthStatus } from '../runtime/auth-store.js';
import { createRuntimeFromConfig } from '../runtime/factory.js';
import {
  RESET, BOLD, DIM, GREEN, CYAN, YELLOW, ORANGE, RED,
  renderMarkdown, thinking,
} from './ui.js';

function printHeader(sessionId: string): void {
  console.log();
  console.log(`  ${ORANGE}${BOLD}${ASSISTANT_NAME}${RESET}  ${DIM}session ${sessionId.slice(0, 8)}  •  /help for commands  •  Ctrl+C to exit${RESET}`);
  console.log();
}

function printHelp(): void {
  console.log();
  console.log(`  ${BOLD}Commands${RESET}`);
  console.log(`  ${CYAN}/help${RESET}                   ${DIM}Show this${RESET}`);
  console.log(`  ${CYAN}/auth${RESET}                   ${DIM}Show auth status${RESET}`);
  console.log(`  ${CYAN}/tools${RESET}                  ${DIM}List available MCP tools${RESET}`);
  console.log(`  ${CYAN}/history${RESET}                ${DIM}Show recent transcript${RESET}`);
  console.log(`  ${CYAN}/plans${RESET}                  ${DIM}List saved plans${RESET}`);
  console.log(`  ${CYAN}/plan <id>${RESET}              ${DIM}Show a plan's steps${RESET}`);
  console.log(`  ${CYAN}/done <planId> <stepId>${RESET} ${DIM}Mark a plan step done${RESET}`);
  console.log(`  ${CYAN}/deep <task>${RESET}            ${DIM}Deep planning pass — saves a plan${RESET}`);
  console.log(`  ${CYAN}/approvals${RESET}              ${DIM}List pending approvals${RESET}`);
  console.log(`  ${CYAN}/approve <id>${RESET}           ${DIM}Approve a pending action${RESET}`);
  console.log(`  ${CYAN}/reject <id>${RESET}            ${DIM}Reject a pending action${RESET}`);
  console.log(`  ${CYAN}/session <id>${RESET}           ${DIM}Switch to a different session${RESET}`);
  console.log(`  ${CYAN}/exit${RESET}                   ${DIM}Quit${RESET}`);
  console.log();
}

function printResponse(name: string, text: string): void {
  console.log();
  console.log(`  ${GREEN}${BOLD}${name}${RESET}`);
  const rendered = renderMarkdown(text);
  const indented = rendered.split('\n').map((line) => `  ${line}`).join('\n');
  console.log(indented);
  console.log();
}

export async function startChatCli(): Promise<void> {
  const runtime = createRuntimeFromConfig();
  const assistant = new ClementineAssistant(runtime);
  const sessions = new SessionStore();
  const plans = new PlanStore();
  const rl = readline.createInterface({ input, output });

  let sessionId = assistant.createSessionId();

  printHeader(sessionId);
  printHelp();

  while (true) {
    let line: string;
    try {
      line = (await rl.question(`  ${GREEN}>${RESET} `)).trim();
    } catch {
      break; // Ctrl+C / EOF
    }
    if (!line) continue;

    // --- Commands ---
    if (line === '/exit' || line === '/quit') break;

    if (line === '/help') { printHelp(); continue; }

    if (line === '/auth') {
      console.log();
      console.log(`  ${DIM}${formatAuthStatus().split('\n').join('\n  ')}${RESET}`);
      console.log();
      continue;
    }

    if (line === '/tools') {
      console.log();
      console.log(`  ${BOLD}Local MCP server${RESET}  ${DIM}${LOCAL_MCP_ENABLED ? 'enabled' : 'disabled'}${RESET}`);
      if (LOCAL_MCP_ENABLED) {
        for (const toolName of LOCAL_MCP_TOOL_NAMES) {
          console.log(`  ${DIM}·${RESET} ${toolName}`);
        }
      }
      const externalServers = discoverMcpServers();
      console.log();
      console.log(`  ${BOLD}External MCP servers${RESET}`);
      if (externalServers.length === 0) {
        console.log(`  ${DIM}none discovered${RESET}`);
      } else {
        for (const server of externalServers) {
          const state = server.enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`;
          console.log(`  ${DIM}·${RESET} ${server.name}  ${DIM}${server.type} • ${server.source}${RESET}  ${state}`);
        }
      }
      console.log();
      continue;
    }

    if (line === '/history') {
      const history = sessions.recentTranscript(sessionId, 20);
      console.log();
      console.log(history ? `  ${DIM}${history}${RESET}` : `  ${DIM}No history yet.${RESET}`);
      console.log();
      continue;
    }

    if (line === '/approvals') {
      const approvals = runtime.listPendingApprovals();
      console.log();
      if (approvals.length === 0) {
        console.log(`  ${DIM}No pending approvals.${RESET}`);
      } else {
        for (const a of approvals) {
          console.log(`  ${YELLOW}!${RESET}  ${BOLD}${a.toolName}${RESET}  ${DIM}${a.id}  session ${a.sessionId.slice(0, 8)}${RESET}`);
        }
      }
      console.log();
      continue;
    }

    if (line.startsWith('/approve ')) {
      const id = line.slice('/approve '.length).trim();
      const done = thinking();
      const result = await runtime.resolveApproval(id, true);
      done();
      printResponse(ASSISTANT_NAME, result.text);
      continue;
    }

    if (line.startsWith('/reject ')) {
      const id = line.slice('/reject '.length).trim();
      const done = thinking();
      const result = await runtime.resolveApproval(id, false);
      done();
      printResponse(ASSISTANT_NAME, result.text);
      continue;
    }

    if (line.startsWith('/session ')) {
      sessionId = line.slice('/session '.length).trim();
      console.log(`\n  ${DIM}Switched to session ${sessionId}${RESET}\n`);
      continue;
    }

    if (line === '/plans') {
      const items = plans.list(10);
      console.log();
      if (items.length === 0) {
        console.log(`  ${DIM}No plans yet.${RESET}`);
      } else {
        for (const plan of items) {
          const done = plan.steps.filter((s) => s.status === 'done').length;
          console.log(`  ${CYAN}${plan.id}${RESET}  ${plan.title}  ${DIM}${done}/${plan.steps.length} done${RESET}`);
        }
      }
      console.log();
      continue;
    }

    if (line.startsWith('/plan ')) {
      const id = line.slice('/plan '.length).trim();
      const plan = plans.get(id);
      console.log();
      if (!plan) {
        console.log(`  ${RED}Plan not found.${RESET}`);
      } else {
        console.log(`  ${BOLD}${plan.title}${RESET}  ${DIM}${plan.id}${RESET}`);
        for (const step of plan.steps) {
          const icon = step.status === 'done' ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
          console.log(`  ${icon}  ${step.text}  ${DIM}[${step.id}]${RESET}`);
        }
      }
      console.log();
      continue;
    }

    if (line.startsWith('/done ')) {
      const [, planId, stepId] = line.split(/\s+/);
      if (!planId || !stepId) {
        console.log(`\n  ${DIM}Usage: /done <planId> <stepId>${RESET}\n`);
        continue;
      }
      const plan = plans.updateStep(planId, stepId, 'done');
      if (!plan) {
        console.log(`\n  ${RED}Plan or step not found.${RESET}\n`);
      } else {
        console.log(`\n  ${GREEN}✓${RESET}  Marked ${stepId} done in ${plan.title}\n`);
      }
      continue;
    }

    if (line.startsWith('/deep ')) {
      const task = line.slice('/deep '.length).trim();
      if (!task) {
        console.log(`\n  ${DIM}Usage: /deep <task description>${RESET}\n`);
        continue;
      }
      const done = thinking();
      const response = await respondPreferHarness('cli', {
        sessionId,
        channel: 'cli',
        message: buildDeepTaskPrompt(task),
        model: 'gpt-4.1',
      }, (req) => assistant.respond(req));
      done();
      const steps = extractSteps(response.text);
      if (steps.length > 0) {
        const planId = saveDeepTaskPlan(task, steps, sessionId);
        console.log(`\n  ${GREEN}✓${RESET}  Plan saved as ${CYAN}${planId}${RESET}`);
      }
      printResponse(ASSISTANT_NAME, response.text);
      continue;
    }

    // --- Normal message ---
    const done = thinking();
    // CANON-ONE-LOOP: legacy CLI rides the gated harness loop; kill-switch CLEMMY_HARNESS_CLI=off.
    const response = await respondPreferHarness('cli', { sessionId, channel: 'cli', message: line }, (req) => assistant.respond(req));
    done();
    printResponse(ASSISTANT_NAME, response.text);
  }

  rl.close();
  console.log(`\n  ${DIM}Goodbye.${RESET}\n`);
}
