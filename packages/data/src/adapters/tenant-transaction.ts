import { runInTenantContext } from "../tenant-context";
import { assertTenantContextId } from "../tenant-id";
import type { SqlExecutor } from "./executor";

/**
 * The bridge between the two enforcement layers (WP-G2-D01): one call
 * establishes the application context (AsyncLocalStorage) AND the database
 * context (SET LOCAL ROLE + transaction-local app.tenant_id) so they cannot
 * drift apart. Both are transaction-local: COMMIT/ROLLBACK ends the database
 * scope, the promise boundary ends the application scope.
 *
 * The role drop is deliberate: RLS never applies to superusers, so every
 * adapter query must run as the NOLOGIN application role for the barrier to
 * be real (DATA-LIFECYCLE: "RLS uses transaction-local tenant context").
 */
export async function withTenantDbTransaction<T>(
  executor: SqlExecutor,
  tenantId: string,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  assertTenantContextId(tenantId);
  await executor.exec("BEGIN");
  try {
    await executor.exec("SET LOCAL ROLE libre_ai_app");
    await executor.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await runInTenantContext(tenantId, () => fn(executor));
    await executor.exec("COMMIT");
    return result;
  } catch (error) {
    await executor.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Pool-clearing semantics (DATA-LIFECYCLE: "connection pools clear context
 * before reuse"): a pool must issue this on every checkout return so that a
 * session-level GUC planted outside SET LOCAL cannot leak tenant scope into
 * the next borrower. DISCARD ALL also resets roles, plans and temp state.
 */
export async function clearPooledSession(executor: SqlExecutor): Promise<void> {
  await executor.exec("DISCARD ALL");
}
