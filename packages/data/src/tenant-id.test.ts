import { describe, expect, test } from "bun:test";

import { assertTenantContextId, isPrivateTenantId, MalformedTenantIdError } from "./tenant-id";

const VALID = `ten_${"a1b2c3d4e5f6g7h8"}`; // 16 chars after the prefix

describe("tenant id format (contract ^ten_[a-z0-9]{16,64}$)", () => {
  test("accepts a well-formed private tenant id", () => {
    expect(isPrivateTenantId(VALID)).toBe(true);
  });

  test("rejects a too-short id", () => {
    expect(isPrivateTenantId("ten_short")).toBe(false);
  });

  test("rejects uppercase and non-alphanumeric characters", () => {
    expect(isPrivateTenantId("ten_A1B2C3D4E5F6G7H8")).toBe(false);
    expect(isPrivateTenantId("ten_a1b2c3d4e5f6g7h8 ")).toBe(false);
    expect(isPrivateTenantId("ten_a1b2-3d4e5f6g7h8")).toBe(false);
  });

  test("the public service tenant is not a private tenant", () => {
    expect(isPrivateTenantId("public")).toBe(false);
  });

  test("assertTenantContextId accepts a private tenant or the public service tenant", () => {
    expect(assertTenantContextId(VALID)).toBe(VALID);
    expect(assertTenantContextId("public")).toBe("public");
  });

  test("assertTenantContextId rejects a malformed id", () => {
    expect(() => assertTenantContextId("ten_short")).toThrow(MalformedTenantIdError);
    expect(() => assertTenantContextId("")).toThrow(MalformedTenantIdError);
  });
});
