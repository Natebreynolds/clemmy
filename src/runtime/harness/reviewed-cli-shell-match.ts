/**
 * Reviewed-CLI shell match — recognises a shell command whose head is the
 * argv of a human-reviewed CLI read that the host already holds as a callable
 * operation.
 *
 * A reviewed read is a closed contract: the catalog entry names the program,
 * the argv prefix, and the structured arguments, and the host provisions it
 * as a callable operation with its own descriptor, binary, and argv proof. A
 * model that types the same command through the shell is asking for that
 * work without that proof, and the refusal it meets names nothing. This
 * module is the one place that turns the typed command back into the
 * operation id and its argument map, so the packet can steer to the operation
 * before the call and the pre-dispatch refusal can name it after.
 *
 * Generic over the CLI catalog: every entry with a `reviewedRead` is a
 * candidate; nothing here names a toolkit or product. A head match with no
 * current callable entry is `unmatched` — the shell stays an ordinary ad-hoc
 * command when the host has nothing better to offer. This grants nothing; the
 * reviewed carrier still re-proves the call on its own.
 */
import { cliCommandHead } from '../../memory/capability-effect-scope.js';
import { CLI_CATALOG, type CatalogReviewedReadV1 } from '../../integrations/cli-catalog/catalog.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';

export interface ReviewedCliArgumentMapEntry {
  /** Structured argument name (the `args_json` key). */
  name: string;
  /** The shell token that carried it (`--query`); the name for positionals. */
  token: string;
  required: boolean;
}

export type ReviewedCliShellMatch =
  | { status: 'unmatched' }
  | {
    status: 'matched';
    operationId: string;
    descriptorId: string;
    argumentMap: ReadonlyArray<ReviewedCliArgumentMapEntry>;
  };

function expectedHeadOf(command: string, reviewedRead: CatalogReviewedReadV1): string {
  return [command, ...reviewedRead.argvPrefix.filter((token) => !token.startsWith('-'))].join(' ');
}

function argumentMapOf(reviewedRead: CatalogReviewedReadV1): ReviewedCliArgumentMapEntry[] {
  return reviewedRead.arguments.map((argument) => ({
    name: argument.name,
    token: argument.token ?? argument.name,
    required: argument.required,
  }));
}

/** Every reviewed read the catalog declares, keyed by its head. */
function reviewedReads(): Array<{ head: string; command: string; reviewedRead: CatalogReviewedReadV1 }> {
  const out: Array<{ head: string; command: string; reviewedRead: CatalogReviewedReadV1 }> = [];
  for (const entry of CLI_CATALOG) {
    if (!entry.reviewedRead) continue;
    out.push({
      head: expectedHeadOf(entry.command, entry.reviewedRead),
      command: entry.command,
      reviewedRead: entry.reviewedRead,
    });
  }
  return out;
}

/** True when the installed host catalog holds a current callable entry for
 * this operation. No installed factory means no callable entry. */
export function reviewedCliOperationIsCallable(operationId: string): boolean {
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) return false;
  try {
    return factory.snapshot().some((entry) => isCurrentCallableCatalogEntry(entry)
      && entry.manifest.operationId === operationId
      && entry.manifest.lifecycle.state === 'current');
  } catch {
    return false;
  }
}

/**
 * Match a shell command against the callable reviewed reads. The head is the
 * shared command-head normaliser, so `sf data query --query … --json` and the
 * memory key for the same command agree on `sf data query`.
 */
export function reviewedCliShellMatch(
  command: string,
  options: {
    /** Default true: only a read the installed host catalog can call right now
     *  matches. False matches on the catalog declaration alone — for a caller
     *  that proves connection its own way (the workflow/Space reviewed-CLI
     *  carrier), outside any chat objective's materialized manifest. */
    requireCallable?: boolean;
  } = {},
): ReviewedCliShellMatch {
  const head = cliCommandHead(command ?? '');
  if (!head) return { status: 'unmatched' };
  for (const candidate of reviewedReads()) {
    if (candidate.head !== head) continue;
    if (options.requireCallable !== false && !reviewedCliOperationIsCallable(candidate.reviewedRead.operationId)) continue;
    return {
      status: 'matched',
      operationId: candidate.reviewedRead.operationId,
      descriptorId: candidate.reviewedRead.descriptorId,
      argumentMap: argumentMapOf(candidate.reviewedRead),
    };
  }
  return { status: 'unmatched' };
}

/** The argument map of a reviewed read by its operation id, from the catalog
 * declaration alone (no callable check). Used to render a refusal that already
 * knows the operation id. */
