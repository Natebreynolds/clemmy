import { redirect } from "next/navigation";
import Image from "next/image";
import { getCurrentSession } from "@/lib/admin/session";
import { LoginForm } from "@/components/admin/LoginForm";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  // Sitting on the login form with a live session is just friction.
  if (await getCurrentSession()) redirect("/admin");

  return (
    <main className="radial-glow flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Image src="/logo.png" alt="" width={48} height={48} className="rounded-xl" priority />
          <div className="mt-4 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">
            Licensing admin
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ink-strong)]">
            Sign in to continue
          </h1>
        </div>
        <LoginForm />
        <p className="mt-6 text-center text-[12px] leading-relaxed text-[var(--ink-faint)]">
          Password and authenticator code are both required. Sessions last 12 hours.
        </p>
      </div>
    </main>
  );
}
