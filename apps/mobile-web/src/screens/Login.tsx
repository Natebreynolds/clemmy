/**
 * Pairing is the only way in.
 *
 * There used to be a PIN box here as a second credential. It is gone on
 * purpose, and removing it made the system *safer*, not more convenient:
 *
 *   - A PIN is a password, and once the relay exists a password box is
 *     reachable from the whole internet. Deleting it deletes that entire
 *     brute-force surface rather than defending it.
 *   - Pairing is the stronger credential anyway: a single-use 256-bit token,
 *     scanned in person, on the local network, that establishes a device-bound
 *     key which signs every later request.
 *   - The phone is now gated by Face ID / Touch ID / device passcode, so
 *     asking for a second secret was making people prove themselves twice for
 *     no additional security.
 *
 * The cost, stated plainly: recovery requires being near the Mac. If a session
 * ends while travelling, you re-pair when you get home. That is the trade a
 * security-first product should make.
 */
interface Props {
  pairError?: string | null;
}

export function Login({ pairError }: Props) {
  return (
    <div class="login-shell">
      <img class="login-mark" src="/m/clemmy.png" alt="" width="88" height="88" />
      <h1>Pair with your Mac</h1>
      <p>
        Open Clementine on your Mac, go to <strong>Mobile</strong>, and scan the QR code
        from inside this app.
      </p>
      {pairError ? <div class="global-error">{pairError}</div> : null}
      <p class="login-fineprint">
        Pairing happens on your own network and never leaves it. After that, Face ID keeps
        this app locked to you.
      </p>
    </div>
  );
}
