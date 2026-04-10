import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AGENTS_DIR,
  DELEGATIONS_DIR,
  TEAM_COMMS_LOG,
  TEAM_REQUESTS_DIR,
  TeamAgentRecord,
  agentFilePath,
  ensureDir,
  loadTeamAgents,
  slugifyAgentName,
  textResult,
  writeTeamAgent,
} from './shared.js';

interface TeamMessageRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  protocol: 'message' | 'request' | 'response';
  requestId?: string;
  respondedAt?: string;
}

interface DelegationRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  createdAt: string;
  updatedAt: string;
}

function currentAgentSlug(): string {
  return process.env.CLEMENTINE_TEAM_AGENT || 'clementine';
}

function isPrimaryAgent(): boolean {
  return !process.env.CLEMENTINE_TEAM_AGENT || process.env.CLEMENTINE_TEAM_AGENT === 'clementine';
}

function assertPrimaryOnly(action: string): void {
  if (!isPrimaryAgent()) {
    throw new Error(`Only the primary agent can ${action}. Current agent: ${currentAgentSlug()}`);
  }
}

function appendTeamComms(record: TeamMessageRecord): void {
  ensureDir(path.dirname(TEAM_COMMS_LOG));
  appendFileSync(TEAM_COMMS_LOG, `${JSON.stringify(record)}\n`, 'utf-8');
}

function readTeamMessages(): TeamMessageRecord[] {
  if (!existsSync(TEAM_COMMS_LOG)) return [];
  return readFileSync(TEAM_COMMS_LOG, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TeamMessageRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is TeamMessageRecord => record !== null);
}

function requestFilePath(id: string): string {
  return path.join(TEAM_REQUESTS_DIR, `${id}.json`);
}

function delegationFilePath(toAgent: string, id: string): string {
  return path.join(DELEGATIONS_DIR, toAgent, `${id}.json`);
}

function canSendTo(targetSlug: string): boolean {
  if (isPrimaryAgent()) return true;
  const caller = loadTeamAgents().find((agent) => agent.slug === currentAgentSlug());
  if (!caller) return false;
  return caller.canMessage.includes(targetSlug);
}

