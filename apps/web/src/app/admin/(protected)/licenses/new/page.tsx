import Link from "next/link";
import { describeApiError, listTenants } from "@/lib/admin/license-api";
import type { Tenant } from "@/lib/admin/types";
import { NewLicenseForm } from "@/components/admin/NewLicenseForm";
import { ApiErrorCard, btnGhost, Card, Notice, PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function NewLicensePage() {
  let tenants: Tenant[] = [];
  let error: string | null = null;
  try {
    const data = await listTenants();
    tenants = data.tenants ?? [];
  } catch (err) {
    error = describeApiError(err);
  }

  const hasProduct = tenants.some((t) => (t.products ?? []).length > 0);

  return (
    <>
      <PageHeader
        eyebrow="Licenses"
        title="Generate a key"
        intro="The key is returned once, in the response to this form. It is stored only as a hash, so it cannot be looked up or resent later."
        actions={
          <Link href="/admin" className={btnGhost}>
            Back to licenses
          </Link>
        }
      />

      {error ? (
        <ApiErrorCard message={error} />
      ) : !hasProduct ? (
        <Card className="p-6">
          <Notice tone="warn" title="No product to issue against">
            A license belongs to a tenant and a product. Create one on the{" "}
            <Link href="/admin/enforcement" className="underline underline-offset-4">
              Enforcement
            </Link>{" "}
            page first.
          </Notice>
        </Card>
      ) : (
        <NewLicenseForm tenants={tenants} />
      )}
    </>
  );
}
