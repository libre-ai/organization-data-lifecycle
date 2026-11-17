import { describe, expect, test } from "bun:test";
import {
  type DataSubjectRequest,
  InvalidDataSubjectRequestError,
  REQUEST_STATUSES,
  type RequestStatus,
  validateDataSubjectRequest,
} from "./data-subject-request";
import {
  computeEarliestErasureAt,
  ERASURE_REQUEST_TRANSITIONS,
  type ErasureTransitionInput,
  IllegalRequestTransitionError,
  InvalidRetractionDelayError,
  RetractionWindowOpenError,
  transitionErasureRequest,
} from "./erasure-request-lifecycle";
import * as entry from "./index";

const REQUEST_ID = "dsr_0f4c2e7a9b1d4c8e";
const SUBJECT_DIGEST = "a".repeat(64);
const TENANT_ID = "ten_aaaaaaaaaaaaaaaa";
const RECEIVED_AT = "2026-07-23T10:00:00Z";
const REFUSAL_CODE = "sessions.rgpd.withdrawn_by_subject";
// Past any retraction window used below, before the 30-day deadline.
const LATE = "2026-08-10T10:00:00Z";

function requestIn(status: RequestStatus): DataSubjectRequest {
  const base = {
    requestId: REQUEST_ID,
    subjectDigest: SUBJECT_DIGEST,
    rightType: "erasure" as const,
    tenantId: TENANT_ID,
    receivedAt: RECEIVED_AT,
    submittedVia: "api" as const,
    status,
    deadline: "2026-08-22T10:00:00Z",
  };
  return status === "refused" ? { ...base, refusalReason: REFUSAL_CODE } : base;
}

// A well-formed input for every target, so that only the pair decides. The
// cast admits `received`, which the input type excludes but an untyped caller
// can still send.
function inputTo(to: RequestStatus): ErasureTransitionInput {
  if (to === "in-progress") return { to, at: LATE, retractionDays: 7 };
  if (to === "refused") return { to, at: LATE, refusalReason: REFUSAL_CODE };
  return { to, at: LATE } as ErasureTransitionInput;
}

function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a throw");
}

describe("admitted transitions", () => {
  test("the list is the five pairs of the lifecycle", () => {
    expect(ERASURE_REQUEST_TRANSITIONS).toEqual([
      ["received", "acknowledged"],
      ["received", "refused"],
      ["acknowledged", "in-progress"],
      ["acknowledged", "refused"],
      ["in-progress", "fulfilled"],
    ]);
  });

  test.each(
    ERASURE_REQUEST_TRANSITIONS.map(([from, to]) => ({ from, to })),
  )("$from -> $to returns a valid request and the transition performed", ({ from, to }) => {
    const result = transitionErasureRequest(requestIn(from), inputTo(to));
    expect(result.request.status).toBe(to);
    expect(validateDataSubjectRequest(result.request)).toEqual(result.request);
    expect(result.transition).toEqual({ requestId: REQUEST_ID, from, to, at: LATE });
  });

  test("every pair outside the list is refused, a status to itself included", () => {
    const all = REQUEST_STATUSES.flatMap((from) => REQUEST_STATUSES.map((to) => ({ from, to })));
    const illegal = all.filter(
      ({ from, to }) => !ERASURE_REQUEST_TRANSITIONS.some(([f, t]) => f === from && t === to),
    );
    expect(all).toHaveLength(25);
    expect(illegal).toHaveLength(20);
    for (const { from, to } of illegal) {
      expect(() => transitionErasureRequest(requestIn(from), inputTo(to))).toThrow(
        IllegalRequestTransitionError,
      );
    }
  });
});

describe("IllegalRequestTransitionError message", () => {
  test("acknowledging twice names the request and its current status", () => {
    const once = transitionErasureRequest(requestIn("received"), inputTo("acknowledged"));
    const error = caught(() => transitionErasureRequest(once.request, inputTo("acknowledged")));
    expect(error).toBeInstanceOf(IllegalRequestTransitionError);
    expect(error.message).toContain(REQUEST_ID);
    expect(error.message).toContain("acknowledged");
  });

  test("starting a received request names received", () => {
    const error = caught(() =>
      transitionErasureRequest(requestIn("received"), inputTo("in-progress")),
    );
    expect(error).toBeInstanceOf(IllegalRequestTransitionError);
    expect(error.message).toContain("received");
  });

  test("refusing a fulfilled request names fulfilled", () => {
    const error = caught(() =>
      transitionErasureRequest(requestIn("fulfilled"), inputTo("refused")),
    );
    expect(error).toBeInstanceOf(IllegalRequestTransitionError);
    expect(error.message).toContain("fulfilled");
  });

  test("carries neither the subject digest nor the tenant", () => {
    const error = caught(() =>
      transitionErasureRequest(requestIn("fulfilled"), inputTo("acknowledged")),
    );
    expect(error.message).not.toContain(SUBJECT_DIGEST);
    expect(error.message).not.toContain(TENANT_ID);
  });
});

describe("refusal", () => {
  test("a free-text reason is refused, and never echoed", () => {
    const freeText = "the person changed their mind";
    const error = caught(() =>
      transitionErasureRequest(requestIn("received"), {
        to: "refused",
        at: LATE,
        refusalReason: freeText,
      }),
    );
    expect(error).toBeInstanceOf(InvalidDataSubjectRequestError);
    expect(error.message).not.toContain(freeText);
  });

  test("an owner-prefixed code is carried by the returned request", () => {
    const result = transitionErasureRequest(requestIn("received"), {
      to: "refused",
      at: LATE,
      refusalReason: REFUSAL_CODE,
    });
    expect(result.request.refusalReason).toBe(REFUSAL_CODE);
  });
});

