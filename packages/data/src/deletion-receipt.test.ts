import { describe, expect, test } from "bun:test";

import { backupExpiryCeiling } from "./backup-ceiling";
import {
  buildCompletedDeletionReceipt,
  type DeletionReceiptInput,
  EmptySubjectSetError,
  InvalidStoreOutcomeError,
  NonOpaqueDigestError,
} from "./deletion-receipt";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const input: DeletionReceiptInput = {
  id: "rcp_1",
  tenantId: `ten_${"a1b2c3d4e5f6g7h8"}`,
  owner: "radar",
  subjectDigests: [DIGEST_A, DIGEST_B],
  requestedBy: "usr_9",
  requestedAt: "2026-07-20T00:00:00.000Z",
  completedAt: "2026-07-20T00:00:05.000Z",
  stores: [{ store: "postgresql", outcome: "deleted" }],
};

describe("completed deletion receipt", () => {
  test("carries the contract version and the complete status", () => {
    const receipt = buildCompletedDeletionReceipt(input);
    expect(receipt.schemaVersion).toBe("libre-ai.deletion-receipt.v1");
    expect(receipt.status).toBe("complete");
    expect(receipt.completedAt).toBe("2026-07-20T00:00:05.000Z");
  });

  test("sets the backup expiry to the 35-day ceiling", () => {
    const receipt = buildCompletedDeletionReceipt(input);
    expect(receipt.backupExpiresAt).toBe(backupExpiryCeiling(input.completedAt));
  });

  test("carries only opaque digests, never deleted content", () => {
    // DATA-LIFECYCLE.md §5: a receipt contains "opaque digests ... never
    // deleted content". The emitted object exposes only contract fields.
    const receipt = buildCompletedDeletionReceipt(input);
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "backupExpiresAt",
        "completedAt",
        "id",
        "owner",
        "requestedAt",
        "requestedBy",
        "schemaVersion",
        "status",
        "stores",
        "subjectDigests",
        "tenantId",
      ].sort(),
    );
  });

  test("refuses to emit a receipt that names no subject", () => {
    expect(() => buildCompletedDeletionReceipt({ ...input, subjectDigests: [] })).toThrow(
      EmptySubjectSetError,
    );
  });

  test("refuses a subject that is not an opaque sha-256 digest", () => {
    // DATA-LIFECYCLE.md §5: opaque digests, never deleted content. A cleartext
    // value (PII, identifier) must be refused so it cannot enter the receipt.
    expect(() =>
      buildCompletedDeletionReceipt({
        ...input,
        subjectDigests: ["alice@example.com"],
      }),
    ).toThrow(NonOpaqueDigestError);
  });

  test("refuses a malformed digest (wrong length or non-hex)", () => {
    expect(() =>
      buildCompletedDeletionReceipt({ ...input, subjectDigests: ["a".repeat(63)] }),
    ).toThrow(NonOpaqueDigestError);
    expect(() =>
      buildCompletedDeletionReceipt({ ...input, subjectDigests: ["A".repeat(64)] }),
    ).toThrow(NonOpaqueDigestError);
  });

  test("refuses a store outside the contract enum", () => {
    expect(() =>
      buildCompletedDeletionReceipt({
        ...input,
        stores: [{ store: "elasticsearch", outcome: "deleted" }],
      }),
    ).toThrow(InvalidStoreOutcomeError);
  });

  test("refuses an outcome not allowed for a completed deletion", () => {
    // A complete receipt allows only deleted | not-applicable (schema conditional).
    expect(() =>
      buildCompletedDeletionReceipt({
        ...input,
        stores: [{ store: "postgresql", outcome: "blocked" }],
      }),
    ).toThrow(InvalidStoreOutcomeError);
  });

  test("refuses a malformed store reason code", () => {
    expect(() =>
      buildCompletedDeletionReceipt({
        ...input,
        stores: [{ store: "redis", outcome: "not-applicable", reasonCode: "Bad Code!" }],
      }),
    ).toThrow(InvalidStoreOutcomeError);
  });

  test("accepts a valid store with a well-formed reason code", () => {
    const receipt = buildCompletedDeletionReceipt({
      ...input,
      stores: [{ store: "redis", outcome: "not-applicable", reasonCode: "deletion.cache-miss" }],
    });
    expect(receipt.stores[0]?.reasonCode).toBe("deletion.cache-miss");
  });
});
