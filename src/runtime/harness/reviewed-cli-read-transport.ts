/**
 * Transport-only crossing for one host-reviewed CLI read.
 *
 * Durable manifest lifecycle, port registration, consent, and replay live in
 * the host graph. This leaf receives that authority as one exact sealed
 * `call.expected` value and independently re-reads only the physical facts it
 * owns: the authority-sealed reviewed descriptor and executable bytes. It must
 * never import the manifest store, event log, or a native database binding.
 */
import { redactSensitiveText } from '../security.js';
import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { stableJsonFingerprint } from '../../shared/stable-json-digest.js';
import type {
  AttestedTransportCall,
  AttestedTransportObservation,
} from './implementation-artifacts/attested-transport.js';
import {
  REVIEWED_CLI_ARGUMENT_COMPILER_ID,
  REVIEWED_CLI_READ_ACCOUNT,
  REVIEWED_CLI_READ_CARRIER,
  compileReviewedCliArgv,
  currentReviewedCliDescriptor,
  listReviewedCliReadDescriptors,
  observeReviewedCliExecutable,
  reviewedCliDescriptorDigest,
  reviewedCliInputSchema,
  type ReviewedCliReadDescriptorV1,
} from './reviewed-cli-read-config.js';

export const REVIEWED_CLI_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    version: Object.freeze({ type: 'integer', const: 1 }),
    status: Object.freeze({ type: 'string', const: 'exited' }),
    operationId: Object.freeze({ type: 'string' }),
    executableRealpath: Object.freeze({ type: 'string' }),
    argv: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
    exitCode: Object.freeze({ type: 'integer', const: 0 }),
    signal: Object.freeze({ type: 'null' }),
    stdout: Object.freeze({ type: 'string' }),
    stderr: Object.freeze({ type: 'string' }),
    stdoutTruncated: Object.freeze({ type: 'boolean', const: false }),
    stderrTruncated: Object.freeze({ type: 'boolean', const: false }),
  }),
  required: Object.freeze([
    'version', 'status', 'operationId', 'executableRealpath', 'argv', 'exitCode',
    'signal', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated',
  ]),
  additionalProperties: false,
});

export type ReviewedCliProcessOutcomeV1 = {
  version: 1;
  status: 'exited' | 'nonzero_exit' | 'timed_out' | 'output_limit' | 'spawn_failed' | 'identity_changed';
  operationId: string;
  executableRealpath: string;
  argv: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const PROCESS_DIAGNOSTIC_MAX_CHARS = 240;

function stripAnsiText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * The one bounded line that says WHY the process failed, so the block reason
 * a run reports names its own fix instead of only "nonzero_exit". Prefers the
 * provider's structured failure on stdout (sf --json: {name, message}), then
 * the last stderr line that is not a CLI update warning, then stdout's last
 * line. Secret-redacted, ANSI-stripped, capped. Absent when nothing was said.
 */
export function reviewedCliProcessDiagnostic(
  outcome: Pick<ReviewedCliProcessOutcomeV1, 'stdout' | 'stderr'>,
): string | null {
  const stdout = stripAnsiText(outcome.stdout ?? '').trim();
  const stderr = stripAnsiText(outcome.stderr ?? '').trim();
  let line: string | null = null;
  if (stdout.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (message) line = name ? `${name}: ${message}` : message;
      else if (name) line = name;
    } catch {
      // not JSON — fall through to stderr / plain stdout
    }
  }
  if (!line) {
    const informative = stderr
      .split('\n')
      .map((entry) => entry.replace(/^\s*›\s*/, '').trim())
      .filter((entry) => entry.length > 0 && !/^warning:/i.test(entry));
    line = informative.at(-1) ?? null;
  }
  if (!line && stdout) line = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1) ?? null;
  if (!line) return null;
  const collapsed = redactSensitiveText(line.replace(/\s+/g, ' ').trim());
  return collapsed.length > PROCESS_DIAGNOSTIC_MAX_CHARS
    ? `${collapsed.slice(0, PROCESS_DIAGNOSTIC_MAX_CHARS - 1)}…`
    : collapsed;
}

export class ReviewedCliProcessError extends Error {
  readonly outcome: ReviewedCliProcessOutcomeV1;

  constructor(outcome: ReviewedCliProcessOutcomeV1) {
    const diagnostic = reviewedCliProcessDiagnostic(outcome);
    super(diagnostic
      ? `reviewed CLI process ${outcome.status}: ${diagnostic}`
      : `reviewed CLI process ${outcome.status}`);
    this.name = 'ReviewedCliProcessError';
    this.outcome = Object.freeze(outcome);
  }
}

