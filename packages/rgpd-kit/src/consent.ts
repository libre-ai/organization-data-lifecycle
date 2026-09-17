// Consent lifecycle, simplified first increment (GDPR Art. 7; owner decision
// 2026-07-23: simplified model now, extensible per-purpose so Art. 7(4)
// granularity is already the unit of evaluation). A consent names its
// purposes explicitly and `isConsentActiveAt` answers for ONE purpose at one
// instant — a product never gets a blanket yes. Storage is the product's own
// concern in its bounded context; rgpd-kit persists nothing.

import type { DataCategory } from "./data-category";

export const CONSENT_GRANT_CHANNELS = ["explicit-form", "api-endpoint", "web-form"] as const;
export type ConsentGrantChannel = (typeof CONSENT_GRANT_CHANNELS)[number];

export const CONSENT_WITHDRAWAL_CHANNELS = ["web-form", "api-endpoint", "email"] as const;
export type ConsentWithdrawalChannel = (typeof CONSENT_WITHDRAWAL_CHANNELS)[number];

export interface ConsentGrant {
  readonly purposes: readonly string[];
  readonly categories: readonly DataCategory[];
  /** ISO 8601 period, e.g. "P1Y" — validity window from grantedAt. */
  readonly duration: string;
}

export interface ConsentRecord {
  readonly consentId: string;
  readonly subjectDigest: string;
  readonly tenantId: string;
  readonly grantedAt: string;
  readonly grantedVia: ConsentGrantChannel;
  readonly grantedFor: ConsentGrant;
  readonly withdrawnAt?: string;
  readonly withdrawnVia?: ConsentWithdrawalChannel;
  readonly proofOfConsent?: {
    readonly documentDigest: string;
    /** Which consent text was accepted, version-pinned. */
    readonly versionHash: string;
  };
}

export interface ConsentWithdrawal {
  readonly consentId: string;
  readonly withdrawnAt: string;
  readonly withdrawnVia: ConsentWithdrawalChannel;
  readonly reason?: string;
}

export class InvalidConsentPeriodError extends Error {
  constructor(field: string) {
    super(`invalid consent period: ${field}`);
    this.name = "InvalidConsentPeriodError";
  }
}

export class InvalidConsentRecordError extends Error {
  constructor(field: string) {
    super(`invalid consent record: ${field}`);
    this.name = "InvalidConsentRecordError";
  }
}

// Minimal, fail-closed ISO 8601 period: date components only (Y/M/D), at
// least one present. Time components or anything else are refused rather
// than silently misread.
const ISO_PERIOD = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/;

function addPeriodUtc(startIso: string, period: string): Date {
  const match = ISO_PERIOD.exec(period);
  if (
    match === null ||
    (match[1] === undefined && match[2] === undefined && match[3] === undefined)
  ) {
    throw new InvalidConsentPeriodError(
      "duration must be an ISO 8601 date period (e.g. P1Y, P3M, P30D)",
    );
  }
  const start = new Date(startIso);
  const expiry = new Date(start.getTime());
  expiry.setUTCFullYear(expiry.getUTCFullYear() + Number(match[1] ?? 0));
  expiry.setUTCMonth(expiry.getUTCMonth() + Number(match[2] ?? 0));
  expiry.setUTCDate(expiry.getUTCDate() + Number(match[3] ?? 0));
  return expiry;
}

function parseInstant(value: string, field: string): number {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    throw new InvalidConsentRecordError(field);
  }
  return time;
}

/**
 * Whether `record` authorizes processing for ONE purpose at one instant:
 * granted at or before `atIso`, purpose explicitly named, not withdrawn at or
 * before `atIso` (Art. 7(3)), and inside the granted duration window
 * (expiry excluded). Fail-closed: malformed inputs throw, they never return
 * a permissive false-negative silently mistaken for a yes elsewhere.
 */
export function isConsentActiveAt(record: ConsentRecord, atIso: string, purpose: string): boolean {
  const at = parseInstant(atIso, "at");
  const grantedAt = parseInstant(record.grantedAt, "grantedAt");
  const expiry = addPeriodUtc(record.grantedAt, record.grantedFor.duration).getTime();
  if (!record.grantedFor.purposes.includes(purpose)) {
    return false;
  }
  if (at < grantedAt || at >= expiry) {
    return false;
  }
  if (record.withdrawnAt !== undefined && at >= parseInstant(record.withdrawnAt, "withdrawnAt")) {
    return false;
  }
  return true;
}
