// Typed data-subject rights requests and results (GDPR Art. 12-22; design
// §4.1). Requests carry only the opaque subject digest — never the plaintext
// identifier (Appendix B). Port results are discriminated unions with typed,
// owner-prefixed refusal codes: an Art. 12(4) refusal is a first-class
// outcome, not an exception (codebase style: SessionCommandResult).

import type { DataCategory } from "./data-category";

export const DATA_SUBJECT_RIGHT_TYPES = [
  "access", // Art. 15
  "rectification", // Art. 16
  "erasure", // Art. 17
  "restriction", // Art. 18
  "portability", // Art. 20
  "object", // Art. 21
] as const;
export type DataSubjectRightType = (typeof DATA_SUBJECT_RIGHT_TYPES)[number];

export const REQUEST_CHANNELS = ["web-form", "email", "api"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export const REQUEST_STATUSES = [
  "received",
  "acknowledged",
  "in-progress",
  "fulfilled",
  "refused",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Art. 18(1) grounds: the reason belongs to the subject and must enter
// through the request, not be invented by the implementation.
export const RESTRICTION_GROUNDS = [
  "accuracy-contested",
  "unlawful-opposed-erasure",
  "needed-for-legal-claims",
  "objection-pending",
] as const;
export type RestrictionGround = (typeof RESTRICTION_GROUNDS)[number];

// Patterns are the LOCKED common.v1 definitions — replicated verbatim, not
// reinvented (contracts/schemas/common.v1.schema.json#/$defs).
const PRIVATE_TENANT_ID = /^ten_[a-z0-9]{16,64}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
// RFC 3339 date-time (common.v1 timestamp is `format: date-time`): a UTC or
// offset designator is required.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Owner-prefixed refusal codes, e.g. "sessions.rgpd.subject_unknown": the
// prefix names the bounded context that refused, mirroring per-product
// reason-code families like /^sessions\.…/ and /^deletion\.…/.
const REFUSAL_CODE = /^[a-z][a-z0-9-]*\.[a-z0-9_.-]+$/;

// Art. 12(3): the controller answers without undue delay and at the latest
// within one month; the kit fixes the deadline at 30 days.
const RESPONSE_DEADLINE_DAYS = 30;

export interface DataSubjectRequest {
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly rightType: DataSubjectRightType;
  readonly tenantId: string;
  readonly receivedAt: string;
  readonly submittedVia: RequestChannel;
  readonly status: RequestStatus;
  readonly deadline: string;
  readonly refusalReason?: string;
}

export class InvalidDataSubjectRequestError extends Error {
  // Name the failing field only — free-text values may carry PII.
  constructor(field: string) {
    super(`invalid data-subject request: ${field}`);
    this.name = "InvalidDataSubjectRequestError";
  }
}

export function isRgpdRefusalCode(value: string): boolean {
  return REFUSAL_CODE.test(value);
}

export function computeResponseDeadline(receivedAt: string): string {
  if (!TIMESTAMP.test(receivedAt)) {
    throw new InvalidDataSubjectRequestError("receivedAt");
  }
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) {
    throw new InvalidDataSubjectRequestError("receivedAt");
  }
  const deadline = new Date(received.getTime() + RESPONSE_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  return deadline.toISOString();
}

function isIn<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isRestrictionGround(value: unknown): value is RestrictionGround {
  return isIn(RESTRICTION_GROUNDS, value);
}

export function validateDataSubjectRequest(input: unknown): DataSubjectRequest {
  if (typeof input !== "object" || input === null) {
    throw new InvalidDataSubjectRequestError("request must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.requestId !== "string" || candidate.requestId.trim() === "") {
    throw new InvalidDataSubjectRequestError("requestId");
  }
  if (typeof candidate.subjectDigest !== "string" || !SHA256_DIGEST.test(candidate.subjectDigest)) {
    throw new InvalidDataSubjectRequestError("subjectDigest");
  }
  if (!isIn(DATA_SUBJECT_RIGHT_TYPES, candidate.rightType)) {
    throw new InvalidDataSubjectRequestError("rightType");
  }
  if (typeof candidate.tenantId !== "string" || !PRIVATE_TENANT_ID.test(candidate.tenantId)) {
    throw new InvalidDataSubjectRequestError("tenantId");
  }
  if (typeof candidate.receivedAt !== "string" || !TIMESTAMP.test(candidate.receivedAt)) {
    throw new InvalidDataSubjectRequestError("receivedAt");
  }
  if (!isIn(REQUEST_CHANNELS, candidate.submittedVia)) {
    throw new InvalidDataSubjectRequestError("submittedVia");
  }
  if (!isIn(REQUEST_STATUSES, candidate.status)) {
    throw new InvalidDataSubjectRequestError("status");
  }
  if (typeof candidate.deadline !== "string" || !TIMESTAMP.test(candidate.deadline)) {
    throw new InvalidDataSubjectRequestError("deadline");
  }
  if (candidate.status === "refused") {
    if (
      typeof candidate.refusalReason !== "string" ||
      !isRgpdRefusalCode(candidate.refusalReason)
    ) {
      throw new InvalidDataSubjectRequestError("refusalReason");
    }
  } else if (candidate.refusalReason !== undefined) {
    throw new InvalidDataSubjectRequestError("refusalReason is only valid on a refused request");
  }
  const request: DataSubjectRequest = {
    requestId: candidate.requestId,
    subjectDigest: candidate.subjectDigest,
    rightType: candidate.rightType,
    tenantId: candidate.tenantId,
    receivedAt: candidate.receivedAt,
    submittedVia: candidate.submittedVia,
    status: candidate.status,
    deadline: candidate.deadline,
  };
  return candidate.status === "refused"
    ? { ...request, refusalReason: candidate.refusalReason as string }
    : request;
}

// ---------------------------------------------------------------------------
// Port result unions. A refusal never carries free text — only an
// owner-prefixed code the product documents.

export interface RgpdRefusal {
  readonly status: "refused";
  readonly requestId: string;
  readonly refusal: string;
}

export interface AccessFulfilled {
  readonly status: "fulfilled";
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly dataExport: unknown;
  readonly exportedAt: string;
  readonly categories: readonly DataCategory[];
  readonly completenessNote?: string;
}
export type AccessRequestResult = AccessFulfilled | RgpdRefusal;

export interface ErasureFulfilled {
  readonly status: "fulfilled";
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly erasedAt: string;
  readonly deletionReceiptId: string;
  readonly recordsAffected: number;
  readonly categoriesErased: readonly DataCategory[];
}
export type ErasureRequestResult = ErasureFulfilled | RgpdRefusal;

export interface RestrictionFulfilled {
  readonly status: "fulfilled";
  readonly requestId: string;
  readonly restrictedAt: string;
  readonly affectedRecords: number;
  readonly ground: RestrictionGround;
}
export type RestrictionRequestResult = RestrictionFulfilled | RgpdRefusal;

export interface PortabilityFulfilled {
  readonly status: "fulfilled";
  readonly requestId: string;
  readonly dataExport: unknown;
  readonly format: string;
  readonly exportedAt: string;
}
export type PortabilityRequestResult = PortabilityFulfilled | RgpdRefusal;
