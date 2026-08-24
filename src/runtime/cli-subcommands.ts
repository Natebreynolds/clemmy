/**
 * Read a program's subcommands out of its own help text.
 *
 * WHY THIS EXISTS. The capability index records a local program as ONE row
 * whose identifier is the bare command — `identifier === carrier`, effect
 * `unknown`, description empty. But a program is a carrier, not a capability:
 * its subcommands are the capabilities, and they are what an ask actually
 * needs to reach. This is the same shape as any carrier whose API is a control
 * plane rather than a capability list, and it is the one instance that costs
 * nothing to resolve — the answer is on the local disk, no network and no
 * provider bill.
 *
 * WHY IT IS DELIBERATELY CONSERVATIVE. A wrong subcommand is worse than a
 * missing one: a missing capability fails closed and asks, while an invented
 * one binds and then executes something the user never had. So every rule here
 * refuses when unsure. Help text is not a grammar — it is prose written for
 * humans, and the only honest position is to accept the few shapes that are
 * unambiguous and ignore everything else.
 *
 * THE SHAPES ACCEPTED, taken from real programs on a live machine rather than
 * imagined:
 *   `   clone      Clone a repository into a new directory`   (name, gap, text)
 *   `   auth:      Authenticate with the service`             (name, colon, text)
 * Both require leading indentation, a lowercase command-shaped token, and a
 * real description — the description is the point, because it is what makes
 * the capability findable later.
 *
 * NOT accepted, on purpose: bare comma-separated command lists (common, but
 * they carry NO description, so the resulting rows would be names with nothing
 * to retrieve on), usage syntax lines, flags, and section headings.
 */

export interface CliSubcommand {
  /** The token that selects this capability within its program. */
  name: string;
  /** The program's own one-line description of it. */
  description: string;
}

/** Bounded so one talkative program cannot flood the index. */
const DEFAULT_MAX = 60;
const MAX_DESCRIPTION = 200;

/**
 * Tokens that occupy the same position as a subcommand but name a section or a
 * syntax placeholder. Kept small on purpose — a long stop-list is a curated
 * vocabulary by another name, and it would start rejecting real subcommands
 * (`help`, `config` and `version` are genuine commands in many programs).
 */
const NOT_A_COMMAND = new Set([
  'usage', 'usages', 'options', 'option', 'flags', 'flag', 'arguments',
  'args', 'commands', 'command', 'examples', 'example', 'environment',
  'note', 'notes', 'see', 'where', 'default', 'defaults',
]);

/**
 * `name` then a separator, then a description. Leading indentation is
 * required: an unindented line is prose or a heading. The name must start with
 * a letter and be at least two characters, which drops flags (`-v`),
 * placeholders (`<cmd>`) and single-letter aliases.
 *
 * The separator is a colon FOLLOWED BY WHITESPACE, or a two-space gap. That
 * whitespace is load-bearing: without it an indented bare URL parses as a
 * perfect entry — `  https://docs.brew.sh` reads as name `https`, colon,
 * description `//docs.brew.sh`, which is how a real program contributed a real
 * garbage capability the first time this ran. A colon with nothing after it is
 * not a two-column layout.
 */
const ENTRY = /^\s+([a-z][a-z0-9][a-z0-9._-]*)(?::\s+|\s{2,})(\S.*)$/;

function looksLikeSyntax(description: string): boolean {
  // `git [-v | --version] …` and friends: a usage line, not a description.
  // A leading '/' catches the tail of any scheme that slipped through.
  return /^[[<(|\-/]/.test(description);
}

/**
 * Extract subcommands from `--help` output. Returns [] when the text carries
 * none of the accepted shapes — a program with no discoverable subcommands is
 * an ordinary answer, not a failure.
 */
export function parseCliSubcommands(
  helpText: string,
  options: { max?: number } = {},
): CliSubcommand[] {
  if (!helpText) return [];
  const max = Math.max(1, options.max ?? DEFAULT_MAX);
  const found = new Map<string, string>();

  for (const rawLine of helpText.split(/\r?\n/)) {
    // A tab-indented entry is still an entry; normalise before matching.
    const line = rawLine.replace(/\t/g, '    ');
    const match = ENTRY.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const description = match[2]!.trim().replace(/\s+/g, ' ');
    if (NOT_A_COMMAND.has(name)) continue;
    if (!description || looksLikeSyntax(description)) continue;
    // First mention wins: help text often repeats a command in a later
    // "see also" block with weaker wording.
    if (found.has(name)) continue;
    found.set(name, description.slice(0, MAX_DESCRIPTION));
    if (found.size >= max) break;
  }

  return [...found].map(([name, description]) => ({ name, description }));
}
