import { describe, expect, test } from "bun:test";
import { createDpiaScaffold, InvalidDpiaScaffoldError } from "./aida-template";

describe("createDpiaScaffold", () => {
  test("returns an unapproved, all-false assessment carrying the inputs verbatim", () => {
    const scaffold = createDpiaScaffold({
      id: "dpia-sessions-2026-07",
      product: "libre-ai/sessions",
      scope: "Collaborative session event log",
      date: "2026-07-23T00:00:00Z",
      version: "v1",
    });
    expect(scaffold).toEqual({
      id: "dpia-sessions-2026-07",
      product: "libre-ai/sessions",
      scope: "Collaborative session event log",
      date: "2026-07-23T00:00:00Z",
      version: "v1",
      automaticDecisionMaking: { yesNo: false },
      largeScaleProcessing: { yesNo: false },
      specialCategoryData: { yesNo: false },
      vulnerableSubjects: { yesNo: false },
      risks: [],
    });
    // Scaffold only (owner decision 2026-07-23): approval is a manual owner
    // act, never pre-filled.
    expect(Object.hasOwn(scaffold, "approvedBy")).toBe(false);
  });

  test("fails closed on blank inputs or a malformed date", () => {
    const valid = {
      id: "dpia-x",
      product: "libre-ai/x",
      scope: "s",
      date: "2026-07-23T00:00:00Z",
      version: "v1",
    };
    for (const override of [
      { id: " " },
      { product: "" },
      { scope: "" },
      { date: "today" },
      { version: "" },
    ]) {
      expect(() => createDpiaScaffold({ ...valid, ...override })).toThrow(InvalidDpiaScaffoldError);
    }
  });
});
