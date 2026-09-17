/**
 * Restore replay (DATA-LIFECYCLE.md, explicit deletion §7).
 *
 * "Restore procedures replay deletion receipts before reopening service."
 * An accepted deletion — a receipt whose status is `complete` — must never
 * resurrect when an encrypted backup is restored. Replay removes every restored
 * subject whose opaque digest appears in a completed receipt. A `blocked`
 * receipt is a valid refusal (the deletion never happened) and removes nothing.
 * Any other status is a corrupt or forged receipt and fails the restore closed,
 * rather than being silently ignored (which would let a deletion resurrect).
 */
export interface DeletionReceiptLike {
  readonly subjectDigests: readonly string[];
  readonly status: string;
}

// contracts/schemas/deletion-receipt.v1.schema.json status enum.
const ACCEPTED_STATUS = "complete";
const REFUSED_STATUS = "blocked";

export class UnknownReceiptStatusError extends Error {
  constructor(status: string) {
    super(`unknown deletion-receipt status ${JSON.stringify(status)} — restore aborted`);
    this.name = "UnknownReceiptStatusError";
  }
}

export function replayDeletionsOnRestore(
  restoredDigests: readonly string[],
  receipts: readonly DeletionReceiptLike[],
): string[] {
  const deleted = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.status === REFUSED_STATUS) {
      continue;
    }
    if (receipt.status !== ACCEPTED_STATUS) {
      throw new UnknownReceiptStatusError(receipt.status);
    }
    for (const digest of receipt.subjectDigests) {
      deleted.add(digest);
    }
  }
  return restoredDigests.filter((digest) => !deleted.has(digest));
}
