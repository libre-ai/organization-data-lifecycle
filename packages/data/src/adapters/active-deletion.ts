import {
  buildCompletedDeletionReceipt,
  type DeletionReceipt,
  type DeletionStoreOutcome,
  InvalidStoreOutcomeError,
  isDeletionReasonCode,
} from "../deletion-receipt";
import type { BlobStorePort } from "./blob-store-port";
import { persistDeletionReceipt } from "./deletion-receipt-store";
import type { SqlExecutor } from "./executor";
import type { ProjectionCachePort } from "./projection-cache-port";
import { withTenantDbTransaction } from "./tenant-transaction";

/**
 * Explicit active deletion, end to end (DATA-LIFECYCLE explicit deletion,
 * steps 3-5). Order of operations and its rationale:
 *
 * 1. Cache projections are purged FIRST, with bounded retry. Projections are
 *    disposable and never authoritative, so purging before the SQL command
 *    cannot lose state; a persistent cache failure aborts the whole command
 *    while nothing has been mutated (fail closed, retryable). A cache
 *    failure can never restore access: rows only disappear afterwards.
 * 2. One tenant transaction then deletes the active rows, enqueues only
 *    content-addressed blob deletion, and persists the receipt — atomically.
 *    The receipt's store outcomes reflect what actually happened.
 *
 * Scope boundary (DATA-LIFECYCLE explicit-deletion steps 1-2, authorization
 * and legal-hold refusal): those steps are an AUTHORIZATION precondition, not
 * a data-platform responsibility. Authorizing the actor/tenant/scope/revision
 * and refusing before any mutation on a legal hold belongs to the auth and
 * orchestration layers (Biscuit-verified capability, K2 authoritative source
 * of tenantId) that call this function; reaching this code means that gate
 * already passed. This module enforces the mechanical guarantees of steps
 * 3-5 only. Wiring the refusal path is deferred to those layers, not silently
 * dropped (K4 migration-and-deletion-review finding M-09).
 */
export class CachePurgeFailedError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(
      `projection-cache purge failed after ${attempts} attempts — deletion aborted, retry later`,
      {
        cause,
      },
    );
    this.name = "CachePurgeFailedError";
  }
}

const CACHE_PURGE_ATTEMPTS = 3;

export interface ActiveDeletionRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly subjectDigests: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  /** Product-owned: delete the active rows of the subjects inside the tenant transaction. */
  readonly deleteActiveRows: (tx: SqlExecutor) => Promise<void>;
  /**
   * Optional qualifier on the postgresql `deleted` outcome, for owners whose
   * authority store is append-only: the accepted transaction removes logical
   * access and the receipt says so (DATA-LIFECYCLE §Explicit deletion item 6,
   * "physical compaction may follow"), e.g. `deletion.deferred-compaction`.
   * Validated against the receipt contract's reason-code pattern.
   */
  readonly postgresqlReasonCode?: string;
}

export async function executeActiveDeletion(
  executor: SqlExecutor,
  cache: ProjectionCachePort,
  blobs: BlobStorePort,
  request: ActiveDeletionRequest,
): Promise<DeletionReceipt> {
  // Fail closed BEFORE any mutation: the blob enqueue below is an external
  // effect no SQL rollback can undo, so a receipt the builder would refuse
  // must be refused here first. Never echo the offending value (PII risk).
  if (
    request.postgresqlReasonCode !== undefined &&
    !isDeletionReasonCode(request.postgresqlReasonCode)
  ) {
    throw new InvalidStoreOutcomeError(
      `malformed postgresql reason code (a ${request.postgresqlReasonCode.length}-char value)`,
    );
  }
  let lastFailure: unknown;
  let purged = false;
  for (let attempt = 1; attempt <= CACHE_PURGE_ATTEMPTS; attempt += 1) {
    try {
      await cache.purgeTenantProjections(request.tenantId);
      purged = true;
      break;
    } catch (error) {
      lastFailure = error;
    }
  }
  if (!purged) {
    throw new CachePurgeFailedError(CACHE_PURGE_ATTEMPTS, lastFailure);
  }

  return withTenantDbTransaction(executor, request.tenantId, async (tx) => {
    await request.deleteActiveRows(tx);
    const enqueued = await blobs.enqueueContentAddressedDeletion(request.subjectDigests);
    const cellarOutcome: DeletionStoreOutcome =
      enqueued.length > 0
        ? { store: "cellar", outcome: "deleted" }
        : { store: "cellar", outcome: "not-applicable", reasonCode: "deletion.no-blobs" };
    const receipt = buildCompletedDeletionReceipt({
      id: request.id,
      tenantId: request.tenantId,
      owner: request.owner,
      subjectDigests: request.subjectDigests,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt,
      completedAt: request.completedAt,
      stores: [
        request.postgresqlReasonCode === undefined
          ? { store: "postgresql", outcome: "deleted" }
          : {
              store: "postgresql",
              outcome: "deleted",
              reasonCode: request.postgresqlReasonCode,
            },
        { store: "redis", outcome: "deleted" },
        cellarOutcome,
      ],
    });
    await persistDeletionReceipt(tx, receipt);
    return receipt;
  });
}
