import { describe, expect, test } from "bun:test";
import * as auditEventStore from "./adapters/audit-event-store";
import * as databaseClient from "./adapters/database-client";
import * as migrationRunner from "./adapters/migration-runner";
import * as auditEvent from "./audit-event";
import * as entry from "./index";

/**
 * The package exposes a single entry (`exports["."]`): what is not re-exported
 * there does not exist for a consumer.
 */
describe("package entry", () => {
  test("exposes the migration runner and its errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.migrate).toBe(migrationRunner.migrate);
    expect(exposed.MigrationFailedError).toBe(migrationRunner.MigrationFailedError);
    expect(exposed.InvalidMigrationIdError).toBe(migrationRunner.InvalidMigrationIdError);
    expect(exposed.DuplicateMigrationIdError).toBe(migrationRunner.DuplicateMigrationIdError);
  });

  test("exposes the client factory, the session bridge and their errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.createClient).toBe(databaseClient.createClient);
    expect(exposed.InvalidDatabaseUriError).toBe(databaseClient.InvalidDatabaseUriError);
    expect(exposed.withDedicatedSession).toBe(databaseClient.withDedicatedSession);
    expect(exposed.SessionResetFailedError).toBe(databaseClient.SessionResetFailedError);
  });

  test("exposes the types a consumer needs to call them", () => {
    // Checked by the compiler: these imports fail typecheck when one is missing.
    const migration: entry.Migration = { id: "0001_first", run: async () => {} };
    const journal: entry.MigrationJournal = () => {};
    const pool: entry.SessionPool | undefined = undefined;
    const connection: entry.SessionConnection | undefined = undefined;
    expect(migration.id).toBe("0001_first");
    expect(typeof journal).toBe("function");
    expect(pool).toBeUndefined();
    expect(connection).toBeUndefined();
  });

  test("exposes the audit event builder, its enumerations and both store modes", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.buildAuditEvent).toBe(auditEvent.buildAuditEvent);
    expect(exposed.InvalidAuditEventError).toBe(auditEvent.InvalidAuditEventError);
    expect(exposed.AUDIT_OUTCOMES).toBe(auditEvent.AUDIT_OUTCOMES);
    expect(exposed.AUDIT_SEVERITIES).toBe(auditEvent.AUDIT_SEVERITIES);
    expect(exposed.appendAuditEvent).toBe(auditEventStore.appendAuditEvent);
    expect(exposed.recordAuditEventBestEffort).toBe(auditEventStore.recordAuditEventBestEffort);
  });

  test("exposes the audit types a consumer needs to call them", () => {
    // Checked by the compiler: these annotations fail typecheck when one is missing.
    const outcome: entry.AuditOutcome = "denied";
    const severity: entry.AuditSeverity = "warn";
    const input: entry.AuditEventInput = {
      id: "evt_0001",
      action: "request.transition",
      actorId: "usr_0001",
      outcome,
      severity,
      occurredAt: "2026-11-17T10:00:00Z",
    };
    const event: entry.AuditEvent = entry.buildAuditEvent(input);
    const failure: entry.AuditStoreFailure = { action: event.action, errorName: "Error" };
    expect(event.severity).toBe("warn");
    expect(failure.action).toBe("request.transition");
  });

  test("keeps every value the entry exposed before the audit journal was added", () => {
    const exposed: Record<string, unknown> = entry;
    const missing = EXPORTS_BEFORE_AUDIT.filter((name) => exposed[name] === undefined);
    expect(missing).toEqual([]);
    expect(EXPORTS_BEFORE_AUDIT).toHaveLength(53);
  });
});

/**
 * The 53 runtime values of the entry as it stood before the audit exports,
 * listed from that revision: a removal or a rename must redden here.
 */
const EXPORTS_BEFORE_AUDIT: readonly string[] = [
  "AboveMaximumRetentionError",
  "BACKUP_EXPIRY_DAYS",
  "BackupCeilingExceededError",
  "BelowMinimumRetentionError",
  "CachePurgeFailedError",
  "CrossTenantAccessError",
  "DELETION_RECEIPT_SCHEMA",
  "DuplicateMigrationIdError",
  "EmptySubjectSetError",
  "InMemoryBlobStore",
  "InMemoryProjectionCache",
  "InvalidDatabaseUriError",
  "InvalidMigrationIdError",
  "InvalidStoreOutcomeError",
  "MalformedTenantIdError",
  "MigrationFailedError",
  "MissingTenantContextError",
  "MissingTtlError",
  "NonOpaqueDigestError",
  "NonPositiveRetentionError",
  "NotConfigurableError",
  "PUBLIC_SERVICE_TENANT",
  "PublicTenantRejectedError",
  "RetentionWindowUnresolvedError",
  "SessionResetFailedError",
  "UnknownReceiptStatusError",
  "UnsafeTableNameError",
  "assertTenantContextId",
  "assertWithinBackupCeiling",
  "backupExpiryCeiling",
  "buildCompletedDeletionReceipt",
  "clearPooledSession",
  "createClient",
  "executeActiveDeletion",
  "getDeletionReceipt",
  "getRetentionRule",
  "guardTenantRow",
  "isPrivateTenantId",
  "listCompletedSubjectDigests",
  "migrate",
  "persistDeletionReceipt",
  "replayDeletionsOnRestore",
  "requireTenantContext",
  "resolveConfiguredRetention",
  "retentionDurationDays",
  "runInTenantContext",
  "runRetentionSweep",
  "selectExpiredIds",
  "selectExpiredRowIds",
  "upsertRetentionRule",
  "withDedicatedSession",
  "withTenantDbTransaction",
  "withTenantRetentionTransaction",
];
