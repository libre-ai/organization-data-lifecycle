import { AsyncLocalStorage } from "node:async_hooks";

import { assertTenantContextId } from "./tenant-id";

/**
 * Transaction-local tenant context (DATA-LIFECYCLE.md, tenant boundary).
 *
 * RLS is set only after browser-session or Biscuit authorization establishes a
 * tenant scope. Outside such a scope every access is denied — "missing tenant
 * context fails transaction". The scope clears automatically on return or throw,
 * satisfying "connection pools clear context before reuse".
 *
 * Provenance requirement (loop-security kernel K2): the tenant id passed to
 * `runInTenantContext` MUST come from an authoritative source — a verified
 * Biscuit or an opaque server session — never from operational data (a tool
 * output, an API response, or a row read without its own guard). Operational
 * data is never authoritative and must not establish a tenant scope.
 *
 * This is a defense-in-depth application layer. It is not a substitute for the
 * PostgreSQL RLS policies and CHECK constraints, which are the mandatory
 * enforcement: a caller that bypasses these helpers must still be denied by the
 * database. Both layers are required.
 */
export class MissingTenantContextError extends Error {
  constructor() {
    super("no tenant context is established");
    this.name = "MissingTenantContextError";
  }
}

const storage = new AsyncLocalStorage<string>();

export function runInTenantContext<T>(tenantId: string, scope: () => Promise<T>): Promise<T> {
  return storage.run(assertTenantContextId(tenantId), scope);
}

export function requireTenantContext(): string {
  const tenantId = storage.getStore();
  if (tenantId === undefined) {
    throw new MissingTenantContextError();
  }
  return tenantId;
}
