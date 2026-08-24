import { lookup as lookupHost, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent as UndiciAgent } from 'undici';

function ipv4Octets(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) =>
    Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function ipv6Words(address: string): readonly number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (normalized.includes('%') || isIP(normalized) !== 6) return null;
  const dottedIndex = normalized.lastIndexOf(':');
  if (normalized.includes('.') && dottedIndex >= 0) {
    const tail = ipv4Octets(normalized.slice(dottedIndex + 1));
    if (!tail) return null;
    normalized = `${normalized.slice(0, dottedIndex)}:${((tail[0]! << 8) | tail[1]!).toString(16)}`
      + `:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 2 && missing < 1) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map((word) => /^[a-f0-9]{1,4}$/.test(word) ? Number.parseInt(word, 16) : -1);
  return words.length === 8 && words.every((word) => word >= 0 && word <= 0xffff)
    ? words
    : null;
}

/** True only for an address fit for an arbitrary provider-owned HTTPS origin. */
export function isPublicHttpsOriginAddress(address: string): boolean {
  const ipv4 = ipv4Octets(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(
      a === 0
      || a === 10
      || (a === 100 && b! >= 64 && b! <= 127)
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a! >= 224
    );
  }
  const ipv6 = ipv6Words(address);
  if (!ipv6) return false;
  if (
    ipv6.every((word) => word === 0)
    || (ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1)
  ) return false;
  const first = ipv6[0]!;
  if (
    (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && ipv6[1] === 0x0db8)
  ) return false;
  const ipv4Mapped = ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff;
  const ipv4Compatible = ipv6.slice(0, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return isPublicHttpsOriginAddress(
      `${ipv6[6]! >> 8}.${ipv6[6]! & 0xff}.${ipv6[7]! >> 8}.${ipv6[7]! & 0xff}`,
    );
  }
  return true;
}

/** Reject the entire DNS observation if even one answer is non-public. This
 * prevents a mixed-answer attacker from influencing which address connects. */
export function selectPinnedPublicHttpsOriginAddress(
  addresses: readonly LookupAddress[],
): LookupAddress | null {
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicHttpsOriginAddress(address))) {
    return null;
  }
  return [...addresses].sort((left, right) =>
    left.family - right.family || left.address.localeCompare(right.address))[0] ?? null;
}

function normalizedPublicHostname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'localhost.localdomain'
    || hostname === 'ip6-localhost'
  ) return null;
  return isIP(hostname) === 0 || isPublicHttpsOriginAddress(hostname) ? hostname : null;
}

export interface PublicHttpsOriginTransport {
  readonly dispatcher: UndiciAgent;
  close(): Promise<void>;
}

/**
 * Build a connection-local transport for one exact HTTPS request. DNS is
 * resolved by the socket itself, every answer must be public, and the selected
 * address is passed directly to that same connection so it cannot rebind
 * between a separate check and connect. SNI and Host remain the original URL.
 */
export function createPublicHttpsOriginTransport(url: string): PublicHttpsOriginTransport | null {
  if (!normalizedPublicHostname(url)) return null;
  const lookup: LookupFunction = (hostname, _options, callback) => {
    lookupHost(hostname, { all: true, verbatim: true }, (
      error: NodeJS.ErrnoException | null,
      addresses: LookupAddress[],
    ) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const selected = selectPinnedPublicHttpsOriginAddress(addresses);
      if (!selected) {
        const denied = new Error('provider HTTPS origin did not resolve publicly') as NodeJS.ErrnoException;
        denied.code = 'ERR_STAGED_HTTPS_ORIGIN_NOT_PUBLIC';
        callback(denied, '', 0);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  };
  const dispatcher = new UndiciAgent({
    connect: { lookup },
    maxRedirections: 0,
    connections: 1,
    pipelining: 1,
  });
  return Object.freeze({
    dispatcher,
    async close(): Promise<void> {
      try {
        await dispatcher.close();
      } catch {
        try { dispatcher.destroy(); } catch { /* best effort after exact body outcome */ }
      }
    },
  });
}
