import { describe, expect, test } from "bun:test";

import { selectExpiredIds } from "./expired-selection";

const records = [
  { id: "rec_old", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "rec_recent", createdAt: "2026-07-01T00:00:00.000Z" },
];

describe("expired record selection", () => {
  test("a record past its retention is selected", () => {
    // rec_old is ~200 days old at now; 90-day retention expires it.
    const expired = selectExpiredIds(records, "2026-07-20T00:00:00.000Z", 90);
    expect(expired).toEqual(["rec_old"]);
  });

  test("a record within its retention is not selected", () => {
    const expired = selectExpiredIds(
      [{ id: "rec_recent", createdAt: "2026-07-01T00:00:00.000Z" }],
      "2026-07-20T00:00:00.000Z",
      90,
    );
    expect(expired).toEqual([]);
  });

  test("a record exactly at its retention boundary is selected", () => {
    const expired = selectExpiredIds(
      [{ id: "rec_edge", createdAt: "2026-04-21T00:00:00.000Z" }],
      "2026-07-20T00:00:00.000Z",
      90,
    );
    expect(expired).toEqual(["rec_edge"]);
  });

  test("a shorter retention schedules already-expired records immediately", () => {
    // DATA-LIFECYCLE.md: "A shorter value ... schedules already-expired
    // records immediately." rec_recent (19 days old) expires under a 7-day rule.
    const expired = selectExpiredIds(records, "2026-07-20T00:00:00.000Z", 7);
    expect(expired).toEqual(["rec_old", "rec_recent"]);
  });
});
