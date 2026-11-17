/**
 * Audit event builder: validates what a caller wants to record and returns a
 * frozen event, ready for the store (adapters/audit-event-store.ts).
 *
 * An audit line carries opaque identifiers only — no network address, no
 * client signature, no cleartext subject. The timestamp is supplied by the
 * caller: no module of this package reads the clock.
 *
 * Every refusal is an `InvalidAuditEventError` that names the field and, at
 * most, a length or a type: the offending value is never echoed, because a
 * malformed field may be free text carrying personal data.
 */
export const AUDIT_OUTCOMES = ["success", "failure", "denied", "error"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_SEVERITIES = ["info", "warn", "high", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export type AuditContextValue = string | number | boolean | null;
export type AuditContext = Readonly<Record<string, AuditContextValue>>;

export interface AuditEventInput {
  readonly id: string;
  readonly action: string;
  readonly actorId: string;
  readonly actorRole?: string;
  readonly resource?: string;
  readonly outcome: AuditOutcome;
  readonly severity?: AuditSeverity;
  readonly context?: AuditContext;
  readonly occurredAt: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly action: string;
  readonly actorId: string;
  readonly actorRole?: string;
  readonly resource?: string;
  readonly outcome: AuditOutcome;
  readonly severity: AuditSeverity;
  readonly context: AuditContext;
  readonly occurredAt: string;
}

export class InvalidAuditEventError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`invalid audit event field ${field}: ${detail}`);
    this.name = "InvalidAuditEventError";
    this.field = field;
  }
}

const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const ACTION = /^[a-z][a-z0-9_.-]{0,119}$/;
const ACTOR_ROLE = /^[a-z][a-z0-9_-]{0,59}$/;
const RESOURCE = /^[A-Za-z0-9_.:/-]{1,200}$/;
// ISO 8601 date-time with an explicit zone: a zoneless timestamp would be
// read in the server's zone and name a different instant on another host.
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Upper bound of the serialized context, in UTF-8 bytes. */
const MAX_CONTEXT_BYTES = 4096;

function describeShape(value: unknown): string {
  return typeof value === "string" ? `a ${value.length}-char value` : `a ${typeof value} value`;
}

function requireMatch(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new InvalidAuditEventError(
      field,
      `${describeShape(value)} does not match the expected format`,
    );
  }
  return value;
}

function requireMember<T extends string>(field: string, value: unknown, members: readonly T[]): T {
  const member = members.find((candidate) => candidate === value);
  if (member === undefined) {
    throw new InvalidAuditEventError(
      field,
      `${describeShape(value)} is not one of the accepted values`,
    );
  }
  return member;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireMatch("occurredAt", value, ZONED_TIMESTAMP);
  // The pattern fixes the shape; Date.parse refuses what has the shape but
  // names no instant (month 13, hour 25).
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new InvalidAuditEventError(
      "occurredAt",
      `a ${timestamp.length}-char value does not name an instant`,
    );
  }
  return timestamp;
}

function isFlatValue(value: unknown): value is AuditContextValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  // NaN and the infinities serialize to null: refused rather than silently altered.
  return typeof value === "number" && Number.isFinite(value);
}

function requireContext(value: unknown): AuditContext {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidAuditEventError("context", "the context is not a plain object");
  }
  const context: Record<string, AuditContextValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isFlatValue(entry)) {
      // Neither the key nor the value is named: both are caller free text.
      throw new InvalidAuditEventError(
        "context",
        "a context value is not a string, a finite number, a boolean or null",
      );
    }
    context[key] = entry;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(context)).length;
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new InvalidAuditEventError(
      "context",
      `the serialized context is ${bytes} bytes, above the ${MAX_CONTEXT_BYTES}-byte limit`,
    );
  }
  return Object.freeze(context);
}

export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  const id = requireMatch("id", input.id, OPAQUE_ID);
  const action = requireMatch("action", input.action, ACTION);
  const actorId = requireMatch("actorId", input.actorId, OPAQUE_ID);
  const actorRole =
    input.actorRole === undefined
      ? undefined
      : requireMatch("actorRole", input.actorRole, ACTOR_ROLE);
  const resource =
    input.resource === undefined ? undefined : requireMatch("resource", input.resource, RESOURCE);
  const outcome = requireMember("outcome", input.outcome, AUDIT_OUTCOMES);
  const severity =
    input.severity === undefined
      ? "info"
      : requireMember("severity", input.severity, AUDIT_SEVERITIES);
  const context = requireContext(input.context);
  const occurredAt = requireTimestamp(input.occurredAt);
  return Object.freeze({
    id,
    action,
    actorId,
    ...(actorRole === undefined ? {} : { actorRole }),
    ...(resource === undefined ? {} : { resource }),
    outcome,
    severity,
    context,
    occurredAt,
  });
}
