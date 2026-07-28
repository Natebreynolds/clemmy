/**
 * Provider-specific diagnostics behind a provider-neutral seam.
 *
 * Core shell execution cannot know whether any non-zero CLI process committed
 * remotely. Adapters may classify a useful recovery reason, but their
 * provider-controlled stdout/stderr can never narrow dispatch or effect.
 */
import type {
  ShellDispatchState,
  ShellEffectState,
  ShellExecutionErrorKind,
  ShellExecutionPhase,
} from './shell-execution-outcome.js';

export interface ShellProviderFailureInput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ShellProviderFailureEvidence {
  phase: ShellExecutionPhase;
  dispatch: ShellDispatchState;
  effect: ShellEffectState;
  errorKind: ShellExecutionErrorKind;
  adapterId: string;
}

export interface ShellProviderOutcomeAdapter {
  id: string;
  classifyFailure(input: ShellProviderFailureInput): ShellProviderFailureEvidence | null;
}

// Match Netlify only when it occupies the executable position of a shell
// segment. `local_cli_probe` deliberately returns an absolute path and the
// recovery hint tells the model to invoke that path directly, so the adapter
// must recognize both `netlify ...` and `/.../bin/netlify ...`. Incidental
// argument/file mentions remain non-causal and do not match.
const NETLIFY_COMMAND_RE = /(?:^|[;&|\n])\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:(?:[^\s;&|"'`]+\/)?netlify(?:-cli)?|npx(?:\s+(?:--yes|-y))?\s+(?:@netlify\/cli|netlify-cli))(?:\s|$)/i;
const NETLIFY_CREATE_RE = /\b(?:sites?:create|site:create|api\s+createsite)\b/i;
const NETLIFY_EXPLICIT_ACCOUNT_RE = /(?:--(?:account-slug|account|team)(?:=|\s+)|["']account_slug["']\s*:)/i;
const NETLIFY_ACCOUNT_REJECTION_RE = /(?:createsiteinteam[^\n]*\b404\b|\b(?:no such|unknown|invalid)\s+(?:team|account(?:[_ -]?slug)?)\b|\b(?:team|account(?:[_ -]?slug)?)\s+(?:not found|does not exist|is invalid)\b)/i;

const netlifyAccountPreconditionAdapter: ShellProviderOutcomeAdapter = {
  id: 'netlify.account_precondition',
  classifyFailure(input) {
    if (!NETLIFY_COMMAND_RE.test(input.command)) return null;
    if (!NETLIFY_CREATE_RE.test(input.command)) return null;
    if (!NETLIFY_EXPLICIT_ACCOUNT_RE.test(input.command)) return null;
    if (!NETLIFY_ACCOUNT_REJECTION_RE.test(`${input.stdout}\n${input.stderr}`)) return null;
    return {
      phase: 'provider_execution',
      // Diagnostic only. A provider process existed, so even a familiar
      // account-rejection transcript cannot prove that no create landed.
      dispatch: 'unknown',
      effect: 'possible',
      errorKind: 'provider_precondition_rejected',
      adapterId: 'netlify.account_precondition',
    };
  },
};

const adapters: ShellProviderOutcomeAdapter[] = [netlifyAccountPreconditionAdapter];

export function classifyShellProviderFailure(input: ShellProviderFailureInput): ShellProviderFailureEvidence | null {
  for (const adapter of adapters) {
    try {
      const evidence = adapter.classifyFailure(input);
      if (evidence) {
        // Adapters consume provider-controlled output and are therefore
        // diagnostic only. Normalize even third-party/test adapters at this
        // trust boundary so none can forge retry-safe no-dispatch evidence.
        return {
          phase: 'provider_execution',
          dispatch: 'unknown',
          effect: 'possible',
          errorKind: evidence.errorKind,
          adapterId: adapter.id,
        };
      }
    } catch {
      // Adapter failure leaves the generic unknown/possible result intact.
    }
  }
  return null;
}

/** Test seam and future plugin hook; adapters append after built-ins. */
export function registerShellProviderOutcomeAdapter(adapter: ShellProviderOutcomeAdapter): () => void {
  adapters.push(adapter);
  return () => {
    const index = adapters.indexOf(adapter);
    if (index >= 0) adapters.splice(index, 1);
  };
}
