import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

export interface MobileRelayVerification {
  state: 'not-checked' | 'verified' | 'failed';
  checkedAt?: string;
  reason?: 'certificate-mismatch' | 'unreachable' | 'timeout' | 'invalid-response' | 'connection-changed';
}

/** Public liveness only: no cookies, pairing token, PIN, or device credential.
 * Verify the Mac's pin BEFORE sending HTTP. Registration alone cannot prove
 * that public DNS, the phone leg, and the Mac's ingress actually work.
 */
export async function probeMobileRelay(
  origin: string,
  fingerprint: string,
  timeoutMs = 5000,
): Promise<MobileRelayVerification> {
  const checkedAt = new Date().toISOString();
  const failed = (reason: MobileRelayVerification['reason']): MobileRelayVerification => ({ state: 'failed', checkedAt, reason });
  let url: URL;
  try {
    url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || !fingerprint) return failed('invalid-response');
  } catch { return failed('invalid-response'); }
  return new Promise((resolve) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: tlsHostname(url.hostname), rejectUnauthorized: false });
    const finish = (result: MobileRelayVerification): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      request?.destroy();
      socket.destroy();
    };
    const timer = setTimeout(() => finish(failed('timeout')), timeoutMs);
    socket.on('error', () => finish(failed('unreachable')));
    socket.once('secureConnect', () => {
      const der = socket.getPeerCertificate()?.raw;
      if (!der || createHash('sha256').update(der).digest('base64url') !== fingerprint) {
        finish(failed('certificate-mismatch'));
        return;
      }
      // HTTP uses the already authenticated TLS socket, never a new connection.
      request = http.request({ hostname: url.hostname, port: Number(url.port || 443), path: '/m/health', method: 'GET', createConnection: () => socket, headers: { Host: url.host, Connection: 'close' } }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2048) finish(failed('invalid-response'));
          else chunks.push(chunk);
        });
        response.on('error', () => finish(failed('unreachable')));
        response.on('aborted', () => finish(failed('unreachable')));
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(response.statusCode === 200 && body?.ok === true ? { state: 'verified', checkedAt } : failed('invalid-response'));
          } catch { finish(failed('invalid-response')); }
        });
      });
      request.on('error', () => finish(failed('unreachable')));
      request.end();
    });
  });
}

function tlsHostname(host: string): string | undefined {
  return isIP(host) ? undefined : host;
}
