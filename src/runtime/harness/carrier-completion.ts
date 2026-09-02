/**
 * Provider-neutral carrier completion seam.
 *
 * The host kernel may complete a structurally wrong tool carrier from facts it
 * already holds (the one operation proven this turn, the argument wrapper, one
 * serialization). WHICH carriers and HOW is a provider concern: each provider
 * module registers its completer with the leaf registry, and the kernel asks
 * this seam without naming any provider. The list of providers lives in
 * exactly one non-kernel place — the import block at the bottom of this file.
 */
export {
  completeCarrierArguments,
  registerCarrierCompleter,
  type CarrierCompleter,
  type CarrierCompletion,
  type ProvenCompletionEntry,
} from './carrier-completion-registry.js';

// Provider registrations (side-effect imports). Add a provider here, never in
// the kernel.
import './composio-carrier-completion.js';
