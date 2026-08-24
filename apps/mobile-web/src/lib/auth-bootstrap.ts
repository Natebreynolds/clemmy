/**
 * Exactly one request owns mobile authentication during page boot.
 *
 * A pairing/adoption URL replaces the browser cookie. Starting the ordinary
 * `/auth/status` probe at the same time can therefore observe the old cookie,
 * then finish after the credential request and put the old session fingerprint
 * back into memory. The next device proof is signed for the wrong session and
 * the otherwise-successful pairing lands on a login screen.
 */
export type AuthBootstrapMode = 'pair' | 'adopt' | 'status';

export function authBootstrapMode(search: string): AuthBootstrapMode {
  const params = new URLSearchParams(search);
  // A QR is the strongest, explicit ceremony. It wins if a malformed caller
  // ever supplies both credential parameters; the two requests must not race.
  if (params.get('pair')) return 'pair';
  if (params.get('adopt')) return 'adopt';
  return 'status';
}
