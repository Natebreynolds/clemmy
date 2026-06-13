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
    return { isPublish: false, verb: undefined, binary: undefined, hasExplicitDestination: false };
  }
  // Strip quoted regions so verbs inside messages/strings don't match.
  const unquoted = command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const segments = unquoted.split(/&&|\|\||;|\|/);

  let verb: string | undefined;
  let binary: string | undefined;
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
      break;
    }
  }
  if (!verb) {
    return { isPublish: false, verb: undefined, binary: undefined, hasExplicitDestination: false };
  }
  const hasExplicitDestination = EXPLICIT_DEST_FLAG_RE.test(command) || EXPLICIT_DEST_URI_RE.test(command);
  return { isPublish: true, verb, binary, hasExplicitDestination };
}

export interface DestinationGateResult {
  /** 'allow' = nothing to do; 'flag' = irreversible publish, no explicit target. */
  action: 'allow' | 'flag';
  reason: string;
  verb?: string;
  /** Stable per-(binary,verb) key for the one-shot ledger. */
  shapeKey?: string;
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
    reason: `irreversible publish (${shape.verb}) with no explicit destination — target is ambient (read from the current directory/account link)`,
    verb: shape.verb,
    shapeKey: `${shape.binary ?? 'shell'}:${shape.verb}`,
  };
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
 * Thrown for an ambient-target irreversible publish on its FIRST
 * occurrence. Surfaced to the model as a SOFT tool error (same path as
 * GroundingCheckFailedError) so it recovers — make the target explicit or
 * confirm the current link — instead of the run aborting. One-shot: the
 * gate marks the shape nudged, so a conscious retry goes through.
 */
export class ImplicitDestinationError extends Error {
  public readonly verb: string;
  public readonly shapeKey: string;
  constructor(opts: { command: string; verb: string; shapeKey: string }) {
    const binary = opts.shapeKey.split(':')[0];
    super(
      `IMPLICIT_DESTINATION: this \`${opts.verb}\` command names no explicit destination, so it will publish to whatever site/account/registry THIS directory is currently linked to — which may be an UNRELATED live target (a stale \`.netlify\`/remote/profile link clobbers the wrong place silently). ` +
        `Before re-issuing: either (a) make the target EXPLICIT in the command (e.g. \`${binary} … --site <id>\`/\`--project\`/\`--account\`/an explicit remote), or (b) confirm the current link is the intended one (e.g. \`${binary} status\` / \`git remote -v\`) and that it matches THIS task's target — if you were asked for a NEW target, create/select it first. ` +
        `Then retry: a conscious second attempt of the same command will pass.`,
    );
    this.name = 'ImplicitDestinationError';
    this.verb = opts.verb;
    this.shapeKey = opts.shapeKey;
  }
}
