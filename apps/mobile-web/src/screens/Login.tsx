import { useEffect, useRef, useState } from 'preact/hooks';
import { login } from '../lib/api';

interface Props {
  pinConfigured: boolean;
  pairError?: string | null;
  onAuthenticated: () => void;
}

export function Login({ pinConfigured, pairError, onAuthenticated }: Props) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedSeconds, setLockedSeconds] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (lockedSeconds <= 0) return;
    const t = setTimeout(() => setLockedSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [lockedSeconds]);

  if (!pinConfigured) {
    return (
      <div class="login-shell">
        <h1>Clementine</h1>
        <p class="notice">Open the desktop app → Mobile and scan the pairing QR code. A PIN can be added there as a manual fallback.</p>
      </div>
    );
  }

  async function submit(ev: Event) {
    ev.preventDefault();
    if (busy || lockedSeconds > 0) return;
    setError(null);
    setBusy(true);
    try {
      await login(pin, navigator.userAgent.slice(0, 80));
      onAuthenticated();
    } catch (err) {
      const e = err as { status?: number; body?: unknown; message?: string };
      if (e.status === 429) {
        const body = e.body as { retryAfterMs?: number } | null;
        const seconds = Math.ceil((body?.retryAfterMs ?? 30 * 60 * 1000) / 1000);
        setLockedSeconds(seconds);
        setError(`Locked out. Try again in ${Math.ceil(seconds / 60)} min.`);
      } else if (e.status === 401) {
        setError('Wrong PIN.');
      } else if (e.status === 409) {
        setError('No PIN configured. Set one in the desktop app first.');
      } else {
        setError(e.message ?? 'Login failed.');
      }
      setPin('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="login-shell" onSubmit={submit}>
      <h1>Clementine</h1>
      <p>Scan the desktop QR code to pair automatically, or enter your mobile PIN.</p>
      <input
        ref={inputRef}
        class="login-pin"
        type="password"
        autoComplete="current-password"
        maxLength={64}
        value={pin}
        onInput={(ev) => setPin((ev.currentTarget as HTMLInputElement).value)}
        disabled={busy || lockedSeconds > 0}
      />
      {pairError ? <div class="error">{pairError}</div> : null}
      {error ? <div class="error">{error}</div> : null}
      {lockedSeconds > 0 ? <div class="notice">Try again in {lockedSeconds}s</div> : null}
      <button
        class="btn"
        type="submit"
        disabled={busy || pin.length < 4 || lockedSeconds > 0}
      >
        {busy ? 'Checking…' : 'Unlock'}
      </button>
    </form>
  );
}
