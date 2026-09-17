import { describe, expect, test } from "bun:test";
import {
  computeResponseDeadline,
  DATA_SUBJECT_RIGHT_TYPES,
  InvalidDataSubjectRequestError,
  isRgpdRefusalCode,
  REQUEST_CHANNELS,
  REQUEST_STATUSES,
  validateDataSubjectRequest,
} from "./data-subject-request";

const DIGEST = "a".repeat(64);
const REQUEST = {
  requestId: "dsr_0f4c2e7a9b1d4c8e",
  subjectDigest: DIGEST,
  rightType: "erasure",
  tenantId: "ten_aaaaaaaaaaaaaaaa",
  receivedAt: "2026-07-23T10:00:00Z",
  submittedVia: "api",
  status: "received",
  deadline: "2026-08-22T10:00:00Z",
};

describe("vocabularies", () => {
  test("locks the Art. 12-22 right types, channels and statuses", () => {
    expect(DATA_SUBJECT_RIGHT_TYPES).toEqual([
      "access",
      "rectification",
      "erasure",
      "restriction",
      "portability",
      "object",
    ]);
    expect(REQUEST_CHANNELS).toEqual(["web-form", "email", "api"]);
    expect(REQUEST_STATUSES).toEqual([
      "received",
      "acknowledged",
      "in-progress",
      "fulfilled",
      "refused",
    ]);
  });
});

describe("computeResponseDeadline", () => {
  test("adds the Art. 12(3) thirty days in UTC", () => {
    expect(computeResponseDeadline("2026-07-23T10:00:00Z")).toBe("2026-08-22T10:00:00.000Z");
  });

  test("crosses year boundaries correctly", () => {
    expect(computeResponseDeadline("2026-12-15T00:00:00Z")).toBe("2027-01-14T00:00:00.000Z");
  });

  test("rejects a malformed timestamp", () => {
    expect(() => computeResponseDeadline("23/07/2026")).toThrow(InvalidDataSubjectRequestError);
    expect(() => computeResponseDeadline("2026-07-23T10:00:00")).toThrow(
      InvalidDataSubjectRequestError,
    );
  });
});

describe("validateDataSubjectRequest", () => {
  test("round-trips a complete request", () => {
    expect(validateDataSubjectRequest(REQUEST)).toEqual({
      requestId: "dsr_0f4c2e7a9b1d4c8e",
      subjectDigest: DIGEST,
      rightType: "erasure",
      tenantId: "ten_aaaaaaaaaaaaaaaa",
      receivedAt: "2026-07-23T10:00:00Z",
      submittedVia: "api",
      status: "received",
      deadline: "2026-08-22T10:00:00Z",
    });
  });

  test("keeps a refusal reason only when the status is refused", () => {
    const refused = validateDataSubjectRequest({
      ...REQUEST,
      status: "refused",
      refusalReason: "sessions.rgpd.subject_unknown",
    });
    expect(refused.refusalReason).toBe("sessions.rgpd.subject_unknown");
    expect(() =>
      validateDataSubjectRequest({ ...REQUEST, refusalReason: "sessions.rgpd.subject_unknown" }),
    ).toThrow(InvalidDataSubjectRequestError);
  });

  test("rejects each malformed field", () => {
    const bad: Record<string, unknown>[] = [
      { requestId: "" },
      { subjectDigest: "user@example.com" },
      { rightType: "deletion" },
      { tenantId: "public" },
      { receivedAt: "yesterday" },
      { submittedVia: "phone" },
      { status: "done" },
      { deadline: "soon" },
    ];
    for (const override of bad) {
      expect(() => validateDataSubjectRequest({ ...REQUEST, ...override })).toThrow(
        InvalidDataSubjectRequestError,
      );
    }
  });

  test("rejects a refusal status whose reason is not an owner-prefixed code", () => {
    expect(() =>
      validateDataSubjectRequest({
        ...REQUEST,
        status: "refused",
        refusalReason: "because the user asked user@example.com",
      }),
    ).toThrow(InvalidDataSubjectRequestError);
  });
});

describe("isRgpdRefusalCode", () => {
  test("accepts owner-prefixed codes and rejects free text", () => {
    expect(isRgpdRefusalCode("sessions.rgpd.subject_erased")).toBe(true);
    expect(isRgpdRefusalCode("test-product.rgpd.not_implemented")).toBe(true);
    expect(isRgpdRefusalCode("no dots here")).toBe(false);
    expect(isRgpdRefusalCode("Sessions.RGPD")).toBe(false);
  });
});
