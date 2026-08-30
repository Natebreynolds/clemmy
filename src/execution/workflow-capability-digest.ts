import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Workflow plans require full 256-bit identities. Some live carriers retain a
 * historical 128-bit selector fingerprint alongside the full provider-schema
 * digest. Seal either representation into one full workflow identity without
 * pretending the short selector is itself a sha256 digest.
 */
export function workflowCapabilityDigest(value: string): string {
  if (SHA256.test(value)) return value;
  return createHash('sha256').update(JSON.stringify({
    domain: 'workflow-capability-fingerprint',
    version: 1,
    value,
  }), 'utf8').digest('hex');
}
