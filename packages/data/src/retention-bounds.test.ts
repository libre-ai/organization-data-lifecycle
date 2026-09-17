import { describe, expect, test } from "bun:test";

import {
  AboveMaximumRetentionError,
  BelowMinimumRetentionError,
  NonPositiveRetentionError,
  NotConfigurableError,
  resolveConfiguredRetention,
} from "./retention-bounds";

const configurable = {
  id: "radar-normalized",
  mode: "configurable" as const,
  defaultRetention: "P90D",
  configurable: { minimum: "P7D", maximum: "P365D" },
};

const maximumOnly = {
  id: "missions",
  mode: "configurable" as const,
  defaultRetention: "P1Y",
  configurable: { maximum: "P6Y" },
};

const fixed = {
  id: "browser-session",
  mode: "fixed" as const,
  defaultRetention: "P1D",
};

describe("configured retention bounds", () => {
  test("accepts a value inside the accepted range", () => {
    expect(resolveConfiguredRetention(configurable, "P30D")).toBe("P30D");
  });

  test("accepts the exact minimum and maximum", () => {
    expect(resolveConfiguredRetention(configurable, "P7D")).toBe("P7D");
    expect(resolveConfiguredRetention(configurable, "P365D")).toBe("P365D");
  });

  test("refuses a value below the accepted minimum", () => {
    expect(() => resolveConfiguredRetention(configurable, "P6D")).toThrow(
      BelowMinimumRetentionError,
    );
  });

  test("refuses a value beyond the accepted maximum", () => {
    // DATA-LIFECYCLE.md: "values beyond the accepted maximum are refused".
    expect(() => resolveConfiguredRetention(configurable, "P366D")).toThrow(
      AboveMaximumRetentionError,
    );
  });

  test("a maximum-only rule accepts short values and refuses beyond the maximum", () => {
    expect(resolveConfiguredRetention(maximumOnly, "P30D")).toBe("P30D");
    expect(() => resolveConfiguredRetention(maximumOnly, "P7Y")).toThrow(
      AboveMaximumRetentionError,
    );
  });

  test("years and days compare across units", () => {
    // P1Y (365 d) is within [P7D, P365D] at the boundary.
    expect(resolveConfiguredRetention(configurable, "P1Y")).toBe("P1Y");
  });

  test("a fixed rule cannot be configured", () => {
    expect(() => resolveConfiguredRetention(fixed, "P2D")).toThrow(NotConfigurableError);
  });

  test("a composite year+day duration is refused (contract uses one component)", () => {
    // The machine policy uses P<n>D or P<n>Y, never both. P1Y365D must not
    // silently parse as 730 days.
    expect(() => resolveConfiguredRetention(configurable, "P1Y365D")).toThrow();
  });

  test("a zero or empty duration is refused", () => {
    expect(() => resolveConfiguredRetention(maximumOnly, "P0D")).toThrow(NonPositiveRetentionError);
    expect(() => resolveConfiguredRetention(maximumOnly, "P")).toThrow();
  });
});
