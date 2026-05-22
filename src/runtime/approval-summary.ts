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

/**
 * Short human-readable preview of a live tool_called event for the
 * status line (chat dock + Discord progress). Capped tight (~70 chars)
 * so it fits in a one-line label. Where `summarizeApprovalAction`
 * formats a multi-line approval card, this is for "what is the agent
 * doing RIGHT NOW" — the user wants to know "running pwd && ls" not
 * "run_shell_command(args={command: ...})". Without it, a 7-call
 * sequence of run_shell_command shows up as the bare tool name 7 times
 * and the user can't tell anything's progressing.
 *
 * `argsRaw` accepts either the JSON string emitted by the SDK or the
 * already-parsed object — both are common shapes at call sites.
 */
export function previewToolCall(toolName: string, argsRaw: unknown): string {
  const args = parseArgs(argsRaw);
  if (!args) return toolName;
  const MAX = 70;
  switch (toolName) {
    case 'run_shell_command':
    case 'shell': {
      const command = pickString(args, ['command', 'cmd']);
      if (!command) return toolName;
      return `running: ${trim(command, MAX)}`;
    }
    case 'write_file':
    case 'edit_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `writing ${trim(file, MAX)}` : toolName;
    }
    case 'read_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `reading ${trim(file, MAX)}` : toolName;
    }
    case 'composio_execute_tool': {
      const slug = pickString(args, ['tool_slug', 'slug']);
      return slug ? `composio · ${trim(slug, MAX - 10)}` : toolName;
    }
    case 'composio_search_tools': {
      const query = pickString(args, ['query', 'q']);
      return query ? `searching composio · "${trim(query, MAX - 22)}"` : toolName;
    }
    case 'memory_recall':
    case 'tool_choice_recall': {
      const intent = pickString(args, ['intent', 'query', 'q']);
      return intent ? `recall · ${trim(intent, MAX - 9)}` : toolName;
    }
    case 'memory_search': {
      const query = pickString(args, ['query', 'q']);
      return query ? `memory search · "${trim(query, MAX - 17)}"` : toolName;
    }
    case 'skill_read':
    case 'skill_list': {
      const name = pickString(args, ['name', 'skill', 'filter']);
      return name ? `${toolName} · ${trim(name, MAX - toolName.length - 3)}` : toolName;
    }
    case 'discord_channel_send':
    case 'send_message':
    case 'notify_user':
    case 'discord_dm': {
      const title = pickString(args, ['title', 'subject']);
      const text = pickString(args, ['message', 'content', 'text', 'body']);
      return title || text ? `notify · ${trim(title || text, MAX - 9)}` : toolName;
    }
    case 'send_email':
    case 'gmail_send':
    case 'outlook_send_email': {
      const to = pickString(args, ['to', 'recipient']);
      return to ? `emailing ${trim(to, MAX - 9)}` : toolName;
    }
    case 'draft_plan': {
      const input = pickString(args, ['input', 'objective', 'goal']);
      return input ? `planning · ${trim(input, MAX - 11)}` : toolName;
    }
    case 'request_approval': {
      const subject = pickString(args, ['subject', 'reason']);
      return subject ? `requesting approval · ${trim(subject, MAX - 22)}` : toolName;
    }
    case 'goal_create':
    case 'goal_update':
    case 'task_add':
    case 'task_update': {
      const title = pickString(args, ['title', 'description', 'text', 'name']);
      return title ? `${toolName} · ${trim(title, MAX - toolName.length - 3)}` : toolName;
    }
    default: {
      return toolName;
    }
  }
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
