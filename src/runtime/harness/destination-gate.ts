/**
 * Destination gate — integrity verification for AMBIENT-TARGET writes.
 *
 * Born from the 2026-06-13 wrong-site incident: a "build a NEW law-firm
 * site and host it" task ran `netlify deploy --prod` from a directory
 * that carried an inherited `.netlify` link to an UNRELATED live site
 * (revill-law-firm). The deploy succeeded — and clobbered that site —
 * because its destination is AMBIENT (read from cwd state), not in the
 * command's args. Every existing gate was structurally blind:
 *
 *   - the execution-wrap + confirm-first gates classify writes via
 *     `isMutatingExternalWrite`, which only looks at `composio_execute_tool`
 *     — `run_shell_command` is explicitly NOT classified.
 *   - the grounding gate extracts the target from the call ARGS
 *     (`extractTargetKeys`: to/recipient/record_id/…). A deploy whose
 *     target lives in an ambient `.netlify` link has NO target in its
 *     args, so grounding returns "no target extractable → allow".
 *   - the approval card's subject just echoes the command string, so the
 *     human approver can't see WHERE it lands either.
 *
 * The failure class is universal, not netlify-specific: ANY irreversible
 * publish whose destination is implicit (a deploy reading `.netlify`, a
 * `git push` to an ambient upstream, `npm publish` to the configured
 * registry, an `aws`/`gcloud` command on the "current" profile) can land
 * on the wrong place silently. You cannot generically RESOLVE the ambient
 * target (every CLI stores it differently — a rabbit hole). So this gate
 * does the one thing that IS tool-agnostic: it detects the ABSENCE of an
 * explicit destination on an irreversible publish verb and forces the
 * target into the open before the write fires.
 *
 *   1. MODEL NUDGE (one-shot, recoverable): the first time a session
 *      issues an irreversible publish with no explicit destination token,
 *      soft-block with a message telling the model to make the target
 *      explicit (e.g. `--site <id>`) or consciously confirm the current
 *      link (`netlify status`). The SECOND attempt of the same shape
 *      passes — a speed bump, not a wall (mirrors the grounding gate's
 *      duplicate-target bump). "Inform, rarely block."
 *
 *   2. CARD ANNOTATION (see loop.ts extractApprovalSubject): the shell
 *      approval card gets a "⚠ implicit target" suffix so the human
 *      approves with eyes open even if the model proceeds.
 *
 * Fail-open by design: an unparseable command, a non-publish command, or
 * a command that already names a destination NEVER blocks. Env:
 * CLEMMY_DESTINATION_GATE=off disables; =on (default) gates shell writes.
 */
import { getRuntimeEnv } from '../../config.js';

export function isDestinationGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_DESTINATION_GATE', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

// ─────────────────────────────────────────────────────────────────
// Pure classification
// ─────────────────────────────────────────────────────────────────

/**
 * Verbs that PUBLISH to a remote environment irreversibly. A wrong one is
 * felt immediately (a live site overwritten, a package version burned).
 * Matched as whole whitespace tokens so "deploy" in a path doesn't trip.
 */
const PUBLISH_VERBS: ReadonlySet<string> = new Set([
  'deploy',
  'publish',
  'release',
  'promote',
  'ship',
]);

/** Production-deploy flags are themselves a strong irreversible-publish
 *  signal even when the verb is generic (`vercel --prod`). */
const PROD_FLAGS: ReadonlySet<string> = new Set(['--prod', '--production']);

/**
 * Tokens that name an EXPLICIT destination. Presence of ANY of these means
 * the target is in the command (not ambient) → the gate stays out of the
 * way. Generous on purpose: a false "explicit" only means we don't nudge,
 * and the approval card still fires. Covers the common publish CLIs
 * (netlify/vercel/firebase/gh/npm/aws/gcloud/wrangler/fly/heroku/git).
 */
