export {
  type ActiveDeletionRequest,
  CachePurgeFailedError,
  executeActiveDeletion,
} from "./adapters/active-deletion";
export {
  type BlobMetadata,
  type BlobStorePort,
  InMemoryBlobStore,
} from "./adapters/blob-store-port";
export {
  getDeletionReceipt,
  listCompletedSubjectDigests,
  persistDeletionReceipt,
} from "./adapters/deletion-receipt-store";
export type { SqlExecutor, SqlQueryResult } from "./adapters/executor";
export {
  type ExpiredSelectionOptions,
  selectExpiredRowIds,
  UnsafeTableNameError,
} from "./adapters/expired-selection-query";
export {
  InMemoryProjectionCache,
  MissingTtlError,
  type ProjectionCachePort,
} from "./adapters/projection-cache-port";
export {
  getRetentionRule,
  type StoredRetentionRule,
  type UpsertRetentionRuleInput,
  upsertRetentionRule,
} from "./adapters/retention-rules-store";
export { withTenantRetentionTransaction } from "./adapters/retention-transaction";
export {
  clearPooledSession,
  withTenantDbTransaction,
} from "./adapters/tenant-transaction";
export {
  assertWithinBackupCeiling,
  BACKUP_EXPIRY_DAYS,
  BackupCeilingExceededError,
  backupExpiryCeiling,
} from "./backup-ceiling";
export {
  buildCompletedDeletionReceipt,
  DELETION_RECEIPT_SCHEMA,
  type DeletionReceipt,
  type DeletionReceiptInput,
  type DeletionStoreOutcome,
  EmptySubjectSetError,
  InvalidStoreOutcomeError,
  NonOpaqueDigestError,
} from "./deletion-receipt";
export { type RetainedRecord, selectExpiredIds } from "./expired-selection";
export {
  type DeletionReceiptLike,
  replayDeletionsOnRestore,
  UnknownReceiptStatusError,
} from "./restore-replay";
export {
  AboveMaximumRetentionError,
  BelowMinimumRetentionError,
  NonPositiveRetentionError,
  NotConfigurableError,
  type RetentionRule,
  resolveConfiguredRetention,
  retentionDurationDays,
} from "./retention-bounds";
export {
  type CompactionSpec,
  type RetentionEvidenceReport,
  RetentionWindowUnresolvedError,
  runRetentionSweep,
} from "./retention-sweep";
export {
  MissingTenantContextError,
  requireTenantContext,
  runInTenantContext,
} from "./tenant-context";
export {
  assertTenantContextId,
  isPrivateTenantId,
  MalformedTenantIdError,
  PUBLIC_SERVICE_TENANT,
} from "./tenant-id";
export {
  CrossTenantAccessError,
  guardTenantRow,
  PublicTenantRejectedError,
  type TenantOwned,
} from "./tenant-row-guard";
