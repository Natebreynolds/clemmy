"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, Card, Field, inputClass, Notice } from "@/components/admin/ui";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/admin-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, code }),
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;

      if (!res.ok) {
        setError(body?.message ?? "Sign-in failed.");
        setCode(""); // a rejected code is already burned; make room for the next one
        setBusy(false);
        return;
      }

      // replace(), not push(): the login URL should not sit in history behind
      // an authenticated page.
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" htmlFor="admin-email">
          <input
            id="admin-email"
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
          />
        </Field>

        <Field label="Password" htmlFor="admin-password">
          <input
            id="admin-password"
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Field label="Authenticator code" htmlFor="admin-code">
          <input
            id="admin-code"
            type="text"
            className={`${inputClass} admin-mono tracking-[0.35em]`}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            // inputMode + one-time-code so iOS offers the code straight from
            // the keyboard — this panel gets used from a phone.
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            required
          />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        <button type="submit" className={`${btnPrimary} w-full`} disabled={busy || code.length !== 6}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
