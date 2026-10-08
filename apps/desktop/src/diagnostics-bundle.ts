/**
 * One redacted text file a tester can send when Clementine misbehaves.
 *
 * The desktop shell builds it, not the daemon: it has to work while the
 * daemon is crash-looping or never started. A Windows tester's crash loop
 * (2026-10-08) was only diagnosed once the supervisor log was pasted by hand;
 * screenshots of "Clem needs to reconnect" could not say why. The file holds
 * the build identity and the last part of the supervisor log and of the
 * daemon's stall, hang and liveness records. Secrets and tokens, email
 * addresses, the user's own folder and the computer's name are replaced
 * before anything is written.
 */
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from './redaction.js';

export interface DiagnosticsSource {
  /** `<CLEMENTINE_HOME>/logs/desktop`. */
  logDir: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  versions: { electron?: string; node?: string };
  /** The user's own folder and the computer's name, replaced in the output. */
  userHome: string;
  hostname: string;
  now?: Date;
}

/** Each record kept, newest part only. The supervisor log carries the daemon's
 *  own output, so it gets the most room. */
export const DIAGNOSTIC_FILES: ReadonlyArray<{ name: string; bytes: number }> = [
  { name: 'supervisor.log', bytes: 1_500_000 },
  { name: 'supervisor.log.1', bytes: 300_000 },
  { name: 'daemon-stalls.jsonl', bytes: 200_000 },
  { name: 'supervisor-hang-snapshots.jsonl', bytes: 200_000 },
  { name: 'daemon-liveness.json', bytes: 50_000 },
];

function tailOf(file: string, bytes: number): { text: string; size: number; kept: number } | null {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // A cut mid-line starts at the next whole line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size, kept: buffer.length };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The forms a folder path takes in logs: as written, JSON-escaped, and as a
 *  file URL / forward-slash path (Windows logs carry all three). */
function pathForms(folder: string): string[] {
  if (!folder || folder.length < 4) return [];
  const forms = new Set([folder, folder.replace(/\\/g, '\\\\'), folder.replace(/\\/g, '/')]);
  return [...forms].sort((a, b) => b.length - a.length);
}

export function redactDiagnostics(text: string, who: { userHome: string; hostname: string }): string {
  let out = redactSensitiveText(text);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]');
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[anthropic-token]');
  out = out.replace(
    /("[A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[A-Za-z_]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[REDACTED]"',
  );
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  for (const form of pathForms(who.userHome)) out = out.split(form).join('~');
  if (who.hostname && who.hostname.length >= 3) out = out.split(who.hostname).join('[computer]');
  return out;
}

export function buildDiagnosticsText(source: DiagnosticsSource): string {
  const now = source.now ?? new Date();
  const who = { userHome: source.userHome, hostname: source.hostname };
  const sections = [
    'Clementine diagnostics',
    `Generated: ${now.toISOString()}`,
    `App: ${source.appVersion} on ${source.platform} ${source.arch} (OS ${source.osRelease})`,
    `Runtime: Electron ${source.versions.electron ?? '?'}, Node ${source.versions.node ?? '?'}`,
    'Each section below is the newest part of one log. Secrets, tokens, email addresses, your user folder and this computer\'s name are replaced.',
  ];
  for (const { name, bytes } of DIAGNOSTIC_FILES) {
    const tail = tailOf(path.join(source.logDir, name), bytes);
    if (!tail) { sections.push('', `=== ${name}: not present ===`); continue; }
    const scope = tail.kept < tail.size ? `last ${Math.round(tail.kept / 1024)} KB of ${Math.round(tail.size / 1024)} KB` : `${Math.round(tail.size / 1024)} KB`;
    sections.push('', `=== ${name} (${scope}) ===`, redactDiagnostics(tail.text, who).trimEnd());
  }
  return `${redactDiagnostics(sections.join('\n'), who)}\n`;
}

/** Writes the file into `directory` and returns its path. */
export function saveDiagnosticsFile(source: DiagnosticsSource, directory: string): string {
  const now = source.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `clementine-diagnostics-${stamp}.txt`);
  writeFileSync(file, buildDiagnosticsText({ ...source, now }), 'utf8');
  return file;
}