export function registerTeamTools(server: McpServer): void {
  server.tool(
    'team_list',
    'List all team agents and their messaging permissions.',
    {},
    async () => {
      const agents = loadTeamAgents();
      if (agents.length === 0) return textResult('No team agents configured.');

      return textResult(
        agents
          .map((agent) => {
            const canMessage = agent.canMessage.length > 0 ? agent.canMessage.join(', ') : 'none';
            return `- ${agent.name} (${agent.slug})${agent.channelName ? ` | #${agent.channelName}` : ''} | canMessage=[${canMessage}]`;
          })
          .join('\n'),
      );
    },
  );

  server.tool(
    'team_message',
    'Queue a message to another team agent.',
    {
      to_agent: z.string().min(1),
      message: z.string().min(1),
    },
    async ({ to_agent, message }) => {
      const agents = loadTeamAgents();
      const target = agents.find((agent) => agent.slug === to_agent);
      if (!target) return textResult(`Target agent not found: ${to_agent}`);
      if (!canSendTo(to_agent)) {
        return textResult(`Agent '${currentAgentSlug()}' is not authorized to message '${to_agent}'.`);
      }

      const record: TeamMessageRecord = {
        id: randomBytes(4).toString('hex'),
        fromAgent: currentAgentSlug(),
        toAgent: to_agent,
        content: message,
        timestamp: new Date().toISOString(),
        protocol: 'message',
      };
      appendTeamComms(record);
      return textResult(`Message queued for ${target.name} (${to_agent}). ID: ${record.id}`);
    },
  );

  server.tool(
    'team_request',
    'Create a structured request for another team agent and queue it locally.',
    {
      to_agent: z.string().min(1),
      request: z.string().min(1),
      expected_by: z.string().optional(),
    },
    async ({ to_agent, request, expected_by }) => {
      const agents = loadTeamAgents();
      const target = agents.find((agent) => agent.slug === to_agent);
      if (!target) return textResult(`Target agent not found: ${to_agent}`);
      if (!canSendTo(to_agent)) {
        return textResult(`Agent '${currentAgentSlug()}' is not authorized to message '${to_agent}'.`);
      }

      const id = randomBytes(4).toString('hex');
      const payload = {
        id,
        fromAgent: currentAgentSlug(),
        toAgent: to_agent,
        content: request,
        expectedBy: expected_by,
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
      };
      ensureDir(TEAM_REQUESTS_DIR);
      writeFileSync(requestFilePath(id), JSON.stringify(payload, null, 2), 'utf-8');
      appendTeamComms({
        id: randomBytes(4).toString('hex'),
        fromAgent: currentAgentSlug(),
        toAgent: to_agent,
        content: request,
        timestamp: new Date().toISOString(),
        protocol: 'request',
        requestId: id,
      });

      return textResult(`Request queued for ${target.name} (${to_agent}). Request ID: ${id}`);
    },
  );

  server.tool(
    'team_pending_requests',
    'List pending requests assigned to the current team agent.',
    {},
    async () => {
      const slug = currentAgentSlug();
      if (isPrimaryAgent()) {
        return textResult('Primary agent has no queued team requests.');
      }
      if (!existsSync(TEAM_REQUESTS_DIR)) return textResult('No pending requests.');

      const requests = readdirSync(TEAM_REQUESTS_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(path.join(TEAM_REQUESTS_DIR, file), 'utf-8')) as {
          id: string;
          fromAgent: string;
          toAgent: string;
          content: string;
          expectedBy?: string;
          status: string;
        })
        .filter((request) => request.toAgent === slug && request.status === 'pending');

      if (requests.length === 0) return textResult('No pending requests.');

      return textResult(
        requests
          .map((request) => `- [REPLY NEEDED] ${request.id} from ${request.fromAgent}: ${request.content}${request.expectedBy ? ` | expected by ${request.expectedBy}` : ''}`)
          .join('\n'),
      );
    },
  );

  server.tool(
    'team_reply',
    'Reply to a queued team request and mark it completed.',
    {
      request_id: z.string().min(1),
      response: z.string().min(1),
    },
    async ({ request_id, response }) => {
      const filePath = requestFilePath(request_id);
      if (!existsSync(filePath)) return textResult(`Request not found: ${request_id}`);

      const request = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        id: string;
        fromAgent: string;
        toAgent: string;
        content: string;
        status: string;
      };

      if (request.toAgent !== currentAgentSlug()) {
        return textResult(`Request ${request_id} is not assigned to ${currentAgentSlug()}.`);
      }

      writeFileSync(
        filePath,
        JSON.stringify({ ...request, status: 'completed', response, respondedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
      appendTeamComms({
        id: randomBytes(4).toString('hex'),
        fromAgent: currentAgentSlug(),
        toAgent: request.fromAgent,
        content: response,
        timestamp: new Date().toISOString(),
        protocol: 'response',
        requestId: request_id,
        respondedAt: new Date().toISOString(),
      });

      return textResult(`Replied to request ${request_id}.`);
    },
  );

  server.tool(
    'create_agent',
    'Create a new team agent with its own personality, tools, and project binding.',
    {
      name: z.string().min(1),
      description: z.string().min(1),
      role: z.string().optional(),
      personality: z.string().optional(),
      channel_name: z.string().optional(),
      project: z.string().optional(),
      tools: z.array(z.string()).optional(),
      model: z.string().optional(),
      can_message: z.array(z.string()).optional(),
      tier: z.number().optional(),
      autonomy_enabled: z.boolean().optional(),
      proactive: z.boolean().optional(),
      cadence_minutes: z.number().optional(),
      wake_triggers: z.array(z.string()).optional(),
    },
    async ({ name, description, role, personality, channel_name, project, tools, model, can_message, tier, autonomy_enabled, proactive, cadence_minutes, wake_triggers }) => {
      assertPrimaryOnly('create agents');

      const slug = slugifyAgentName(name);
      if (!slug) return textResult('Could not derive a valid agent slug.');
      if (existsSync(agentFilePath(slug))) return textResult(`Agent already exists: ${slug}`);

      const record: TeamAgentRecord = {
        slug,
        name,
        description,
        role,
        channelName: channel_name,
        canMessage: can_message || [],
        allowedTools: tools || [],
        model,
        project,
        tier: tier !== undefined ? Math.min(tier, 2) : 2,
        autonomyEnabled: autonomy_enabled ?? true,
        proactive: proactive ?? true,
        cadenceMinutes: cadence_minutes !== undefined ? Math.max(5, cadence_minutes) : 30,
        wakeTriggers: wake_triggers ?? ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review'],
        personality: personality || `You are ${name}. ${description}`,
      };
      writeTeamAgent(record);
      return textResult(`Created agent '${name}' (${slug}).`);
    },
  );

  server.tool(
    'update_agent',
    'Update an existing team agent. Only provided fields are changed.',
    {
      slug: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      role: z.string().optional(),
      personality: z.string().optional(),
      channel_name: z.string().optional(),
      project: z.string().optional(),
      tools: z.array(z.string()).optional(),
      model: z.string().optional(),
      can_message: z.array(z.string()).optional(),
      tier: z.number().optional(),
      autonomy_enabled: z.boolean().optional(),
      proactive: z.boolean().optional(),
      cadence_minutes: z.number().optional(),
      wake_triggers: z.array(z.string()).optional(),
    },
    async ({ slug, name, description, role, personality, channel_name, project, tools, model, can_message, tier, autonomy_enabled, proactive, cadence_minutes, wake_triggers }) => {
      assertPrimaryOnly('update agents');

      const existing = loadTeamAgents().find((agent) => agent.slug === slug);
      if (!existing) return textResult(`Agent not found: ${slug}`);

      writeTeamAgent({
        ...existing,
        name: name ?? existing.name,
        description: description ?? existing.description,
        role: role ?? existing.role,
        personality: personality ?? existing.personality,
        channelName: channel_name ?? existing.channelName,
        project: project ?? existing.project,
        allowedTools: tools ?? existing.allowedTools,
        model: model ?? existing.model,
        canMessage: can_message ?? existing.canMessage,
        tier: tier !== undefined ? Math.min(tier, 2) : existing.tier,
        autonomyEnabled: autonomy_enabled ?? existing.autonomyEnabled,
        proactive: proactive ?? existing.proactive,
        cadenceMinutes: cadence_minutes !== undefined ? Math.max(5, cadence_minutes) : existing.cadenceMinutes,
        wakeTriggers: wake_triggers ?? existing.wakeTriggers,
      });

      return textResult(`Updated agent '${slug}'.`);
    },
  );

  server.tool(
    'delete_agent',
    'Delete an agent definition.',
    {
      slug: z.string().min(1),
      confirm: z.boolean(),
    },
    async ({ slug, confirm }) => {
      assertPrimaryOnly('delete agents');
      if (!confirm) return textResult('Deletion cancelled. Set confirm=true to delete.');

      const agentDir = path.join(AGENTS_DIR, slug);
      if (!existsSync(agentDir)) return textResult(`Agent not found: ${slug}`);
      rmSync(agentDir, { recursive: true, force: true });
      return textResult(`Deleted agent '${slug}'.`);
    },
  );

  server.tool(
    'delegate_task',
    'Delegate a task to another team agent using local delegation state.',
    {
      to_agent: z.string().min(1),
      task: z.string().min(1),
      expected_output: z.string().min(1),
    },
    async ({ to_agent, task, expected_output }) => {
      const target = loadTeamAgents().find((agent) => agent.slug === to_agent);
      if (!target) return textResult(`Target agent not found: ${to_agent}`);
      if (!canSendTo(to_agent)) {
        return textResult(`Agent '${currentAgentSlug()}' is not authorized to delegate to '${to_agent}'.`);
      }

      const delegation: DelegationRecord = {
        id: randomBytes(4).toString('hex'),
        fromAgent: currentAgentSlug(),
        toAgent: to_agent,
        task,
        expectedOutput: expected_output,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const filePath = delegationFilePath(to_agent, delegation.id);
      ensureDir(path.dirname(filePath));
      writeFileSync(filePath, JSON.stringify(delegation, null, 2), 'utf-8');
      return textResult(`Task delegated to ${to_agent}. Delegation ID: ${delegation.id}`);
    },
  );

  server.tool(
    'check_delegation',
    'Check a delegated task by ID or list delegations for an agent.',
    {
      id: z.string().optional(),
      agent: z.string().optional(),
    },
    async ({ id, agent }) => {
      if (id) {
        if (!existsSync(DELEGATIONS_DIR)) return textResult('No delegations found.');
        for (const slug of readdirSync(DELEGATIONS_DIR)) {
          const filePath = delegationFilePath(slug, id);
          if (!existsSync(filePath)) continue;
          const delegation = JSON.parse(readFileSync(filePath, 'utf-8')) as DelegationRecord;
          return textResult(
            [
              `Delegation ${delegation.id}`,
              `From: ${delegation.fromAgent} -> To: ${delegation.toAgent}`,
              `Status: ${delegation.status}`,
              `Task: ${delegation.task}`,
              `Expected Output: ${delegation.expectedOutput}`,
              delegation.result ? `Result: ${delegation.result}` : '',
            ].filter(Boolean).join('\n'),
          );
        }
        return textResult(`Delegation not found: ${id}`);
      }

      if (!agent) {
        return textResult('Provide either id or agent.');
      }

      const dirPath = path.join(DELEGATIONS_DIR, agent);
      if (!existsSync(dirPath)) return textResult(`No delegations for ${agent}.`);
      const delegations = readdirSync(dirPath)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(path.join(dirPath, file), 'utf-8')) as DelegationRecord);
      if (delegations.length === 0) return textResult(`No delegations for ${agent}.`);

      return textResult(
        delegations
          .map((delegation) => `- [${delegation.status.toUpperCase()}] ${delegation.id}: ${delegation.task.slice(0, 100)} (from ${delegation.fromAgent})`)
          .join('\n'),
      );
    },
  );
}
