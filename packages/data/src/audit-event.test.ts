import { describe, expect, test } from "bun:test";
import {
  AUDIT_OUTCOMES,
  AUDIT_SEVERITIES,
  type AuditEventInput,
  buildAuditEvent,
  InvalidAuditEventError,
} from "./audit-event";

/**
 * Audit event builder. Every expectation comes from the event contract (field
 * formats, enumerations, the 4096-byte context bound), not from the builder's
 * output.
 */

const VALID: AuditEventInput = {
  id: "evt_0001",
  action: "request.transition",
  actorId: "usr_0001",
  outcome: "success",
  occurredAt: "2026-11-17T10:00:00Z",
};

/** Builds with one field replaced by an arbitrary, possibly ill-typed, value. */
function buildWith(field: string, value: unknown) {
  const input: unknown = { ...VALID, [field]: value };
  return buildAuditEvent(input as AuditEventInput);
}

function refusal(field: string, value: unknown): InvalidAuditEventError {
  try {
    buildWith(field, value);
  } catch (error) {
    if (error instanceof InvalidAuditEventError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected field ${field} to be refused`);
}

/** `{"k":"…"}` costs 8 bytes around the value. */
const CONTEXT_ENVELOPE_BYTES = 8;

describe("enumerations", () => {
  test("the four outcomes and the four severities are the contract's", () => {
    expect([...AUDIT_OUTCOMES]).toEqual(["success", "failure", "denied", "error"]);
    expect([...AUDIT_SEVERITIES]).toEqual(["info", "warn", "high", "critical"]);
  });
});

describe("refusals", () => {
  // Each sentinel is a value a caller could plausibly pass by mistake; none
  // may come back in the message.
  const cases: ReadonlyArray<readonly [label: string, field: string, value: unknown]> = [
    ["an empty action", "action", ""],
    ["an action outside the pattern", "action", "Request Transition SENTINEL"],
    ["an action of 121 characters", "action", "a".repeat(121)],
    ["an outcome outside the enumeration", "outcome", "sentinel-outcome"],
    ["a severity outside the enumeration", "severity", "sentinel-severity"],
    ["an empty id", "id", ""],
    ["an id of 121 characters", "id", "i".repeat(121)],
    ["an id outside the pattern", "id", "evt sentinel id"],
    ["an empty actorId", "actorId", ""],
    ["an actorId of 121 characters", "actorId", "u".repeat(121)],
    ["an actorId outside the pattern", "actorId", "sentinel actor <id>"],
    ["an actorRole outside the pattern", "actorRole", "Sentinel Role"],
    ["a resource outside the pattern", "resource", "sentinel resource?"],
    ["an occurredAt that is not a timestamp", "occurredAt", "sentinel-not-a-date"],
    ["an occurredAt without a zone", "occurredAt", "2026-11-17T10:00:00"],
    ["an occurredAt that names no instant", "occurredAt", "2026-13-45T25:61:00Z"],
    ["a missing id", "id", undefined],
    ["a numeric action", "action", 42],
  ];

  for (const [label, field, value] of cases) {
    test(`${label} is refused, naming the field and never the value`, () => {
      const error = refusal(field, value);
      expect(error.name).toBe("InvalidAuditEventError");
      expect(error.field).toBe(field);
      expect(error.message).toContain(field);
      if (typeof value === "string" && value.length > 0) {
        expect(error.message).not.toContain(value);
        expect(error.message).toContain(`${value.length}-char`);
      }
    });
  }

  test("an id and an actorId of exactly 120 characters are accepted", () => {
    const event = buildAuditEvent({ ...VALID, id: "i".repeat(120), actorId: "u".repeat(120) });
    expect(event.id).toHaveLength(120);
    expect(event.actorId).toHaveLength(120);
  });
});

describe("defaults and pass-through", () => {
  test("without severity or context the event is info with an empty context", () => {
    const event = buildAuditEvent(VALID);
    expect(event.severity).toBe("info");
    expect(event.context).toEqual({});
    expect("actorRole" in event).toBe(false);
    expect("resource" in event).toBe(false);
  });

  test("an explicit severity and occurredAt are returned as given", () => {
    const event = buildAuditEvent({
      ...VALID,
      severity: "critical",
      occurredAt: "2026-11-17T12:30:15.250+02:00",
    });
    expect(event.severity).toBe("critical");
    expect(event.occurredAt).toBe("2026-11-17T12:30:15.250+02:00");
  });

  test("every supplied field is carried over", () => {
    const event = buildAuditEvent({
      ...VALID,
      actorRole: "case_officer",
      resource: "request/req_0001",
      outcome: "denied",
      context: { step: "review", attempt: 2, forced: false, note: null },
    });
    expect(event).toEqual({
      id: "evt_0001",
      action: "request.transition",
      actorId: "usr_0001",
      actorRole: "case_officer",
      resource: "request/req_0001",
      outcome: "denied",
      severity: "info",
      context: { step: "review", attempt: 2, forced: false, note: null },
      occurredAt: "2026-11-17T10:00:00Z",
    });
  });

  test("the event and its context are frozen, and detached from the input", () => {
    const context = { step: "review" };
    const event = buildAuditEvent({ ...VALID, context });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.context)).toBe(true);
    context.step = "changed";
    expect(event.context).toEqual({ step: "review" });
  });
});

describe("context bounds", () => {
  test("a nested object value is refused", () => {
    const error = refusal("context", { nested: { sentinel: "sentinel-nested" } });
    expect(error.field).toBe("context");
    expect(error.message).not.toContain("sentinel");
    expect(error.message).not.toContain("nested");
  });

  test("an array value is refused", () => {
    const error = refusal("context", { list: ["sentinel-item"] });
    expect(error.field).toBe("context");
    expect(error.message).not.toContain("sentinel");
  });

  test("a non-finite number is refused", () => {
    expect(refusal("context", { ratio: Number.NaN }).field).toBe("context");
  });

  test("a context that is an array or null is refused", () => {
    expect(refusal("context", ["sentinel-item"]).field).toBe("context");
    expect(refusal("context", null).field).toBe("context");
  });

  test("a context of exactly 4096 serialized bytes is accepted", () => {
    const context = { k: "a".repeat(4096 - CONTEXT_ENVELOPE_BYTES) };
    expect(new TextEncoder().encode(JSON.stringify(context))).toHaveLength(4096);
    expect(buildAuditEvent({ ...VALID, context }).context).toEqual(context);
  });

  test("a context of 4097 serialized bytes is refused, naming the size only", () => {
    const error = refusal("context", { k: "a".repeat(4097 - CONTEXT_ENVELOPE_BYTES) });
    expect(error.field).toBe("context");
    expect(error.message).toContain("4097");
    expect(error.message).not.toContain("aaaa");
  });

  test("the bound counts UTF-8 bytes, not characters", () => {
    // 2044 two-byte characters: 4096 bytes. One more: 4098 bytes in 2053
    // characters, far below 4096 characters.
    const atLimit = { k: "é".repeat(2044) };
    expect(buildAuditEvent({ ...VALID, context: atLimit }).context).toEqual(atLimit);
    expect(refusal("context", { k: "é".repeat(2045) }).message).toContain("4098");
  });
});
