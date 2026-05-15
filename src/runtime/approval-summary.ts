import type { PendingApproval } from '../types.js';

/**
 * Build a short human-readable description of what a pending approval
 * actually does. Without this, the Discord approval card shows only
 * "Approval <uuid> for run_shell_command" — a meaningless string of hex
 * that gives the user no idea what they're approving.
 *
 * Reads the toolCall arguments from `approval.state` and renders a
 * per-tool preview. The dashboard sidebar and Discord both call this
 * so the message is consistent everywhere.
 */
export function summarizeApprovalAction(approval: PendingApproval): string {
  const args = extractToolArgs(approval);
  const tool = approval.toolName;
  if (!args) return `${tool} (no preview available)`;
  switch (tool) {
    case 'run_shell_command':
    case 'shell': {
      const command = pickString(args, ['command', 'cmd']);
      const cwd = pickString(args, ['cwd', 'workingDirectory']);
      const where = cwd ? ` in \`${trim(cwd, 80)}\`` : '';
      return command ? `\`${trim(command, 240)}\`${where}` : `${tool} (no command)`;
    }
    case 'write_file':
    case 'edit_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `write \`${trim(file, 200)}\`` : `${tool}`;
    }
    case 'composio_execute_tool': {
      const slug = pickString(args, ['tool_slug', 'slug']);
      const inner = renderNestedArgs(args.arguments);
      return slug ? `${slug}${inner ? ` ${inner}` : ''}` : `${tool}`;
    }
    case 'discord_channel_send':
    case 'send_message':
    case 'notify_user':
    case 'discord_dm': {
      const to = pickString(args, ['channelId', 'userId', 'channel', 'to']);
      const text = pickString(args, ['message', 'content', 'text', 'body']);
      return `to ${to || '(channel)'}: ${trim(text, 200)}`;
    }
    case 'send_email':
    case 'gmail_send':
    case 'outlook_send_email': {
      const to = pickString(args, ['to', 'recipient']);
      const subject = pickString(args, ['subject', 'title']);
      return `email \`${trim(to, 80)}\`: ${trim(subject, 160)}`;
    }
    case 'goal_create':
    case 'goal_update':
    case 'task_add':
    case 'task_update': {
      const title = pickString(args, ['title', 'description', 'text', 'name']);
      return title ? trim(title, 220) : `${tool}`;
    }
    default: {
      return trim(JSON.stringify(args), 260);
    }
  }
}

interface ToolCallEnvelope {
  arguments?: string | Record<string, unknown>;
}

function extractToolArgs(approval: PendingApproval): Record<string, unknown> | undefined {
  if (!approval.state) return undefined;
  try {
    const parsed = JSON.parse(approval.state) as { toolCall?: ToolCallEnvelope };
    const toolCall = parsed.toolCall;
    if (!toolCall) return undefined;
    if (typeof toolCall.arguments === 'string') {
      try {
        return JSON.parse(toolCall.arguments) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    if (toolCall.arguments && typeof toolCall.arguments === 'object') {
      return toolCall.arguments as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function renderNestedArgs(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      return trim(JSON.stringify(JSON.parse(raw)), 200);
    } catch {
      return trim(raw, 200);
    }
  }
  if (raw && typeof raw === 'object') {
    return trim(JSON.stringify(raw), 200);
  }
  return '';
}

function trim(input: string, max: number): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