interface CurrentReviewedCliTransportIdentity {
  descriptor: ReviewedCliReadDescriptorV1;
  operationVersion: string;
  definitionFingerprint: string;
  invokePortId: string;
}

function currentDescriptorForOperation(operationId: string): ReviewedCliReadDescriptorV1 | null {
  const matches = listReviewedCliReadDescriptors().filter((entry) => (
    entry.operationId === operationId && entry.accountId === REVIEWED_CLI_READ_ACCOUNT
  ));
  if (matches.length !== 1) return null;
  return currentReviewedCliDescriptor(matches[0]!);
}

/**
 * Reconstruct the exact definition identity the host materializer seals, using
 * only current reviewed descriptor/executable facts. This is definition
 * revalidation, not lifecycle authority; revocation remains a host decision.
 */
function currentTransportIdentity(
  descriptor: ReviewedCliReadDescriptorV1,
): CurrentReviewedCliTransportIdentity {
  const operationVersion = reviewedCliDescriptorDigest(descriptor);
  const inputSchema = reviewedCliInputSchema(descriptor);
  const schemaFingerprint = stableJsonFingerprint(inputSchema);
  const outputSchemaFingerprint = stableJsonFingerprint(REVIEWED_CLI_OUTPUT_SCHEMA);
  const invokePortId = `port:reviewed-cli:v1:${operationVersion}`;
  const definitionFingerprint = createHash('sha256').update(closedCanonicalJson({
    domain: 'live-read-capability-definition',
    version: 1,
    carrier: {
      kind: 'cli',
      name: REVIEWED_CLI_READ_CARRIER.trim().toLowerCase(),
    },
    provider: {
      kind: 'reviewed_cli',
      identity: descriptor.executableRealpath,
      version: descriptor.binarySha256,
    },
    operation: {
      id: descriptor.operationId,
      version: operationVersion,
    },
    accountId: descriptor.accountId,
    effect: 'read',
    effectAttestation: 'host_reviewed',
    schemaFingerprint,
    inputSchema,
    outputSchema: REVIEWED_CLI_OUTPUT_SCHEMA,
    outputSchemaFingerprint,
    outputSchemaAttestation: 'host_reviewed',
    invoke: {
      portId: invokePortId,
      argumentCompiler: {
        id: REVIEWED_CLI_ARGUMENT_COMPILER_ID,
        version: operationVersion,
      },
    },
  }, {
    maxDepth: 24,
    maxNodes: 100_000,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 1_048_576,
  }), 'utf8').digest('hex');
  return { descriptor, operationVersion, definitionFingerprint, invokePortId };
}

/** Shipped transport observation. It reads descriptor and executable bytes,
 * never a manifest echo. */
