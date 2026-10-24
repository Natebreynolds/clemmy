/**
 * A shell command that spells a reviewed CLI read runs as that read.
 *
 * The pre-dispatch check already refuses a shell command whose head is a
 * callable reviewed read and names the operation and its argument map, so the
 * model's next step is that same read through the attested door. When the
 * typed command compiles exactly onto the read's declared arguments, the host
 * already holds the whole answer: this completer rewrites the carrier into the
 * reviewed operation before anything binds the call, and the operation's own
 * descriptor, binary and argv proof run as they would for a direct call.
 *
 * Deliberately narrow. Only a plain command completes: one program, quoted
 * words, no pipes, redirections, separators, substitutions or variables, no
 * working directory or environment of its own, and every option one the
 * reviewed read declares. A direct-call requirement is replaced by the
 * operation's; a plan's own requirement id is never rewritten. Anything else
 * returns null and the existing refusal names the door. Generic over the CLI
 * catalog; nothing here names a program.
 */
import { registerCarrierCompleter, type CarrierCompletion } from './carrier-completion-registry.js';
import { carrierJsonObject } from './carrier-json.js';
import { compileReviewedCliArgv, reviewedCliShellMatch } from './reviewed-cli-shell-match.js';

const SHELL_TOOL = 'run_shell_command';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isShellToolName(name: unknown): boolean {
  return typeof name === 'string'
    && (name === SHELL_TOOL || name.endsWith(`__${SHELL_TOOL}`) || name.endsWith(`:${SHELL_TOOL}`));
}

/** The words of a plain command, or null when the shell would do anything
 *  beyond running one program with literal arguments. */
export function plainCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null; else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = null; continue; }
      if (char === '$' || char === '`') return null;
      if (char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return null;
        if ('"\\'.includes(next)) { current += next; index += 1; continue; }
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === ' ' || char === '\t') {
      if (started) { words.push(current); current = ''; started = false; }
      continue;
    }
    if (/[\n\r;&|<>()$`\\*?[\]{}~#!]/.test(char)) return null;
    current += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started) words.push(current);
  return words.length > 0 ? words : null;
}

export function completeReviewedCliShellCarrier(outerArgumentsJson: string): CarrierCompletion | null {
  let outer: Record<string, unknown> | null;
  try { outer = asRecord(JSON.parse(outerArgumentsJson)); } catch { return null; }
  if (!outer || !isShellToolName(outer.name)) return null;
  const argsKey = 'args_json' in outer ? 'args_json' : ('args' in outer ? 'args' : null);
  if (!argsKey) return null;
  const raw = outer[argsKey];
  const inner = typeof raw === 'string' ? carrierJsonObject(raw) : asRecord(raw);
  if (!inner || typeof inner.command !== 'string') return null;
  // Only the command itself: a working directory, environment or input of
  // its own is part of what the typed command meant and the reviewed read
  // does not carry it.
  for (const [key, value] of Object.entries(inner)) {
    if (key === 'command' || key === 'timeout_ms' || key === 'description') continue;
    if (value === null || value === undefined || value === '') continue;
    return null;
  }
  const requirement = outer.requirement_id;
  if (requirement !== undefined && requirement !== null
    && !(typeof requirement === 'string' && requirement.startsWith('cap:local:'))) return null;
  const command = inner.command.trim();
  const words = plainCommandWords(command);
  if (!words) return null;
  const matched = reviewedCliShellMatch(command);
  if (matched.status !== 'matched') return null;
  const compiled = compileReviewedCliArgv(words);
  if (compiled.status !== 'matched' || compiled.operationId !== matched.operationId) return null;
  const operationArgs = JSON.stringify(compiled.args);
  const completedOuter: Record<string, unknown> = {
    ...outer,
    name: compiled.operationId,
    [argsKey]: typeof raw === 'string' ? operationArgs : compiled.args,
    ...(requirement !== undefined ? { requirement_id: compiled.operationId } : {}),
  };
  return {
    argumentsJson: JSON.stringify(completedOuter),
    toolSlug: compiled.operationId,
    changes: [`the shell command ran as the reviewed read ${compiled.operationId} with args_json ${operationArgs.slice(0, 160)}`],
  };
}

registerCarrierCompleter((argumentsJson) => completeReviewedCliShellCarrier(argumentsJson));