export function reviewedCliArgumentMapForOperation(
  operationId: string,
): ReadonlyArray<ReviewedCliArgumentMapEntry> | null {
  const wanted = operationId.trim();
  for (const candidate of reviewedReads()) {
    if (candidate.reviewedRead.operationId === wanted) return argumentMapOf(candidate.reviewedRead);
  }
  return null;
}

/** `"query" ← --query, "target_org" ← --target-org (optional)` */
export function renderReviewedCliArgumentMap(
  argumentMap: ReadonlyArray<ReviewedCliArgumentMapEntry>,
): string {
  return argumentMap
    .map((entry) => `${JSON.stringify(entry.name)} ← ${entry.token}${entry.required ? '' : ' (optional)'}`)
    .join(', ');
}

/** `work_call name=<operationId> args_json={"query": "<string>"}` — the
 * callable shape a packet renders in place of the shell command. Optional
 * arguments are omitted so the example is directly reusable. */
export function renderReviewedCliWorkCallExample(
  operationId: string,
  argumentMap: ReadonlyArray<ReviewedCliArgumentMapEntry>,
): string {
  const required = argumentMap.filter((entry) => entry.required);
  const shape = `{${required.map((entry) => `${JSON.stringify(entry.name)}: "<string>"`).join(', ')}}`;
  return `work_call name=${operationId} args_json=${shape}`;
}

export type ReviewedCliArgvCompilation =
  | { status: 'unmatched' }
  | {
    status: 'matched';
    operationId: string;
    descriptorId: string;
    /** Structured arguments in the reviewed read's own vocabulary. */
    args: Record<string, string>;
  }
  | { status: 'refused'; operationId: string; descriptorId: string; reason: string };

/**
 * Compile a frozen argv vector into the reviewed read it names. A Space data
 * source declares a command line; the harness never spawns that line. When
 * its head is a reviewed read, the line is a spelling of that operation and
 * runs through the same shared durable kernel as every other read, with the
 * carrier composing the real argv from these structured arguments. Flags the
 * catalog's argv prefix already carries (for example a JSON output flag) are
 * accepted and dropped; any option the reviewed read does not declare, a
 * missing value, or a stray positional refuses with the exact token, since
 * the reviewed operation cannot carry it. Generic over the CLI catalog.
 */
export function compileReviewedCliArgv(argv: readonly string[]): ReviewedCliArgvCompilation {
  const tokens = argv.map((token) => String(token ?? '').trim()).filter(Boolean);
  if (tokens.length === 0) return { status: 'unmatched' };
  const head = cliCommandHead(tokens.join(' '));
  const candidate = reviewedReads().find((entry) => entry.head === head);
  if (!candidate) return { status: 'unmatched' };
  const { command, reviewedRead } = candidate;
  const operationId = reviewedRead.operationId;
  const descriptorId = reviewedRead.descriptorId;
  const refuse = (reason: string): ReviewedCliArgvCompilation => (
    { status: 'refused', operationId, descriptorId, reason }
  );
  const argumentMap = argumentMapOf(reviewedRead);
  const byToken = new Map(argumentMap.map((entry) => [entry.token, entry]));
  const prefixFlags = new Set(reviewedRead.argvPrefix.filter((token) => token.startsWith('-')));
  const headTokens = [command, ...reviewedRead.argvPrefix.filter((token) => !token.startsWith('-'))];
  const accepted = argumentMap.map((entry) => entry.token).join(', ');
  const args: Record<string, string> = {};
  for (let index = headTokens.length; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (prefixFlags.has(token)) continue;
    if (!token.startsWith('-')) {
      return refuse(`unexpected argument "${token}"; ${operationId} accepts only ${accepted}`);
    }
    const equals = token.indexOf('=');
    const name = equals > 0 ? token.slice(0, equals) : token;
    const entry = byToken.get(name);
    if (!entry) return refuse(`option "${name}" is not part of ${operationId}; it accepts ${accepted}`);
    let value: string | undefined = equals > 0 ? token.slice(equals + 1) : undefined;
    if (value === undefined) {
      index += 1;
      value = tokens[index];
    }
    if (value === undefined) return refuse(`option "${name}" has no value`);
    if (Object.prototype.hasOwnProperty.call(args, entry.name)) {
      return refuse(`option "${name}" is given twice`);
    }
    args[entry.name] = value;
  }
  for (const entry of argumentMap) {
    if (entry.required && !Object.prototype.hasOwnProperty.call(args, entry.name)) {
      return refuse(`required option "${entry.token}" is missing`);
    }
  }
  return { status: 'matched', operationId, descriptorId, args };
}
