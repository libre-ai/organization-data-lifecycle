import type { DeletionReceipt } from "../deletion-receipt";
import type { DeletionReceiptLike } from "../restore-replay";
import type { SqlExecutor } from "./executor";

/**
 * Append-only deletion-receipt evidence store. Receipts are persisted exactly
 * as built by buildCompletedDeletionReceipt (already contract-validated);
 * the grants make rewriting or erasing them impossible for the application
 * role, and the 35-day backup ceiling is re-checked structurally by the
 * table constraint.
 */
interface DeletionReceiptRow {
  readonly receipt: DeletionReceipt;
}

export async function persistDeletionReceipt(
  executor: SqlExecutor,
  receipt: DeletionReceipt,
): Promise<void> {
  await executor.query(
    `INSERT INTO deletion_receipts (tenant_id, receipt_id, receipt, completed_at, backup_expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      receipt.tenantId,
      receipt.id,
      JSON.stringify(receipt),
      receipt.completedAt,
      receipt.backupExpiresAt,
    ],
  );
}

export async function getDeletionReceipt(
  executor: SqlExecutor,
  receiptId: string,
): Promise<DeletionReceipt | null> {
  const res = await executor.query<DeletionReceiptRow>(
    "SELECT receipt FROM deletion_receipts WHERE receipt_id = $1",
    [receiptId],
  );
  return res.rows[0]?.receipt ?? null;
}

/**
 * The restore-replay feed (DATA-LIFECYCLE: "restore procedures replay
 * deletion receipts before reopening service"): every completed receipt of
 * the active tenant, in the minimal shape replayDeletionsOnRestore consumes.
 */
export async function listCompletedSubjectDigests(
  executor: SqlExecutor,
): Promise<DeletionReceiptLike[]> {
  const res = await executor.query<DeletionReceiptRow>("SELECT receipt FROM deletion_receipts");
  return res.rows.map((row) => ({
    subjectDigests: row.receipt.subjectDigests,
    status: row.receipt.status,
  }));
}