const EXPLICIT_DEST_FLAG_RE =
  /(^|\s)(--site|--site-id|--site-name|--project|--project-id|--app|--app-name|--account|--account-slug|--profile|--target|--env|--environment|--alias|--scope|--org|--team|--registry|--repo|--repository|--bucket|--cluster|--namespace|--context|--site_id|--prod-site|-s)(=|\s)/i;

/** An explicit remote URI/scheme also pins the destination. */
const EXPLICIT_DEST_URI_RE = /(^|\s)(s3:\/\/|gs:\/\/|https?:\/\/|git@|ssh:\/\/)\S+/i;

export interface ShellWriteShape {
  /** Whether this command is an irreversible publish at all. */
  isPublish: boolean;
  /** The publish verb/flag that matched (telemetry + shape key). */
  verb: string | undefined;
  /** The leading CLI binary (e.g. "netlify"), for the shape key. */
  binary: string | undefined;
  /** Whether the command names an explicit destination. */
  hasExplicitDestination: boolean;
  /** A PRODUCTION publish (`--prod`/`--production`) — the irreversible,
   *  high-stakes flavor that warrants a HARD block (not a one-shot nudge)
   *  when the destination is ambient. */
  isProd: boolean;
}

/** Tokenize a command segment on whitespace, stripping surrounding quotes. */
function tokenize(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Classify a raw shell command for the destination gate. Pure — no I/O.
 *
 * Robustness against false positives (this gate nudges on every shell
 * publish, so precision matters):
 *   - QUOTED regions are stripped before verb-scan, so a verb inside a
 *     commit message / echo string (`git commit -m "deploy fix"`) never
 *     trips it.
 *   - a publish verb only counts in the LEADING sub-command run of a
 *     segment (the non-flag tokens right after the binary), so
 *     `firefox --foo deploy` style noise after a flag is ignored. Handles
 *     compound commands (`cd x && netlify deploy`) by scanning each
 *     `&&`/`||`/`;`/`|` segment.
 *   - `--prod`/`--production` anywhere (unquoted) is itself a publish
 *     signal even without a verb (`vercel --prod`).
 * Explicit-destination detection runs against the RAW command (a
 * `--site` inside quotes is still an explicit target).
 */
export function classifyShellCommand(command: string): ShellWriteShape {
  if (!command || typeof command !== 'string') {
    return { isPublish: false, verb: undefined, binary: undefined, hasExplicitDestination: false, isProd: false };
  }
  // Strip quoted regions so verbs inside messages/strings don't match.
  const unquoted = command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const segments = unquoted.split(/&&|\|\||;|\|/);

  let verb: string | undefined;
  let binary: string | undefined;
  let isProd = false;
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    // Skip a leading env-var assignment / sudo to find the real binary.
    let idx = 0;
    while (idx < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]) || tokens[idx] === 'sudo')) idx += 1;
    const segBinary = tokens[idx]?.split('/').pop();
    // PROD flag anywhere in this segment is a publish signal.
    const prodFlag = tokens.find((t) => PROD_FLAGS.has(t.toLowerCase()));
    // Leading sub-command run: non-flag tokens immediately after the binary.
    let verbInSegment: string | undefined;
    for (let j = idx + 1; j < tokens.length; j += 1) {
      if (tokens[j].startsWith('-')) break; // first flag ends the sub-command run
      if (PUBLISH_VERBS.has(tokens[j].toLowerCase())) { verbInSegment = tokens[j].toLowerCase(); break; }
    }
    if (verbInSegment || prodFlag) {
      verb = verbInSegment ?? prodFlag!.toLowerCase();
      binary = segBinary;
      isProd = !!prodFlag;
      break;
    }
  }
  if (!verb) {
    return { isPublish: false, verb: undefined, binary: undefined, hasExplicitDestination: false, isProd: false };
  }
  const hasExplicitDestination = EXPLICIT_DEST_FLAG_RE.test(command) || EXPLICIT_DEST_URI_RE.test(command);
  // Harden the prod hard-block (review 2026-06-14): the verb-scan runs on the
  // quote-STRIPPED command, so `deploy "--prod"` would miss the prod flag and
  // downgrade to a one-shot draft block. Re-check the RAW command for --prod. We
  // only reach here when a publish verb was already found, so a stray --prod in
  // an unrelated quoted string can't trip this (isPublish would be false).
  const isProdRaw = isProd || /(?:^|[\s"'=])--(prod|production)\b/i.test(command);
  return { isPublish: true, verb, binary, hasExplicitDestination, isProd: isProdRaw };
}

export interface DestinationGateResult {
  /** 'allow' = nothing to do; 'flag' = irreversible publish, no explicit target. */
  action: 'allow' | 'flag';
  reason: string;
  verb?: string;
  /** Stable per-(binary,verb) key for the one-shot ledger. */
  shapeKey?: string;
  /** HARD block (every attempt, not one-shot): a PRODUCTION (`--prod`) publish
   *  to an ambient target — irreversible-write-without-confirmed-target, the
   *  case that must not be clobberable by simply retrying the same command.
   *  Non-prod ambient publishes stay a one-shot nudge. */
  hardBlock?: boolean;
}

/**
 * Evaluate a shell command's destination explicitness. Pure: the caller
 * owns the one-shot ledger + telemetry. Fail-open: non-publish or
 * explicit-target commands → allow.
 */
export function evaluateShellDestination(command: string): DestinationGateResult {
  const shape = classifyShellCommand(command);
  if (!shape.isPublish) {
    return { action: 'allow', reason: 'not an irreversible publish command' };
  }
  if (shape.hasExplicitDestination) {
    return { action: 'allow', reason: 'destination is explicit in the command', verb: shape.verb };
  }
  return {
    action: 'flag',
    reason: `irreversible ${shape.isProd ? 'PRODUCTION ' : ''}publish (${shape.verb}) with no explicit destination — target is ambient (read from the current directory/account link)`,
    verb: shape.verb,
    shapeKey: `${shape.binary ?? 'shell'}:${shape.verb}`,
    hardBlock: shape.isProd,
  };
}

// ─────────────────────────────────────────────────────────────────
// Shell NETWORK-MUTATION classifier (blind-spot audit #2)
// ─────────────────────────────────────────────────────────────────

/**
 * `run_shell_command` is the universal external-write vector — `curl -X POST`,
 * `gh api --method POST`, `sf data update`, `sendmail` — but
 * `isMutatingExternalWrite` only classifies `composio_execute_tool`, so these
 * sends bypass the grounding (payload-integrity) gate that composio/MCP sends
 * get. This recognizes the CLEAR network-mutation shapes so the brackets gate
 * can route them through grounding (the Eley/mailbox incident class via shell).
 *
 * CONSERVATIVE by construction (the codebase deferred shell classification as
 * "unreliable", execution-gate.ts) — we match only high-signal mutation shapes
 * and prefer false-NEGATIVES over false-positives. A miss just means grounding
 * doesn't run (status quo); a false-positive only triggers a FAIL-OPEN grounding
 * check that no-ops when there's no target → harmless. A plain `curl https://x`
 * (a GET / read) is NOT matched — only an explicit mutating method or a request
 * body / upload / known send-CLI verb.
 */
export interface ShellNetworkMutation {
  isNetworkMutation: boolean;
  /** Stable per-binary shape key for the duplicate ledger (e.g. "shell:curl"). */
  shapeKey?: string;
}

/**
 * Does `binary` (the command verb) + `rest` (its arg string, quote-stripped)
 * constitute a clear network mutation? Binary-anchored so a send-CLI name inside
 * a FILENAME or quoted string (`cat notes-about-sendmail.txt`) never trips it.
 */
function binaryIsNetworkMutation(binary: string, rest: string): boolean {
  switch (binary) {
    case 'curl':
    case 'xh':
      return /\s(-x|--request|--method[ =])\s*(post|put|patch|delete)\b/i.test(rest)
        || /\s(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-f|--form|-t|--upload-file)\b/i.test(rest);
    case 'wget':
      return /\s(--post-data|--post-file|--body-data|--body-file|--method[ =](post|put|patch|delete))\b/i.test(rest);
    case 'http': // httpie
    case 'https':
      return /\s(post|put|patch|delete)\b/i.test(rest);
    case 'gh':
      return /^\s*api\b[\s\S]*\s(-x|--method)\s*(post|put|patch|delete)\b/i.test(rest)
        || /^\s*(pr|issue|release|gist|repo|secret|workflow)\s+(create|edit|delete|merge|close|comment|upload|set|run|dispatch)\b/i.test(rest);
    case 'sf':
      return /^\s*data\s+(update|insert|delete|upsert|import|tree)\b/i.test(rest);
    case 'sfdx':
      return /force:data:/i.test(rest);
    case 'sendmail':
    case 'mailx':
    case 'mutt':
    case 'swaks':
      return true; // the binary IS a send command
    case 'mail':
      return rest.trim().length > 0; // `mail -s … addr` (a bare interactive `mail` has no args)
    case 'aws':
      return /^\s*s3\s+(cp|sync|mv)\b[\s\S]*\ss3:\/\//i.test(rest)
        || /^\s*s3api\s+(put|delete|copy)-/i.test(rest);
    case 'stripe':
      return /\b(create|charge|payments?|refund)\b/i.test(rest);
    case 'twilio':
      return /\bmessages?:create\b/i.test(rest);
    case 'scp':
    case 'rsync':
      return /\s[\w.-]+@[\w.-]+:/.test(rest) || /\s[\w.-]+:\S/.test(rest);
    default:
      return false;
  }
}

/**
 * Classify a shell command as a clear network mutation (send). Pure, binary-
 * anchored, quote-stripped: scans each `&&`/`||`/`;`/`|` segment, finds the
 * command binary (skipping env-assigns / sudo), and tests it + its args.
 */
export function classifyShellNetworkMutation(command: string): ShellNetworkMutation {
  if (!command || typeof command !== 'string') return { isNetworkMutation: false };
  const unquoted = command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  for (const segment of unquoted.split(/&&|\|\||;|\|/)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo')) i += 1;
    const binary = tokens[i]?.split('/').pop()?.toLowerCase();
    if (!binary) continue;
    const rest = ` ${tokens.slice(i + 1).join(' ')} `;
    if (binaryIsNetworkMutation(binary, rest)) {
      return { isNetworkMutation: true, shapeKey: `shell:${binary}` };
    }
  }
  return { isNetworkMutation: false };
}

/**
 * Build the "⚠ implicit target" suffix for the approval card. Returns ''
 * when the command names an explicit destination or isn't a publish, so
 * the card is unchanged in the common case. Pure.
 */
export function destinationCardSuffix(command: string): string {
  if (!isDestinationGateEnabled()) return '';
  const result = evaluateShellDestination(command);
  return result.action === 'flag' ? '  ⚠ implicit target (uses the directory/account currently linked)' : '';
}

// ─────────────────────────────────────────────────────────────────
// One-shot ledger + soft error (mirrors grounding-gate's speed bump)
// ─────────────────────────────────────────────────────────────────

/** (session, shapeKey) combos already nudged once — the second attempt of
 *  the same shape passes (conscious proceed). In-memory: a restart resets,
 *  which only makes the gate gentler. */
const nudgedShapes = new Set<string>();
export function _resetDestinationStateForTests(): void { nudgedShapes.clear(); }

/** Has this (session, shapeKey) already been nudged this session? */
export function wasDestinationNudged(sessionId: string, shapeKey: string): boolean {
  return nudgedShapes.has(`${sessionId}::${shapeKey}`);
}
export function markDestinationNudged(sessionId: string, shapeKey: string): void {
  nudgedShapes.add(`${sessionId}::${shapeKey}`);
}

/**
 * Thrown for an ambient-target irreversible publish. A non-prod (draft)
 * publish is a SOFT one-shot nudge — the gate marks the shape nudged so a
 * conscious retry goes through. A PRODUCTION (`--prod`) publish is a HARD
 * block that repeats on every attempt until the command carries an EXPLICIT
 * destination — retrying the same ambient command can NEVER clobber the
 * linked site (the 2026-06-14 Test-5 finding: an ambient `--prod` retry
 * deployed onto a stale-linked site before the model self-corrected).
 * Surfaced to the model as a SOFT tool error (same path as
 * GroundingCheckFailedError) so it recovers instead of aborting the run.
 */
export class ImplicitDestinationError extends Error {
  public readonly verb: string;
  public readonly shapeKey: string;
  public readonly hardBlock: boolean;
  constructor(opts: { command: string; verb: string; shapeKey: string; hardBlock?: boolean }) {
    const binary = opts.shapeKey.split(':')[0];
    const hard = !!opts.hardBlock;
    super(
      `IMPLICIT_DESTINATION: this \`${opts.verb}\` command names no explicit destination, so it will publish to whatever site/account/registry THIS directory is currently linked to — which may be an UNRELATED live target (a stale \`.netlify\`/remote/profile link clobbers the wrong place silently). ` +
        (hard
          ? `This is a PRODUCTION publish, so it is REFUSED until the target is explicit — retrying the SAME command will keep being refused (it could clobber the linked site). You MUST add an explicit destination: run \`${binary} status\` (or \`git remote -v\`) to read the currently-linked target, decide if it is the one THIS task wants, then re-issue WITH \`--site <id>\` (or \`--project\`/\`--account\`/explicit remote). If you were asked for a NEW target, create it first (e.g. \`${binary} sites:create\`) and deploy with its explicit id.`
          : `Before re-issuing: either (a) make the target EXPLICIT in the command (e.g. \`${binary} … --site <id>\`/\`--project\`/\`--account\`/an explicit remote), or (b) confirm the current link is the intended one (e.g. \`${binary} status\` / \`git remote -v\`) and that it matches THIS task's target — if you were asked for a NEW target, create/select it first. Then retry: a conscious second attempt of the same command will pass.`),
    );
    this.name = 'ImplicitDestinationError';
    this.verb = opts.verb;
    this.shapeKey = opts.shapeKey;
    this.hardBlock = hard;
  }
}

// ─────────────────────────────────────────────────────────────────
// Destination PROVENANCE (2026-06-15 second wrong-site incident)
// ─────────────────────────────────────────────────────────────────
//
// The implicit-destination gate above forces a target into the open. But an
// EXPLICIT target can still be the WRONG one: the 2026-06-15 incident had a
// `netlify sites:create` fail on an interactive team prompt, after which the
// model grabbed an UNRELATED existing site id from `netlify status` and ran
// `deploy --site <id>` onto it — clobbering a live law-firm site with a
// coffee-shop build. `hasExplicitDestination` said "explicit → allow", because
// the gate verified explicitness, never PROVENANCE. This adds the missing
// check: a publish to an explicit target is only safe if that target was
// CREATED or NAMED in this task/session. Pure — the caller supplies the
// provenance predicate (built from the eventlog) + scopes it to chat sessions
// so recurring workflows that legitimately reuse a stable site id aren't blocked.

const PUBLISH_TARGET_FLAG_RE =
  /(?:--site|--site-id|--site-name|--project|--project-id|--app|--app-name|--target)(?:=|\s+)["']?([A-Za-z0-9][\w.-]*)["']?/gi;

/** Extract the explicit publish target value(s) (site/project/app id or name),
 *  lowercased + de-duped. Empty when the command names no explicit target.
 *  Shell-var placeholders and the literal "current" are ignored (they route
 *  through the implicit gate, not provenance). Pure. */
export function extractExplicitPublishTargets(command: string): string[] {
  if (!command || typeof command !== 'string') return [];
  const out = new Set<string>();
  PUBLISH_TARGET_FLAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PUBLISH_TARGET_FLAG_RE.exec(command)) !== null) {
    const v = m[1].toLowerCase();
    if (v && v !== 'current' && !v.startsWith('$')) out.add(v);
  }
  return [...out];
}

