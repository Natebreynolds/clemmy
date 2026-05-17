import type { InputGuardrail, OutputGuardrail } from '@openai/agents';
import { checkCapability, listKnownCapabilities } from '../../agents/capabilities.js';
import {
  getProactivityPolicySnapshot,
  loadProactivityPolicy,
} from '../../agents/proactivity-policy.js';

/**
 * Harness-wide guardrail registry.
 *
 * These attach via the SDK's `inputGuardrails:` / `outputGuardrails:`
 * slots on each `Agent` constructor — the SDK enforces them; we don't
 * run a parallel dispatcher.
 *
 * Input guardrails run BEFORE any tokens are spent (documented
 * contract). They are the cheapest place to refuse.
 *
 * Output guardrails run AFTER final output. A tripped output
 * guardrail halts the run; the harness loop catches the
 * GuardrailExecutionError, emits `guardrail_tripped`, and decides
 * whether to retry, redact, or fail.
 *
 * Schema-specific guardrails (like the AgentDecisionSchema ones in
 * src/agents/autonomy-guardrails.ts) stay attached to the agents
 * they validate. This registry is for harness-wide checks that apply
 * to every Orchestrator / sub-agent run.
 */

// ---------- input text extraction ----------

interface InputTextItem {
  role?: string;
  content?: unknown;
}

interface InputContentPart {
  type?: string;
  text?: unknown;
}

/** Pull a single string out of an InputGuardrail's `input` arg. */
export function extractInputText(input: string | readonly unknown[]): string {
  if (typeof input === 'string') return input;
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const it = item as InputTextItem;
    if (typeof it.content === 'string') {
      parts.push(it.content);
      continue;
    }
    if (Array.isArray(it.content)) {
      for (const c of it.content) {
        if (!c || typeof c !== 'object') continue;
        const cc = c as InputContentPart;
        if ((cc.type === 'input_text' || cc.type === 'output_text') && typeof cc.text === 'string') {
          parts.push(cc.text);
        }
      }
    }
  }
  return parts.join('\n');
}

// ---------- policy_violation ----------

/**
 * Refuses input that contradicts a user-set policy flag. Today the
 * flags we check are coarse — `allowComposioActions` and
 * `allowComputerActions`. We trigger only when the input looks like
 * a clear request for the disabled action class; a fuzzy mention
 * passes through and is dealt with at tool-approval time.
 */
const COMPOSIO_ACTION_WORDS = /\b(send|post|email|dm|message|reply|invite|publish|notify)\b/i;
const COMPUTER_ACTION_WORDS =
  /\b(click|type|screenshot|drag|move (?:the )?mouse|press|scroll|open (?:the )?browser)\b/i;

export const policyViolationGuardrail: InputGuardrail = {
  name: 'policy_violation',
  execute: async ({ input }) => {
    const policy = loadProactivityPolicy();
    const text = extractInputText(input);

    if (!policy.allowComposioActions && COMPOSIO_ACTION_WORDS.test(text)) {
      return {
        tripwireTriggered: true,
        outputInfo: {
          reason: 'composio_actions_disabled',
          message:
            'User policy has allowComposioActions=false but the request looks like a network-mutating action (send/post/email/...). Refused without tokens spent. Update policy or rephrase.',
          policy: getProactivityPolicySnapshot(),
        },
      };
    }

    if (!policy.allowComputerActions && COMPUTER_ACTION_WORDS.test(text)) {
      return {
        tripwireTriggered: true,
        outputInfo: {
          reason: 'computer_actions_disabled',
          message:
            'User policy has allowComputerActions=false but the request looks like a UI/computer action. Refused without tokens spent.',
          policy: getProactivityPolicySnapshot(),
        },
      };
    }

    return { tripwireTriggered: false, outputInfo: undefined };
  },
};

// ---------- missing_capability ----------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scans input for known CLI names from the capability registry, then
 * verifies each one is installed via `checkCapability` (cached). If
 * any are missing, refuses early so the agent doesn't burn tokens
 * planning around tools that can't actually run.
 */
export const missingCapabilityGuardrail: InputGuardrail = {
  name: 'missing_capability',
  execute: async ({ input }) => {
    const text = extractInputText(input);
    if (!text.trim()) return { tripwireTriggered: false, outputInfo: undefined };

    const known = listKnownCapabilities().map((c) => c.name);
    if (known.length === 0) return { tripwireTriggered: false, outputInfo: undefined };

    const pattern = new RegExp(`\\b(${known.map(escapeRegex).join('|')})\\b`, 'g');
    const mentions = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      mentions.add(match[1]);
    }
    if (mentions.size === 0) {
      return { tripwireTriggered: false, outputInfo: undefined };
    }

    const checks = await Promise.all(
      [...mentions].map(async (name) => ({ name, result: await checkCapability(name) })),
    );
    const missing = checks.filter((c) => !c.result.available);
    if (missing.length === 0) {
      return { tripwireTriggered: false, outputInfo: undefined };
    }

    return {
      tripwireTriggered: true,
      outputInfo: {
        reason: 'missing_capabilities',
        message: `Refusing without tokens spent: input mentions ${missing
          .map((m) => `\`${m.name}\``)
          .join(
            ', ',
          )} but none are installed locally. Install them or rephrase the request.`,
        missing: missing.map((m) => ({ name: m.name, error: m.result.error })),
        mentions: [...mentions],
      },
    };
  },
};

// ---------- secret_leak ----------

interface SecretPattern {
  kind: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'openai_api_key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'anthropic_api_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github_pat', regex: /\bgh[ps]_[A-Za-z0-9]{30,}/g },
  { kind: 'slack_token', regex: /\bxox[bpars]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g },
];

export interface SecretMatch {
  kind: string;
  count: number;
  /** First 12 chars of the first match — enough to identify, not enough to leak. */
  preview: string;
}

export function scanSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    const matches = [...text.matchAll(regex)];
    if (matches.length === 0) continue;
    found.push({
      kind,
      count: matches.length,
      preview: `${matches[0][0].slice(0, 12)}…`,
    });
  }
  return found;
}

/** Stringify any agent output so secret regexes can scan it. */
function stringifyOutput(agentOutput: unknown): string {
  if (typeof agentOutput === 'string') return agentOutput;
  if (agentOutput === null || agentOutput === undefined) return '';
  try {
    return JSON.stringify(agentOutput);
  } catch {
    return String(agentOutput);
  }
}

export const secretLeakGuardrail: OutputGuardrail = {
  name: 'secret_leak',
  execute: async ({ agentOutput }) => {
    const text = stringifyOutput(agentOutput);
    const matches = scanSecrets(text);
    if (matches.length === 0) {
      return { tripwireTriggered: false, outputInfo: undefined };
    }
    return {
      tripwireTriggered: true,
      outputInfo: {
        reason: 'secret_leak',
        message: `Output contains ${matches.length} suspected secret(s); refusing. Kinds: ${matches
          .map((m) => m.kind)
          .join(', ')}.`,
        matches,
      },
    };
  },
};

// ---------- registries ----------

export const harnessInputGuardrails: InputGuardrail[] = [
  policyViolationGuardrail,
  missingCapabilityGuardrail,
];

// Typed as OutputGuardrail<any>[] so any agent (text-output or
// structured-output) can attach this registry directly. The secret
// scanner stringifies whatever it gets, so the underlying type is
// irrelevant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const harnessOutputGuardrails: OutputGuardrail<any>[] = [secretLeakGuardrail];
