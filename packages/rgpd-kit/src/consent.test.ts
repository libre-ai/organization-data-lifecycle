import { describe, expect, test } from "bun:test";
import type { ConsentRecord } from "./consent";
import { InvalidConsentPeriodError, InvalidConsentRecordError, isConsentActiveAt } from "./consent";

const RECORD: ConsentRecord = {
  consentId: "cst_5b1e9d2f7c4a8e01",
  subjectDigest: "b".repeat(64),
  tenantId: "ten_aaaaaaaaaaaaaaaa",
  grantedAt: "2026-01-01T00:00:00Z",
  grantedVia: "explicit-form",
  grantedFor: {
    purposes: ["sessions-moderation", "boussole-scoring"],
    categories: ["communication"],
    duration: "P1Y",
  },
};

describe("isConsentActiveAt", () => {
  test("is active inside the window for a granted purpose", () => {
    expect(isConsentActiveAt(RECORD, "2026-06-01T00:00:00Z", "sessions-moderation")).toBe(true);
  });

  test("is inactive for a purpose that was never granted (Art. 7(4) granularity)", () => {
    expect(isConsentActiveAt(RECORD, "2026-06-01T00:00:00Z", "marketing")).toBe(false);
  });

  test("is inactive before the grant", () => {
    expect(isConsentActiveAt(RECORD, "2025-12-31T23:59:59Z", "sessions-moderation")).toBe(false);
  });

  test("is inactive once the duration has elapsed", () => {
    expect(isConsentActiveAt(RECORD, "2027-01-01T00:00:00Z", "sessions-moderation")).toBe(false);
    expect(isConsentActiveAt(RECORD, "2026-12-31T23:59:59Z", "sessions-moderation")).toBe(true);
  });

  test("is inactive after withdrawal (Art. 7(3))", () => {
    const withdrawn: ConsentRecord = {
      ...RECORD,
      withdrawnAt: "2026-03-01T00:00:00Z",
      withdrawnVia: "web-form",
    };
    expect(isConsentActiveAt(withdrawn, "2026-06-01T00:00:00Z", "sessions-moderation")).toBe(false);
    expect(isConsentActiveAt(withdrawn, "2026-02-01T00:00:00Z", "sessions-moderation")).toBe(true);
  });

  test("supports day and month periods", () => {
    const short: ConsentRecord = {
      ...RECORD,
      grantedFor: { ...RECORD.grantedFor, duration: "P30D" },
    };
    expect(isConsentActiveAt(short, "2026-01-30T00:00:00Z", "sessions-moderation")).toBe(true);
    expect(isConsentActiveAt(short, "2026-02-01T00:00:00Z", "sessions-moderation")).toBe(false);
    const quarterly: ConsentRecord = {
      ...RECORD,
      grantedFor: { ...RECORD.grantedFor, duration: "P3M" },
    };
    expect(isConsentActiveAt(quarterly, "2026-03-31T00:00:00Z", "sessions-moderation")).toBe(true);
    expect(isConsentActiveAt(quarterly, "2026-04-01T00:00:00Z", "sessions-moderation")).toBe(false);
  });

  test("fails closed on a malformed period", () => {
    const broken: ConsentRecord = {
      ...RECORD,
      grantedFor: { ...RECORD.grantedFor, duration: "1 year" },
    };
    expect(() => isConsentActiveAt(broken, "2026-06-01T00:00:00Z", "sessions-moderation")).toThrow(
      InvalidConsentPeriodError,
    );
    const empty: ConsentRecord = {
      ...RECORD,
      grantedFor: { ...RECORD.grantedFor, duration: "P" },
    };
    expect(() => isConsentActiveAt(empty, "2026-06-01T00:00:00Z", "sessions-moderation")).toThrow(
      InvalidConsentPeriodError,
    );
  });

  test("fails closed on a malformed evaluation instant", () => {
    expect(() => isConsentActiveAt(RECORD, "tomorrow", "sessions-moderation")).toThrow(
      InvalidConsentRecordError,
    );
  });
});