export function observeReviewedCliReadTransport(
  operationId: string,
  accountId: string,
): AttestedTransportObservation | null {
  if (accountId !== REVIEWED_CLI_READ_ACCOUNT) return null;
  try {
    const descriptor = currentDescriptorForOperation(operationId);
    if (!descriptor) return null;
    const current = currentTransportIdentity(descriptor);
    return {
      operationId,
      accountId,
      definitionFingerprint: current.definitionFingerprint,
      providerVersion: descriptor.binarySha256,
      operationVersion: current.operationVersion,
      observedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function exactExpectedIdentity(
  call: AttestedTransportCall,
  current: CurrentReviewedCliTransportIdentity,
): boolean {
  const expected = call.expected;
  const descriptor = current.descriptor;
  return Boolean(
    expected
    // Manifest lifecycle and its exact digest were already reopened by the
    // host-owned registered port. The leaf carries them forward as opaque,
    // closed identity rather than reopening the host database a second time.
    && expected.manifestId.trim().length > 0
    && expected.manifestId === expected.manifestId.trim()
    && /^[a-f0-9]{64}$/.test(expected.manifestDigest)
    && call.operationId === descriptor.operationId
    && call.accountId === REVIEWED_CLI_READ_ACCOUNT
    && expected.providerKind === 'reviewed_cli'
    && expected.providerIdentity === descriptor.executableRealpath
    && expected.providerVersion === descriptor.binarySha256
    && expected.operationVersion === current.operationVersion
    && expected.definitionFingerprint === current.definitionFingerprint
    && expected.invokePortId === current.invokePortId
    && expected.argumentCompiler.id === REVIEWED_CLI_ARGUMENT_COMPILER_ID
    && expected.argumentCompiler.version === current.operationVersion
    && expected.providerInputSchemaDigest === undefined
    && expected.providerOutputSchemaObserved === undefined
    && expected.providerOutputSchemaDigest === undefined
  );
}

function boundedOutput(value: string | Buffer | undefined, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'utf8');
  if (source.length <= maxBytes) return { text: source.toString('utf8'), truncated: false };
  let end = maxBytes;
  let text = source.subarray(0, end).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes && end > 0) {
    end -= 1;
    text = source.subarray(0, end).toString('utf8');
  }
  return { text, truncated: true };
}

function processOutcome(input: {
  status: ReviewedCliProcessOutcomeV1['status'];
  descriptor: ReviewedCliReadDescriptorV1;
  argv: readonly string[];
  error?: ExecFileException | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}): ReviewedCliProcessOutcomeV1 {
  const stdout = boundedOutput(input.stdout, input.descriptor.limits.maxStdoutBytes);
  const stderr = boundedOutput(input.stderr, input.descriptor.limits.maxStderrBytes);
  const maxBufferMessage = input.status === 'output_limit'
    ? String(input.error?.message ?? '')
    : '';
  return Object.freeze({
    version: 1,
    status: input.status,
    operationId: input.descriptor.operationId,
    executableRealpath: input.descriptor.executableRealpath,
    argv: Object.freeze([...input.argv]),
    exitCode: typeof input.error?.code === 'number'
      ? input.error.code
      : input.status === 'exited' ? 0 : null,
    signal: input.error?.signal ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated || /stdout maxBuffer/i.test(maxBufferMessage),
    stderrTruncated: stderr.truncated || /stderr maxBuffer/i.test(maxBufferMessage),
  });
}

function failureStatus(error: ExecFileException): ReviewedCliProcessOutcomeV1['status'] {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (error.killed) return 'timed_out';
  if (typeof error.code === 'number') return 'nonzero_exit';
  return 'spawn_failed';
}

/** Execute one exact reviewed descriptor with structured argv and no shell. */
export async function executeReviewedCliRead(
  call: AttestedTransportCall,
): Promise<ReviewedCliProcessOutcomeV1> {
  let descriptor: ReviewedCliReadDescriptorV1 | null;
  try {
    descriptor = currentDescriptorForOperation(call.operationId);
  } catch {
    descriptor = null;
  }
  if (!descriptor) throw new Error('reviewed CLI descriptor is absent, ambiguous, or stale');
  const current = currentTransportIdentity(descriptor);
  if (!exactExpectedIdentity(call, current)) {
    throw new Error('reviewed CLI execution identity changed before dispatch');
  }
  const argv = compileReviewedCliArgv(descriptor, call.args);
  if (!argv) throw new Error('reviewed CLI arguments exceed the closed structured-argv schema');
  const before = observeReviewedCliExecutable(descriptor.executableRealpath);
  if (!before || before.binarySha256 !== descriptor.binarySha256) {
    throw new Error('reviewed CLI executable changed before dispatch');
  }

  const outcome = await new Promise<ReviewedCliProcessOutcomeV1>((resolve, reject) => {
    execFile(
      descriptor!.executableRealpath,
      [...argv],
      {
        encoding: 'utf8',
        timeout: descriptor!.limits.timeoutMs,
        maxBuffer: Math.max(
          descriptor!.limits.maxStdoutBytes,
          descriptor!.limits.maxStderrBytes,
        ),
        killSignal: 'SIGKILL',
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new ReviewedCliProcessError(processOutcome({
            status: failureStatus(error),
            descriptor: descriptor!,
            argv,
            error,
            stdout,
            stderr,
          })));
          return;
        }
        const success = processOutcome({
          status: 'exited',
          descriptor: descriptor!,
          argv,
          stdout,
          stderr,
        });
        if (success.stdoutTruncated || success.stderrTruncated) {
          reject(new ReviewedCliProcessError({ ...success, status: 'output_limit' }));
          return;
        }
        resolve(success);
      },
    );
  });

  let afterDescriptor: ReviewedCliReadDescriptorV1 | null = null;
  try {
    afterDescriptor = currentDescriptorForOperation(call.operationId);
  } catch {
    // fail closed below
  }
  if (
    !afterDescriptor
    || reviewedCliDescriptorDigest(afterDescriptor) !== reviewedCliDescriptorDigest(descriptor)
  ) {
    throw new ReviewedCliProcessError({ ...outcome, status: 'identity_changed' });
  }
  return outcome;
}
