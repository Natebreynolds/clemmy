// Shared terminal UI primitives — no external deps, raw ANSI only

export const RESET  = '\x1b[0m';
export const BOLD   = '\x1b[1m';
export const DIM    = '\x1b[0;90m';
export const GREEN  = '\x1b[32m';
export const RED    = '\x1b[31m';
export const CYAN   = '\x1b[0;36m';
export const YELLOW = '\x1b[1;33m';
export const ORANGE = '\x1b[38;5;208m';
export const WHITE  = '\x1b[97m';

export const BANNER = `
${ORANGE}${BOLD} ██████╗██╗     ███████╗███╗   ███╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗
██╔════╝██║     ██╔════╝████╗ ████║██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║     █████╗  ██╔████╔██║█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗
██║     ██║     ██╔══╝  ██║╚██╔╝██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝
╚██████╗███████╗███████╗██║ ╚═╝ ██║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗
 ╚═════╝╚══════╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝${RESET}
`;

export function sectionHeader(title: string): void {
  console.log();
  console.log(`  ${ORANGE}${BOLD}── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}${RESET}`);
  console.log();
}

export function ok(label: string, detail = ''): void {
  console.log(`  ${GREEN}✓${RESET}  ${BOLD}${label}${RESET}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

export function warn(label: string, detail = ''): void {
  console.log(`  ${YELLOW}!${RESET}  ${BOLD}${label}${RESET}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

export function fail(label: string, detail = ''): void {
  console.log(`  ${RED}✗${RESET}  ${BOLD}${label}${RESET}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

export function info(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

export function passRow(label: string, detail: string): void {
  const pad = 20;
  console.log(`  ${GREEN}PASS${RESET}  ${label.padEnd(pad)} ${DIM}${detail}${RESET}`);
}

export function warnRow(label: string, detail: string): void {
  const pad = 20;
  console.log(`  ${YELLOW}WARN${RESET}  ${label.padEnd(pad)} ${DIM}${detail}${RESET}`);
}

export function failRow(label: string, detail: string): void {
  const pad = 20;
  console.log(`  ${RED}FAIL${RESET}  ${label.padEnd(pad)} ${DIM}${detail}${RESET}`);
}

export function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/`([^`\n]+)`/g, `${DIM}$1${RESET}`)
    .replace(/^(#{1,3})\s+(.+)$/gm, (_m, hashes: string, title: string) => {
      const color = hashes.length === 1 ? CYAN : hashes.length === 2 ? GREEN : YELLOW;
      return `\n${color}${BOLD}${title}${RESET}`;
    })
    .replace(/^>\s+(.+)$/gm, `  ${DIM}$1${RESET}`)
    .replace(/^\s*[-*]\s+/gm, `  ${ORANGE}·${RESET} `);
}

export function thinking(): () => void {
  process.stdout.write(`\n  ${DIM}thinking...${RESET}`);
  return () => {
    process.stdout.write('\x1b[2K\r');
  };
}
