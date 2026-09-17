/**
 * Tenant identifier format (DATA-LIFECYCLE.md tenant boundary;
 * contracts/schemas/common.v1.schema.json `tenantId` / `serviceTenantId`).
 *
 * A private tenant id is `^ten_[a-z0-9]{16,64}$`. The publication `public`
 * service tenant is a distinct value, valid only where a service tenant is
 * allowed (never on a private row). Validating the format at context
 * establishment rejects a malformed id from an untrusted path before it can
 * scope any access.
 */
export const PUBLIC_SERVICE_TENANT = "public";

const PRIVATE_TENANT_ID = /^ten_[a-z0-9]{16,64}$/;

export class MalformedTenantIdError extends Error {
  constructor(value: string) {
    super(
      `tenant id ${JSON.stringify(value)} is neither a valid private tenant nor the public service tenant`,
    );
    this.name = "MalformedTenantIdError";
  }
}

export function isPrivateTenantId(value: string): boolean {
  return PRIVATE_TENANT_ID.test(value);
}

export function assertTenantContextId(value: string): string {
  if (value === PUBLIC_SERVICE_TENANT || isPrivateTenantId(value)) {
    return value;
  }
  throw new MalformedTenantIdError(value);
}