/**
 * Evaluate whether an explicit-target publish has session PROVENANCE. Pure: the
 * caller supplies `hasProvenance(target)` (sites created this session + targets
 * the user named). Returns allow when it's not a publish, names no explicit
 * target (the implicit gate owns that), or every explicit target is
 * provenanced; flag (hardBlock) when a publish names an explicit target with NO
 * provenance — the clobber-an-unrelated-site shape. Hard so a retry of the same
 * command can't slip it through.
 */
export function evaluateDestinationProvenance(
  command: string,
  hasProvenance: (target: string) => boolean,
): DestinationGateResult {
  const shape = classifyShellCommand(command);
  if (!shape.isPublish) return { action: 'allow', reason: 'not an irreversible publish command' };
  const targets = extractExplicitPublishTargets(command);
  if (targets.length === 0) {
    return { action: 'allow', reason: 'no explicit target — implicit-destination gate owns this' };
  }
  const unproven = targets.filter((t) => !hasProvenance(t));
  if (unproven.length === 0) {
    return { action: 'allow', reason: 'explicit target has session provenance', verb: shape.verb };
  }
  return {
    action: 'flag',
    reason: `publish (${shape.verb}) to explicit target "${unproven[0]}" with NO session provenance — not created or named in this conversation (clobber risk)`,
    verb: shape.verb,
    shapeKey: `${shape.binary ?? 'shell'}:${shape.verb}:unverified`,
    hardBlock: true,
  };
}

