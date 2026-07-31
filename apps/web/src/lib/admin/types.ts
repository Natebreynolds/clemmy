/** Shapes returned by the license server's /v1/admin endpoints. */

export type LicenseStatus = "active" | "suspended" | "revoked";
export type ActivationStatus = "active" | "released" | "blocked";

export type Product = {
  id: number;
  slug: string;
  displayName: string;
  enforce: boolean;
  /** Present on PATCH /products/:id responses, which return the raw row. */
  lease_ttl_seconds?: number;
  grace_seconds?: number;
  display_name?: string;
};

export type Tenant = {
  id: number;
  slug: string;
  name: string;
  /** null when the tenant has no products yet (json_agg over an empty set). */
  products: Product[] | null;
};

export type LicenseRow = {
  id: number;
  key_prefix: string;
  key_last4: string;
  plan: string;
  seat_limit: number;
  seats_used: number;
  status: LicenseStatus;
  customer_email: string | null;
  note: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  tenant: string;
  product: string;
  last_seen_at: string | null;
};

/** GET /licenses/:id returns the full row (minus key_hash), not the list shape. */
export type LicenseDetail = {
  id: number;
  tenant_id: number;
  product_id: number;
  key_prefix: string;
  key_last4: string;
  plan: string;
  features: unknown;
  seat_limit: number;
  status: LicenseStatus;
  expires_at: string | null;
  customer_email: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  tenant: string;
  product: string;
};

export type Activation = {
  id: number;
  pair_id: string | null;
  app_version: string | null;
  os: string | null;
  arch: string | null;
  status: ActivationStatus;
  first_seen_at: string;
  last_seen_at: string;
  blocked_reason: string | null;
};

export type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  meta: Record<string, unknown> | null;
};
