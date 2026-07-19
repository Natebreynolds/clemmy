const RESERVED_DOMAIN = /^(?:example\.(?:com|net|org)|.*\.(?:example|invalid|localhost|test))$/i;

export interface LiveDomainInputOptions {
  envName: string;
  min?: number;
  max?: number;
  usage: string;
}

function isValidLiveDomain(value: string): boolean {
  if (value.length > 253 || value.endsWith('.') || RESERVED_DOMAIN.test(value)) return false;

  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels.at(-1) ?? '')) return false;

  return labels.every((label) => (
    label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

/** Read explicit bare-domain inputs for scripts that call live external tools. */
export function readLiveDomains(options: LiveDomainInputOptions): string[] {
  const cliValues = process.argv.slice(2);
  const envValue = process.env[options.envName]?.trim() ?? '';
  if (cliValues.length > 0 && envValue) {
    throw new Error(`Use positional domains or ${options.envName}, not both.\n${options.usage}`);
  }

  const rawValues = cliValues.length > 0
    ? cliValues
    : envValue.split(',').map((value) => value.trim()).filter(Boolean);
  const min = options.min ?? 1;
  const max = options.max ?? 20;
  if (rawValues.length < min || rawValues.length > max) {
    throw new Error(`Expected ${min === max ? min : `${min}-${max}`} explicit domain input(s).\n${options.usage}`);
  }

  const domains = rawValues.map((value, index) => {
    const normalized = value.toLowerCase();
    if (!isValidLiveDomain(normalized)) {
      throw new Error(`Invalid live domain at position ${index + 1}; use a bare, non-reserved hostname.\n${options.usage}`);
    }
    return normalized;
  });

  const uniqueDomains = [...new Set(domains)];
  if (uniqueDomains.length < min) {
    throw new Error(`Expected at least ${min} unique domain input(s).\n${options.usage}`);
  }
  return uniqueDomains;
}
