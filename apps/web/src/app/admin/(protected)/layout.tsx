import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/admin/session";
import { AdminNav } from "@/components/admin/AdminNav";

// Rendered per request: a cached shell would be a cached authorization check.
export const dynamic = "force-dynamic";

/**
 * The authorization boundary for the whole panel.
 *
 * Every authenticated page lives in this route group, so the check happens on
 * the server before any of them render. /admin/login sits outside the group
 * and is therefore not wrapped — no redirect loop, and no page can opt out of
 * the guard by forgetting to call something.
 */
export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/admin/login");

  return (
    <div className="min-h-screen">
      <AdminNav email={session.email} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">{children}</main>
    </div>
  );
}
