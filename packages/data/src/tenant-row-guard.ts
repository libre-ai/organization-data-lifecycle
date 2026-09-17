import { requireTenantContext } from "./tenant-context";
import { PUBLIC_SERVICE_TENANT } from "./tenant-id";

/**
 * Row-level tenant ownership guard (DATA-LIFECYCLE.md, invariant 3 and the
 * tenant boundary). Every private row carries a non-null `tenant_id`; access is
 * allowed only under the matching transaction-local tenant context. The `public`
 * service tenant is never a private tenant and is rejected on private rows.
 */

export class CrossTenantAccessError extends Error {
  constructor(rowTenant: string, contextTenant: string) {
    super(`row tenant ${JSON.stringify(rowTenant)} is not the context tenant`);
    this.name = "CrossTenantAccessError";
    this.rowTenant = rowTenant;
    this.contextTenant = contextTenant;
  }
  readonly rowTenant: string;
  readonly contextTenant: string;
}

export class PublicTenantRejectedError extends Error {
  constructor() {
    super("the public service tenant cannot own a private row");
    this.name = "PublicTenantRejectedError";
  }
}

export interface TenantOwned {
  readonly tenant_id: string;
}

export function guardTenantRow<T extends TenantOwned>(row: T): T {
  const contextTenant = requireTenantContext();
  if (contextTenant === PUBLIC_SERVICE_TENANT || row.tenant_id === PUBLIC_SERVICE_TENANT) {
    throw new PublicTenantRejectedError();
  }
  if (row.tenant_id === "" || row.tenant_id !== contextTenant) {
    throw new CrossTenantAccessError(row.tenant_id, contextTenant);
  }
  return row;
}
