import { runInTenantContext } from "../tenant-context";
import { assertTenantContextId } from "../tenant-id";
import type { SqlExecutor } from "./executor";

/**
 * The retention barrier (retention execution + physical compaction design,
 * 2026-07-24; role model Option A). Twin of `withTenantDbTransaction`
 * (tenant-transaction.ts) with ONE difference: it drops to `libre_ai_retention`
 * instead of `libre_ai_app`, so a transaction under this barrier runs with the
 * retention role's grants — only what owner-declared per-product compaction
 * migrations granted it (e.g. Sessions' SELECT, DELETE on `session_events`) —
 * rather than the application floor. Everything else is identical: BEGIN, drop
 * role, set the transaction-local `app.tenant_id`, run inside the
 * AsyncLocalStorage scope, COMMIT/ROLLBACK. Both contexts are
 * transaction-local: SET LOCAL ROLE and the GUC end at COMMIT/ROLLBACK, the
 * application scope ends at the promise boundary.
 *
 * INVARIANT — this is THE ONLY in-repo assumption point of the retention role
 * (design §3 Option A, "discipline, code-reviewed"): every retention deletion
 * passes through here, and nowhere else in the repo issues
 * `SET LOCAL ROLE libre_ai_retention`. The separation from the app role is
 * honest, not a SQL impossibility — SET ROLE is evaluated against the session
 * user (in PGlite the session is superuser; on the deployed database — none
 * exists until G4 — the connecting owner is a member of the role). The structural guarantees are the role's grants,
 * the `pg_roles` probe (NOLOGIN/NOSUPERUSER/NOBYPASSRLS), FORCE RLS (policies
 * bind this role too), and — at G4 — the Biscuit attenuated token. Keep this
 * the single greppable seam.
 */
export async function withTenantRetentionTransaction<T>(
  executor: SqlExecutor,
  tenantId: string,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  assertTenantContextId(tenantId);
  await executor.exec("BEGIN");
  try {
    await executor.exec("SET LOCAL ROLE libre_ai_retention");
    await executor.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await runInTenantContext(tenantId, () => fn(executor));
    await executor.exec("COMMIT");
    return result;
  } catch (error) {
    await executor.exec("ROLLBACK");
    throw error;
  }
}
