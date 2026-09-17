import { backupExpiryCeiling } from "./backup-ceiling";

/**
 * Completed deletion receipt builder (DATA-LIFECYCLE.md, explicit deletion §5).
 *
 * A `DeletionReceipt` contains opaque digests, stores, timestamps and the
 * backup-expiry ceiling — never deleted content. The builder emits only the
 * contract fields (`libre-ai.deletion-receipt.v1`), sets the accepted `complete`
 * status, and derives the backup expiry from the 35-day ceiling. A deletion
 * that names no subject is refused: an accepted receipt must be attributable.
 */
export const DELETION_RECEIPT_SCHEMA = "libre-ai.deletion-receipt.v1";

// contracts/schemas/common.v1.schema.json#/$defs/sha256
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export class EmptySubjectSetError extends Error {
  constructor() {
    super("a completed deletion receipt must name at least one subject digest");
    this.name = "EmptySubjectSetError";
  }
}

export class NonOpaqueDigestError extends Error {
  constructor(value: string) {
    // Never echo the offending value: it may itself be the cleartext content
    // this guard exists to keep out of the receipt. Report only its length.
    super(`a subject digest must be an opaque sha-256 (got a ${value.length}-char value)`);
    this.name = "NonOpaqueDigestError";
  }
}

// contracts/schemas/deletion-receipt.v1.schema.json store/outcome enums; a
// completed receipt allows only deleted | not-applicable (schema conditional).
const CONTRACT_STORES = new Set(["postgresql", "cellar", "redis", "search", "key-store"]);
const COMPLETE_OUTCOMES = new Set(["deleted", "not-applicable"]);
const REASON_CODE = /^deletion\.[a-z0-9_.-]+$/;

/** Contract reason-code check, shared with entry-point validation (fail closed before mutation). */
export function isDeletionReasonCode(value: string): boolean {
  return REASON_CODE.test(value);
}

export class InvalidStoreOutcomeError extends Error {
  constructor(detail: string) {
    super(`invalid store outcome: ${detail}`);
    this.name = "InvalidStoreOutcomeError";
  }
}

export interface DeletionStoreOutcome {
  readonly store: string;
  readonly outcome: string;
  readonly reasonCode?: string;
}

export interface DeletionReceiptInput {
  readonly id: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly subjectDigests: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly stores: readonly DeletionStoreOutcome[];
}

export interface DeletionReceipt {
  readonly schemaVersion: string;
  readonly id: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly subjectDigests: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly status: "complete";
  readonly completedAt: string;
  readonly backupExpiresAt: string;
  readonly stores: readonly DeletionStoreOutcome[];
}

export function buildCompletedDeletionReceipt(input: DeletionReceiptInput): DeletionReceipt {
  if (input.subjectDigests.length === 0) {
    throw new EmptySubjectSetError();
  }
  for (const digest of input.subjectDigests) {
    if (!SHA256_DIGEST.test(digest)) {
      throw new NonOpaqueDigestError(digest);
    }
  }
  for (const entry of input.stores) {
    if (!CONTRACT_STORES.has(entry.store)) {
      throw new InvalidStoreOutcomeError(`unknown store ${JSON.stringify(entry.store)}`);
    }
    if (!COMPLETE_OUTCOMES.has(entry.outcome)) {
      throw new InvalidStoreOutcomeError(
        `outcome ${JSON.stringify(entry.outcome)} not allowed on a complete receipt`,
      );
    }
    if (entry.reasonCode !== undefined && !REASON_CODE.test(entry.reasonCode)) {
      // Never echo the offending value (same rule as NonOpaqueDigestError):
      // a malformed reason code may be free text carrying PII.
      throw new InvalidStoreOutcomeError(
        `malformed reason code (a ${entry.reasonCode.length}-char value)`,
      );
    }
  }
  return {
    schemaVersion: DELETION_RECEIPT_SCHEMA,
    id: input.id,
    tenantId: input.tenantId,
    owner: input.owner,
    subjectDigests: [...input.subjectDigests],
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    status: "complete",
    completedAt: input.completedAt,
    backupExpiresAt: backupExpiryCeiling(input.completedAt),
    stores: [...input.stores],
  };
}