describe("requests that are not erasure requests", () => {
  test.each(
    REQUEST_STATUSES.flatMap((from) => REQUEST_STATUSES.map((to) => ({ from, to }))),
  )("an access request is refused for $from -> $to", ({ from, to }) => {
    const access: DataSubjectRequest = { ...requestIn(from), rightType: "access" };
    const error = caught(() => transitionErasureRequest(access, inputTo(to)));
    expect(error).toBeInstanceOf(InvalidDataSubjectRequestError);
    expect(error.message).toContain("rightType");
  });

  test("a malformed request is refused by the existing validator", () => {
    const malformed: DataSubjectRequest = { ...requestIn("received"), subjectDigest: "plain" };
    expect(() => transitionErasureRequest(malformed, inputTo("acknowledged"))).toThrow(
      InvalidDataSubjectRequestError,
    );
  });

  test("an instant without a zone designator is refused", () => {
    expect(() =>
      transitionErasureRequest(requestIn("received"), {
        to: "acknowledged",
        at: "2026-08-10T10:00:00",
      }),
    ).toThrow(InvalidDataSubjectRequestError);
  });
});

describe("retraction window", () => {
  const acknowledged = requestIn("acknowledged");

  test("seven days: closed one second before, open at the exact instant", () => {
    expect(() =>
      transitionErasureRequest(acknowledged, {
        to: "in-progress",
        at: "2026-07-30T09:59:59Z",
        retractionDays: 7,
      }),
    ).toThrow(RetractionWindowOpenError);
    const result = transitionErasureRequest(acknowledged, {
      to: "in-progress",
      at: "2026-07-30T10:00:00Z",
      retractionDays: 7,
    });
    expect(result.request.status).toBe("in-progress");
  });

  test("zero days: open from receivedAt", () => {
    const result = transitionErasureRequest(acknowledged, {
      to: "in-progress",
      at: RECEIVED_AT,
      retractionDays: 0,
    });
    expect(result.request.status).toBe("in-progress");
  });

  test("a withdrawal during the window is terminal", () => {
    const withdrawn = transitionErasureRequest(acknowledged, {
      to: "refused",
      at: "2026-07-25T10:00:00Z",
      refusalReason: REFUSAL_CODE,
    });
    expect(withdrawn.request.status).toBe("refused");
    expect(() =>
      transitionErasureRequest(withdrawn.request, {
        to: "in-progress",
        at: LATE,
        retractionDays: 7,
      }),
    ).toThrow(IllegalRequestTransitionError);
  });

  test.each([
    { label: "negative", retractionDays: -1 },
    { label: "fractional", retractionDays: 1.5 },
    { label: "not a number", retractionDays: Number.NaN },
    { label: "reaching the deadline", retractionDays: 30 },
    { label: "past the deadline", retractionDays: 45 },
  ])("a $label delay is refused", ({ retractionDays }) => {
    expect(() =>
      transitionErasureRequest(acknowledged, {
        to: "in-progress",
        at: "2026-12-01T10:00:00Z",
        retractionDays,
      }),
    ).toThrow(InvalidRetractionDelayError);
  });

  test("the last delay that leaves time before the deadline passes", () => {
    const result = transitionErasureRequest(acknowledged, {
      to: "in-progress",
      at: "2026-08-21T10:00:00Z",
      retractionDays: 29,
    });
    expect(result.request.status).toBe("in-progress");
  });
});

describe("computeEarliestErasureAt", () => {
  test("adds whole days in UTC, in the ISO form of the response deadline", () => {
    expect(computeEarliestErasureAt(RECEIVED_AT, 7)).toBe("2026-07-30T10:00:00.000Z");
    expect(computeEarliestErasureAt(RECEIVED_AT, 0)).toBe("2026-07-23T10:00:00.000Z");
  });

  test("rejects a receivedAt without a zone designator", () => {
    expect(() => computeEarliestErasureAt("2026-07-23T10:00:00", 7)).toThrow(
      InvalidDataSubjectRequestError,
    );
    expect(() => computeEarliestErasureAt("23/07/2026", 7)).toThrow(InvalidDataSubjectRequestError);
  });

  test("rejects a negative, fractional or unrepresentable delay", () => {
    expect(() => computeEarliestErasureAt(RECEIVED_AT, -1)).toThrow(InvalidRetractionDelayError);
    expect(() => computeEarliestErasureAt(RECEIVED_AT, 0.5)).toThrow(InvalidRetractionDelayError);
    expect(() => computeEarliestErasureAt(RECEIVED_AT, Number.MAX_SAFE_INTEGER)).toThrow(
      InvalidRetractionDelayError,
    );
  });
});

describe("purity", () => {
  test("a frozen request is left untouched", () => {
    const frozen = Object.freeze(requestIn("received"));
    const result = transitionErasureRequest(frozen, inputTo("acknowledged"));
    expect(frozen.status).toBe("received");
    expect(result.request).not.toBe(frozen);
  });
});

describe("package entry", () => {
  test("exposes the lifecycle function, the list and the three errors", () => {
    const exposed: Record<string, unknown> = entry;
    expect(exposed.transitionErasureRequest).toBe(transitionErasureRequest);
    expect(exposed.computeEarliestErasureAt).toBe(computeEarliestErasureAt);
    expect(exposed.ERASURE_REQUEST_TRANSITIONS).toBe(ERASURE_REQUEST_TRANSITIONS);
    expect(exposed.IllegalRequestTransitionError).toBe(IllegalRequestTransitionError);
    expect(exposed.RetractionWindowOpenError).toBe(RetractionWindowOpenError);
    expect(exposed.InvalidRetractionDelayError).toBe(InvalidRetractionDelayError);
  });
});
