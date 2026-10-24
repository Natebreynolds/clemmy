/**
 * The exit/stdout/stderr frame run_shell_command writes around a command's
 * output, read back into its parts. A leaf module (it imports only the stored
 * JSON parser) so the retained-output readers and the route judge read a
 * command's `--json` stdout the same way without importing the dispatcher.
 */
import { parseStoredToolOutputJson } from './json-repair.js';

export interface InnerDispatchShellResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  raw: string;
  stdout_json?: unknown;
  result_handle?: string;
  truncated_at_write?: boolean;
}

export function strictJsonParse(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseStdoutJson(stdout: string): unknown | undefined {
  const direct = strictJsonParse(stdout.trim());
  if (direct.ok) return direct.value;
  // A CLI's documentation/example is text, not its returned records. Use the
  // same conservative stored-evidence parser as recall and reference binding.
  return parseStoredToolOutputJson(stdout)?.value;
}

function sectionAfter(label: 'stdout' | 'stderr', body: string): string {
  const marker = `${label}:\n`;
  if (body === marker.slice(0, -1)) return '';
  if (!body.startsWith(marker)) return '';
  return body.slice(marker.length);
}

export function parseShellToolOutput(raw: string, opts: { callId?: string; truncatedAtWrite?: boolean } = {}): InnerDispatchShellResult | null {
  const firstLine = raw.match(/^\s*exit_code:\s*([^\n\r]*)/i);
  if (!firstLine) return null;
  const parsedCode = Number.parseInt(firstLine[1].trim(), 10);
  const exitCode = Number.isFinite(parsedCode) ? parsedCode : null;
  let rest = raw.slice(firstLine[0].length).replace(/^\r?\n\r?\n?/, '');
  let stdout = '';
  let stderr = '';

  if (rest.startsWith('stdout:\n')) {
    // Historical host wrappers used one newline before stderr; current ones
    // use a blank line. Decode both envelopes rather than relying on broad
    // JSON repair to accidentally discard the unparsed stderr marker.
    const stderrBoundary = /\n{1,2}stderr:\n/.exec(rest);
    if (stderrBoundary) {
      stdout = sectionAfter('stdout', rest.slice(0, stderrBoundary.index));
      stderr = rest.slice(stderrBoundary.index + stderrBoundary[0].length);
    } else {
      stdout = sectionAfter('stdout', rest);
    }
  } else if (rest.startsWith('stderr:\n')) {
    stderr = sectionAfter('stderr', rest);
  }

  const result: InnerDispatchShellResult = {
    ok: exitCode === 0,
    exit_code: exitCode,
    stdout,
    stderr,
    raw,
    ...(opts.callId ? { result_handle: opts.callId } : {}),
    ...(opts.truncatedAtWrite ? { truncated_at_write: true } : {}),
  };
  const stdoutJson = parseStdoutJson(stdout);
  if (stdoutJson !== undefined) result.stdout_json = stdoutJson;
  return result;
}

/** What a command's capture leaves when it stops at its cap: everything after
 *  it is gone, so the stored output is not the command's whole output. */
export function captureStoppedMarker(limit: number): string {
  return `...[capture stopped after ${limit} chars]`;
}

/** The cap a stored output was cut at, or null when it was captured whole. */
export function captureStoppedAt(text: string): number | null {
  const match = /\.\.\.\[capture stopped after (\d+) chars\]/.exec(text);
  return match ? Number(match[1]) : null;
}