/**
 * Thrown for a publish to an EXPLICIT but UNPROVENANCED target — the 2026-06-15
 * clobber class (a coffee-shop build deployed onto a law-firm site via an
 * existing site id reused from `netlify status` after `sites:create` failed).
 * Always a HARD block. Surfaced as a SOFT tool error (recoverable) like
 * ImplicitDestinationError so the model self-corrects instead of aborting.
 */
export class UnverifiedDestinationError extends Error {
  public readonly verb: string;
  public readonly shapeKey: string;
  public readonly hardBlock = true;
  constructor(opts: { command: string; verb: string; shapeKey: string; targets: string[] }) {
    super(
      `UNVERIFIED_DESTINATION: this \`${opts.verb}\` publishes to "${opts.targets.join(', ')}", a target that was NOT created or named in THIS conversation — it may be an UNRELATED live site. REFUSED. (This is how a build once clobbered an unrelated site: a new-site create failed, and an existing site id from \`status\` was reused.) Do NOT deploy onto a pre-existing site you did not create for THIS task. Instead: create a DEDICATED new site NON-INTERACTIVELY — pass the team/account so it cannot hang on a prompt (e.g. \`netlify sites:create --name <slug> --account-slug <team>\`) — and deploy to ITS id. If the user EXPLICITLY named this exact site earlier, restate that and proceed. If creation FAILS on a wrong/missing team or arg (a 404, "no such team", an interactive team prompt), the right value is DISCOVERABLE — find it (\`netlify api listAccountsForUser\` for the real --account-slug, or recall your saved create memo) and RETRY; only STOP and report the blocker AFTER a genuine discover-and-retry still fails. Never publish onto an unverified target — but do not give up before you have actually tried to discover the right one.`,
    );
    this.name = 'UnverifiedDestinationError';
    this.verb = opts.verb;
    this.shapeKey = opts.shapeKey;
  }
}
