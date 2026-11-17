// Guarded status transitions of an erasure request (GDPR Art. 17) and its
// retraction window. Pure functions: no storage, no clock read, no audit hook.
// The product persists the returned request with an update conditional on
// `transition.from` (zero rows changed is a conflict) and writes its own audit
// row from the returned transition — erasure and audit stay per bounded
// context (README, hard rule).

import {
  type DataSubjectRequest,
  InvalidDataSubjectRequestError,
  type RequestStatus,
  validateDataSubjectRequest,
} from "./data-subject-request";

// The only admitted moves. `fulfilled` and `refused` are terminal; a failed
// erasure has no status of its own: the request stays `in-progress`, the
// product propagates the error and may retry. A withdrawal by the data subject
// during the retraction window is a move to `refused` with a product code.
export const ERASURE_REQUEST_TRANSITIONS: readonly (readonly [RequestStatus, RequestStatus])[] = [
  ["received", "acknowledged"],
  ["received", "refused"],
  ["acknowledged", "in-progress"],
  ["acknowledged", "refused"],
  ["in-progress", "fulfilled"],
];

export interface RequestTransition {
  readonly requestId: string;
  readonly from: RequestStatus;
  readonly to: RequestStatus;
  readonly at: string;
}

export type ErasureTransitionInput =
  | { to: "acknowledged" | "fulfilled"; at: string }
  | { to: "in-progress"; at: string; retractionDays: number }
  | { to: "refused"; at: string; refusalReason: string };

export class IllegalRequestTransitionError extends Error {
  // Request id and current status only: the subject digest, the tenant and
  // the requested target never enter the message.
  constructor(requestId: string, currentStatus: RequestStatus) {
    super(`illegal transition for request ${requestId} in status ${currentStatus}`);
    this.name = "IllegalRequestTransitionError";
  }
}

export class RetractionWindowOpenError extends Error {
  constructor(requestId: string, earliestErasureAt: string) {
    super(`retraction window still open for request ${requestId} until ${earliestErasureAt}`);
    this.name = "RetractionWindowOpenError";
  }
}

export class InvalidRetractionDelayError extends Error {
  constructor(defect: string) {
    super(`invalid retraction delay: ${defect}`);
    this.name = "InvalidRetractionDelayError";
  }
}

// Same RFC 3339 shape as data-subject-request.ts, which does not export it.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function instantOf(value: unknown, field: string): number {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    throw new InvalidDataSubjectRequestError(field);
  }
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) {
    throw new InvalidDataSubjectRequestError(field);
  }
  return instant;
}

/**
 * Earliest instant at which the erasure may start: `receivedAt` plus the
 * retraction delay. The delay has no default here — it is product
 * configuration, passed in as a whole number of days.
 */
export function computeEarliestErasureAt(receivedAt: string, retractionDays: number): string {
  const received = instantOf(receivedAt, "receivedAt");
  if (!Number.isInteger(retractionDays) || retractionDays < 0) {
    throw new InvalidRetractionDelayError("retractionDays must be a non-negative integer");
  }
  const earliest = new Date(received + retractionDays * DAY_MS);
  if (Number.isNaN(earliest.getTime())) {
    throw new InvalidRetractionDelayError("retractionDays is out of range");
  }
  return earliest.toISOString();
}

function isAdmitted(from: RequestStatus, to: unknown): boolean {
  return ERASURE_REQUEST_TRANSITIONS.some(
    ([admittedFrom, admittedTo]) => admittedFrom === from && admittedTo === to,
  );
}

/**
 * Moves an erasure request to `input.to` when the move is admitted, and
 * returns the new request with the transition performed. The input request is
 * never modified. `input.at` is the caller's instant; no clock is read.
 */
export function transitionErasureRequest(
  request: DataSubjectRequest,
  input: ErasureTransitionInput,
): { readonly request: DataSubjectRequest; readonly transition: RequestTransition } {
  const current = validateDataSubjectRequest(request);
  if (current.rightType !== "erasure") {
    throw new InvalidDataSubjectRequestError("rightType");
  }
  if (!isAdmitted(current.status, input.to)) {
    throw new IllegalRequestTransitionError(current.requestId, current.status);
  }
  const at = instantOf(input.at, "at");

  if (input.to === "in-progress") {
    const earliestErasureAt = computeEarliestErasureAt(current.receivedAt, input.retractionDays);
    // A window that reaches the Art. 12(3) deadline leaves no time to erase.
    if (new Date(earliestErasureAt).getTime() >= instantOf(current.deadline, "deadline")) {
      throw new InvalidRetractionDelayError("the window reaches the response deadline");
    }
    if (at < new Date(earliestErasureAt).getTime()) {
      throw new RetractionWindowOpenError(current.requestId, earliestErasureAt);
    }
  }

  // `current` carries no refusalReason here: only a refused request has one,
  // and refused is terminal, so it was rejected above. The final validation
  // refuses a move to `refused` whose reason is not an owner-prefixed code.
  const next: DataSubjectRequest =
    input.to === "refused"
      ? { ...current, status: input.to, refusalReason: input.refusalReason }
      : { ...current, status: input.to };

  return {
    request: validateDataSubjectRequest(next),
    transition: { requestId: current.requestId, from: current.status, to: input.to, at: input.at },
  };
}
