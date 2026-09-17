import { describe, expect, test } from "bun:test";

import {
  assertWithinBackupCeiling,
  BACKUP_EXPIRY_DAYS,
  BackupCeilingExceededError,
  backupExpiryCeiling,
} from "./backup-ceiling";

describe("encrypted backup expiry ceiling", () => {
  test("the policy ceiling is 35 days", () => {
    // retention.v1.json backupExpiry: "P35D".
    expect(BACKUP_EXPIRY_DAYS).toBe(35);
  });

  test("the ceiling is the deletion instant plus 35 days", () => {
    expect(backupExpiryCeiling("2026-07-20T00:00:00.000Z")).toBe("2026-08-24T00:00:00.000Z");
  });

  test("a backup expiry at the ceiling is accepted", () => {
    expect(() =>
      assertWithinBackupCeiling("2026-07-20T00:00:00.000Z", "2026-08-24T00:00:00.000Z"),
    ).not.toThrow();
  });

  test("a backup expiry before the ceiling is accepted", () => {
    expect(() =>
      assertWithinBackupCeiling("2026-07-20T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
    ).not.toThrow();
  });

  test("a backup expiry beyond the ceiling is refused", () => {
    // DATA-LIFECYCLE.md: "Encrypted backups expire within 35 days".
    expect(() =>
      assertWithinBackupCeiling("2026-07-20T00:00:00.000Z", "2026-08-25T00:00:00.000Z"),
    ).toThrow(BackupCeilingExceededError);
  });
});
