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
import { useEffect, useState } from 'preact/hooks';
import { inNativeShell, requestNativeRepair } from '../lib/native-bridge';

interface Props {
  pairError?: string | null;
  onRetryPair?: () => void;
  retryAt?: number | null;
}

export function Login({ pairError, onRetryPair, retryAt }: Props) {
  const [repairUnavailable, setRepairUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!retryAt || retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const tick = Date.now(); setNow(tick);
      if (tick >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const waitSeconds = Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1000));
  const showRepair = inNativeShell() && !repairUnavailable;
  return (
    <div class="login-shell">
      <img class="login-mark" src="/m/clemmy.png" alt="" width="88" height="88" />
      <h1>Pair with your computer</h1>
      <p>
        Open Clementine on your computer, open <strong>Apps &amp; devices</strong>, then find <strong>Pair your phone</strong>.
        Scan the QR code to bring your conversations and work with you.
      </p>
      <ol class="login-steps"><li>Keep Clem open on your computer.</li><li>Connect both devices to the same Wi-Fi.</li><li>Scan the pairing code and allow Local Network access if asked.</li></ol>
      {pairError ? <div class="global-error">{pairError}</div> : null}
      {onRetryPair ? <button class="login-repair" type="button" disabled={waitSeconds > 0} onClick={onRetryPair}>
        {waitSeconds > 0 ? `Try again in ${waitSeconds >= 60 ? `${Math.ceil(waitSeconds / 60)} min` : `${waitSeconds}s`}` : 'Try pairing again'}
      </button> : null}
      {showRepair ? (
        // The shell holds a pairing, so it will never show its scanner on its
        // own — this button asks it to clear the pairing and open the camera.
        // Without it, this screen says "scan" with no scanner anywhere (the
        // only escape was an undiscoverable shake gesture).
        <button
          class="login-repair"
          onClick={() => {
            if (!requestNativeRepair()) setRepairUnavailable(true);
          }}
        >
          Scan a new QR code
        </button>
      ) : null}
      {repairUnavailable ? (
        <p class="login-fineprint">
          Shake your phone and choose “Unpair” to open the scanner.
        </p>
      ) : null}
      <p class="login-fineprint">
        Pair once on your own network. Your phone then uses its device security to keep Clem private.
      </p>
    </div>
  );
}
