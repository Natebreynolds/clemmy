"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "@/lib/cx";

const LINKS = [
  { href: "/admin", label: "Licenses" },
  { href: "/admin/enforcement", label: "Enforcement" },
  { href: "/admin/audit", label: "Audit" },
];

export function AdminNav({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/admin-auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--rule)] bg-[var(--bg)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/admin" className="flex shrink-0 items-center gap-2.5">
          <Image src="/logo.png" alt="" width={26} height={26} className="rounded-md" />
          <span className="hidden text-[15px] font-semibold tracking-tight text-[var(--ink-strong)] sm:inline">
            Licensing
          </span>
        </Link>

        {/* Scrollable rather than collapsed into a menu — three links fit on a
            phone, and a hamburger would cost a tap on every navigation. */}
        <nav className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
          {LINKS.map((link) => {
            const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-[14px] tracking-tight transition-colors",
                  active
                    ? "bg-clem-500/12 text-clem-800 ring-1 ring-clem-600/25"
                    : "text-[var(--ink-dim)] hover:bg-black/[0.04] hover:text-[var(--ink-strong)]",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden max-w-[16ch] truncate text-[13px] text-[var(--ink-faint)] lg:inline">{email}</span>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="rounded-full px-3 py-1.5 text-[13px] text-[var(--ink-dim)] ring-1 ring-black/10 transition-colors hover:bg-white hover:text-[var(--ink-strong)] disabled:opacity-60"
          >
            {signingOut ? "…" : "Sign out"}
          </button>
        </div>
      </div>
    </header>
  );
}
