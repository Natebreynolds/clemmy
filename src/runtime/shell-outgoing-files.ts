import path from 'node:path';
import os from 'node:os';

/**
 * The local files a command that leaves this computer would send, read from
 * the command's own arguments: curl form/data/upload operands, `gh release
 * upload`, `gh gist create`, `gh … --body-file`, scp/rsync sources, `aws s3
 * cp|sync` and rclone sources. Display only: the card names each file so the
 * owner sees what leaves before saying yes. It grants and refuses nothing.
 */

/** Split a command into words the way a POSIX shell would for plain quoting. */
export function shellWords(command: string): string[] {
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
      if (char === '\\' && index + 1 < command.length && '"\\$`'.includes(command[index + 1]!)) {
        current += command[index + 1]!; index += 1; continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\' && index + 1 < command.length) { current += command[index + 1]!; index += 1; started = true; continue; }
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&') {
      if (started) { words.push(current); current = ''; started = false; }
      if (char === ';' || char === '|' || char === '&') words.push(char);
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

function remoteOperand(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\\]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value);
}

function fromAtValue(value: string): string | null {
  // curl -F name=@path;type=x  |  -F @path  |  --data-binary @path
  const at = value.indexOf('@');
  if (at < 0) return null;
  const before = value.slice(0, at);
  if (before && !/^[^=]+=<?$/.test(before)) return null;
  const rest = value.slice(at + 1).split(';')[0]!.trim();
  return rest && rest !== '-' ? rest : null;
}

function segments(words: string[]): string[][] {
  const out: string[][] = [[]];
  for (const word of words) {
    if (word === ';' || word === '|' || word === '&') out.push([]);
    else out.at(-1)!.push(word);
  }
  return out.filter((segment) => segment.length > 0);
}

function executable(word: string): string {
  return path.basename(word).toLowerCase();
}

function filesInSegment(words: string[]): string[] {
  let start = 0;
  while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!) || words[start] === 'sudo' || words[start] === 'env')) start += 1;
  const argv = words.slice(start);
  const tool = executable(argv[0] ?? '');
  const files: string[] = [];
  if (tool === 'curl') {
    for (let index = 1; index < argv.length; index += 1) {
      const word = argv[index]!;
      const next = argv[index + 1];
      if (['-F', '--form', '-d', '--data', '--data-binary', '--data-urlencode', '--json'].includes(word) && next !== undefined) {
        const file = fromAtValue(next);
        if (file) files.push(file);
        index += 1;
      } else if (['-T', '--upload-file'].includes(word) && next !== undefined) {
        if (next !== '-') files.push(next);
        index += 1;
      } else if (/^-F.+/.test(word)) {
        const file = fromAtValue(word.slice(2));
        if (file) files.push(file);
      }
    }
  } else if (tool === 'gh') {
    const verb = `${argv[1] ?? ''} ${argv[2] ?? ''}`;
    for (let index = 1; index < argv.length; index += 1) {
      if (['--body-file', '-F'].includes(argv[index]!) && argv[index + 1] && argv[index + 1] !== '-') {
        files.push(argv[index + 1]!); index += 1;
      }
    }
    // Operands after the subcommand, skipping flags and the values of the
    // flags that take one.
    const valueFlags = new Set(['-R', '--repo', '-d', '--desc', '-f', '--filename', '--body-file', '-F']);
    const operands: string[] = [];
    for (let index = 3; index < argv.length; index += 1) {
      const word = argv[index]!;
      if (valueFlags.has(word)) { index += 1; continue; }
      if (word.startsWith('-')) continue;
      operands.push(word);
    }
    if (verb === 'release upload') files.push(...operands.slice(1).map((word) => word.split('#')[0]!));
    if (verb === 'gist create') files.push(...operands.filter((word) => word !== '-'));
  } else if (tool === 'scp' || tool === 'rsync') {
    // Flags that take a value (a port, a key, an ssh command) are not operands.
    const valueFlags = tool === 'scp'
      ? new Set(['-P', '-i', '-o', '-F', '-c', '-l', '-S', '-J'])
      : new Set(['-e', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '-f', '--filter']);
    const operands: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const word = argv[index]!;
      if (valueFlags.has(word)) { index += 1; continue; }
      if (!word.startsWith('-')) operands.push(word);
    }
    if (operands.length >= 2 && remoteOperand(operands.at(-1)!)) {
      files.push(...operands.slice(0, -1).filter((word) => !remoteOperand(word)));
    }
  } else if (tool === 'aws' && argv[1] === 's3' && (argv[2] === 'cp' || argv[2] === 'sync' || argv[2] === 'mv')) {
    const operands = argv.slice(3).filter((word) => !word.startsWith('-'));
    if (operands.length >= 2 && !operands[0]!.startsWith('s3://') && operands[1]!.startsWith('s3://')) files.push(operands[0]!);
  } else if (tool === 'rclone' && ['copy', 'copyto', 'move', 'moveto', 'sync'].includes(argv[1] ?? '')) {
    const operands = argv.slice(2).filter((word) => !word.startsWith('-'));
    if (operands.length >= 2 && !remoteOperand(operands[0]!) && remoteOperand(operands[1]!)) files.push(operands[0]!);
  }
  return files;
}

/** Absolute paths of the local files the command would send, in order, without repeats. */
export function outgoingFilesInCommand(command: string, cwd?: string | null): string[] {
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of segments(shellWords(command))) {
    for (const file of filesInSegment(segment)) {
      const expanded = file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
      const absolute = path.isAbsolute(expanded) || /^[a-zA-Z]:[\\/]/.test(expanded) ? expanded : path.resolve(base, expanded);
      if (!seen.has(absolute)) { seen.add(absolute); out.push(absolute); }
    }
  }
  return out;
}
