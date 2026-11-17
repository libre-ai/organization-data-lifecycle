import { type AuditEvent, type AuditEventInput, buildAuditEvent } from "../audit-event";
import { MissingTenantContextError, requireTenantContext } from "../tenant-context";
import { assertTenantContextId } from "../tenant-id";
import type { SqlExecutor } from "./executor";
import { withTenantDbTransaction } from "./tenant-transaction";

/**
 * Append-only audit event store, in two deliberately separate modes.
 *
 * - `appendAuditEvent` is the evidential mode: it writes inside the tenant
 *   transaction of the operation it traces, and every failure propagates, so
 *   an operation never commits without its trace (same shape as the deletion
 *   receipt persisted by executeActiveDeletion).
 * - `recordAuditEventBestEffort` is the comfort mode: it owns its transaction
 *   and absorbs a storage failure, but never silently — the mandatory
 *   `onFailure` callback is how the caller counts and reports it. This package
 *   never writes to the console.
 *
 * The store only ever INSERTs; the grants refuse UPDATE, DELETE and TRUNCATE
 * to the application role. The table itself is defined by the migration and
 * nowhere else.
 */
export interface AuditStoreFailure {
  readonly action: string;
  readonly errorName: string;
}

/**
 * The comfort mode was called while a tenant context is active, i.e. from
 * inside an operation's tenant transaction. It is refused before any SQL: its
 * own BEGIN / SET LOCAL ROLE / COMMIT on a shared session would commit the
 * operation half-way, drop the session back to the owner role and run the
 * rest of the operation outside the row-security barrier.
 */
export class OpenTenantTransactionError extends Error {
  constructor() {
    super("the comfort audit mode cannot run inside an open tenant transaction");
    this.name = "OpenTenantTransactionError";
  }
}

function isTenantContextActive(): boolean {
  try {
    requireTenantContext();
    return true;
  } catch (error) {
    if (error instanceof MissingTenantContextError) {
      return false;
    }
    throw error;
  }
}

async function insertAuditEvent(tx: SqlExecutor, event: AuditEvent): Promise<void> {
  // The tenant always comes from the active context — the RLS WITH CHECK
  // policy would deny any drift anyway.
  const tenantId = requireTenantContext();
  await tx.query(
    `INSERT INTO audit_events (tenant_id, event_id, action, actor_id, actor_role, resource, outcome, severity, context, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId,
      event.id,
      event.action,
      event.actorId,
      event.actorRole ?? null,
      event.resource ?? null,
      event.outcome,
      event.severity,
      JSON.stringify(event.context),
      event.occurredAt,
    ],
  );
}

/**
 * Evidential mode. Call it inside a transaction opened by
 * `withTenantDbTransaction`, on that transaction's executor. Validation runs
 * before any SQL; a validation error, a missing tenant context or a database
 * refusal all reach the caller, which rolls the whole operation back.
 */
export async function appendAuditEvent(
  tx: SqlExecutor,
  input: AuditEventInput,
): Promise<AuditEvent> {
  const event = buildAuditEvent(input);
  await insertAuditEvent(tx, event);
  return event;
}

/**
 * Comfort mode. Call it outside any open transaction: it opens its own tenant
 * transaction on `executor`. An invalid event, a malformed tenant id or an
 * active tenant context (`OpenTenantTransactionError`) is a caller error and
 * throws before any SQL. The guard reads the application context only: a
 * transaction opened by hand, without `withTenantDbTransaction`, is not seen. A storage failure does not reach
 * the caller: `onFailure` is called exactly once with the action and the
 * error's name (never its message, which a driver may fill with row values),
 * and the validated event is returned. An `onFailure` that throws is absorbed
 * too — reporting a lost trace must not break what the trace was about.
 */
export async function recordAuditEventBestEffort(
  executor: SqlExecutor,
  tenantId: string,
  input: AuditEventInput,
  onFailure: (failure: AuditStoreFailure) => void,
): Promise<AuditEvent> {
  const event = buildAuditEvent(input);
  assertTenantContextId(tenantId);
  if (isTenantContextActive()) {
    throw new OpenTenantTransactionError();
  }
  try {
    await withTenantDbTransaction(executor, tenantId, (tx) => insertAuditEvent(tx, event));
  } catch (error) {
    const failure: AuditStoreFailure = {
      action: event.action,
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
    try {
      // An async callback is accepted by the `void` signature: its rejection
      // is absorbed as well, instead of surfacing as an unhandled rejection.
      const reported: unknown = onFailure(failure);
      Promise.resolve(reported).catch(() => undefined);
    } catch {
      // Absorbed on purpose: see the function comment.
    }
  }
  return event;
}
